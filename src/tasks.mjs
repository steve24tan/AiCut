import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AppError } from './store.mjs';

// Audio work handed to an agent (herdr pane or any CLI the user points at it). AiCut does not
// process audio itself: the snapshot says what to do and where the local files are, and the agent
// returns results by importing versions/clips through cli.mjs, then completing the task.
export const taskKinds = { process: '处理音频', mix: '混音', voice: '配音', music: '生成音乐' };
const now = () => new Date().toISOString();
function text(value, limit, field) {
  if (typeof value !== 'string' || value.length > limit) throw new AppError(400, `${field} 格式不正确或过长`);
  return value;
}
export function openTasks(store, audio, mediaDir) {
  const db = store.db;
  const unpack = row => row && ({ ...row, snapshot: JSON.parse(row.snapshot), result: row.result ? JSON.parse(row.result) : null });
  function get(id) {
    const row = unpack(db.prepare('SELECT * FROM tasks WHERE id=?').get(id));
    if (!row) throw new AppError(404, '任务不存在'); return row;
  }
  function clipSnapshot(clipId) {
    const clip = audio.clip(clipId), track = audio.track(clip.track_id);
    const versions = db.prepare(`SELECT v.*,m.filename,m.mime,m.stored_name FROM audio_versions v JOIN media m ON m.id=v.media_id WHERE v.clip_id=? ORDER BY v.number DESC`).all(clipId)
      .map(v => ({ id: v.id, number: v.number, filename: v.filename, mime: v.mime, duration_ms: v.duration_ms, note: v.note, path: join(mediaDir, v.stored_name), active: v.id === clip.active_version_id }));
    return {
      id: clip.id, title: clip.title, track: { id: track.id, title: track.title, kind: track.kind },
      timeline_offset_ms: clip.offset_ms, source_in_ms: clip.in_ms, source_out_ms: clip.out_ms, notes: clip.notes,
      regions: db.prepare('SELECT start_ms,end_ms,note FROM audio_regions WHERE clip_id=? ORDER BY position').all(clipId),
      active_version: versions.find(v => v.active), versions
    };
  }
  function track(projectId, id, kind) {
    if (id == null) return null;
    const row = audio.track(id);
    if (row.project_id !== projectId) throw new AppError(400, '音轨不属于这个项目');
    if (kind && row.kind !== kind) throw new AppError(400, `请选择${kind === 'voice' ? '配音' : 'BGM'}音轨`);
    return { id: row.id, title: row.title, kind: row.kind };
  }
  function build(project, payload) {
    const instruction = text(payload.instruction ?? '', 5000, '任务说明');
    const base = { kind: payload.kind, project: { id: project.id, title: project.title }, instruction };
    if (payload.kind === 'process') {
      const clip = clipSnapshot(payload.clip_id);
      if (audio.track(clip.track.id).project_id !== project.id) throw new AppError(400, '音频片段不属于这个项目');
      return { title: `${taskKinds.process} · ${clip.title}`, snapshot: { ...base, clip, deliver: `node cli.mjs audio version ${clip.id} OUTPUT_FILE --note "what changed"` } };
    }
    if (payload.kind === 'mix') {
      if (!Array.isArray(payload.clip_ids) || payload.clip_ids.length < 2 || payload.clip_ids.length > 6 || new Set(payload.clip_ids).size !== payload.clip_ids.length) throw new AppError(400, '混音需要选择 2–6 段不同的音频');
      const clips = payload.clip_ids.map(clipSnapshot);
      if (clips.some(c => audio.track(c.track.id).project_id !== project.id)) throw new AppError(400, '音频片段不属于这个项目');
      const target = track(project.id, payload.track_id ?? clips[0].track.id);
      return { title: `${taskKinds.mix} · ${clips.map(c => c.title).join(' + ')}`.slice(0, 200), snapshot: { ...base, clips, output_track: target, deliver: `node cli.mjs audio add ${target.id} OUTPUT_FILE --offset SECONDS --title "mix"` } };
    }
    if (payload.kind === 'voice') {
      const shot = store.shot(payload.shot_id);
      if (shot.project_id !== project.id) throw new AppError(400, '片段不属于这个项目');
      const lines = store.lines(shot.id).map(({ character, provider, voice_id, voice_notes, text, delivery }) => ({ character, provider, voice_id, voice_notes, text, delivery }));
      if (!lines.some(line => line.text.trim())) throw new AppError(400, '这一段还没有台词');
      const offset = payload.timeline_offset_ms ?? null;
      if (offset !== null && (!Number.isSafeInteger(offset) || offset < 0 || offset > 86400000)) throw new AppError(400, '片段在时间线上的位置不正确');
      const target = track(project.id, payload.track_id, 'voice');
      if (!target) throw new AppError(400, '请先建立一条配音音轨');
      const number = store.detail(project.id).shots.findIndex(s => s.id === shot.id) + 1;
      return { title: `${taskKinds.voice} · ${String(number).padStart(2, '0')} ${shot.title}`, snapshot: { ...base, shot: { id: shot.id, number, title: shot.title, timeline_offset_ms: offset }, lines, output_track: target, deliver: `node cli.mjs audio add ${target.id} OUTPUT_FILE --offset SECONDS --title "角色 · 台词"` } };
    }
    if (payload.kind === 'music') {
      const target = track(project.id, payload.track_id, 'bgm');
      if (!target) throw new AppError(400, '请先建立一条 BGM 音轨');
      const duration = payload.duration_ms, offset = payload.offset_ms ?? 0;
      if (!Number.isSafeInteger(duration) || duration < 3000 || duration > 600000) throw new AppError(400, '音乐长度应为 3 秒到 10 分钟');
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 86400000) throw new AppError(400, '开始位置不正确');
      if (!instruction.trim()) throw new AppError(400, '请描述想要的音乐');
      return { title: `${taskKinds.music} · ${instruction.trim().slice(0, 40)}`, snapshot: { ...base, duration_ms: duration, timeline_offset_ms: offset, output_track: target, deliver: `node cli.mjs audio add ${target.id} OUTPUT_FILE --offset ${offset / 1000} --title "BGM"` } };
    }
    throw new AppError(400, '任务类型应为 process / mix / voice / music');
  }
  function enqueue(projectId, payload, target) {
    const project = store.project(projectId);
    const { title, snapshot } = build(project, payload);
    const id = randomUUID(), time = now();
    db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, projectId, payload.kind, target, 'queued', title.slice(0, 200), JSON.stringify(snapshot), null, null, time, time);
    return get(id);
  }
  function move(id, from, to, extra = {}) {
    const fields = Object.keys(extra).map(key => `${key}=?`).join(',');
    if (!db.prepare(`UPDATE tasks SET status=?,updated_at=?${fields ? ',' + fields : ''} WHERE id=? AND status IN (${from.map(() => '?').join(',')})`).run(to, now(), ...Object.values(extra), id, ...from).changes) {
      get(id); throw new AppError(409, `任务当前状态不能改为「${to}」`);
    }
    return get(id);
  }
  return {
    get, enqueue,
    claim: id => move(id, ['queued'], 'running'),
    complete(id, result) {
      if (!result || typeof result.summary !== 'string' || !result.summary.trim() || result.summary.length > 10000) throw new AppError(400, '完成任务需要 summary（1–10000 字符）');
      const outputs = result.outputs ?? [];
      if (!Array.isArray(outputs) || outputs.length > 50 || outputs.some(item => !item || typeof item !== 'object')) throw new AppError(400, 'outputs 应为对象数组');
      return move(id, ['running'], 'completed', { result: JSON.stringify({ summary: result.summary, outputs }), error: null });
    },
    fail: (id, message) => move(id, ['queued', 'running'], 'failed', { error: text(String(message || '未说明原因'), 5000, '失败原因') }),
    cancel: id => move(id, ['queued', 'running'], 'cancelled'),
    list: projectId => {
      if (projectId) store.project(projectId);
      return db.prepare(`SELECT * FROM tasks ${projectId ? 'WHERE project_id=?' : ''} ORDER BY created_at DESC,id DESC LIMIT 200`).all(...(projectId ? [projectId] : []))
        .map(unpack).map(({ snapshot, ...row }) => ({ ...row, clip_ids: snapshot.clip ? [snapshot.clip.id] : (snapshot.clips || []).map(c => c.id), shot_id: snapshot.shot?.id ?? null }));
    }
  };
}
