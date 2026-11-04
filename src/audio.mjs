import { randomUUID } from 'node:crypto';
import { AppError } from './store.mjs';

export const audioKinds = ['bgm', 'voice', 'sfx', 'other'];
export const audioTypes = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac' };
const DAY = 86400000, MAX_REGIONS = 20;
const now = () => new Date().toISOString();
function text(value, limit, field, required = false) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw new AppError(400, `${field} 格式不正确、为空或过长`);
  return required ? value.trim() : value;
}
function ms(value, field, { nullable = false, min = 0 } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < min || value > DAY) throw new AppError(400, `${field} 必须是 0–24 小时内的整数毫秒`);
  return value;
}
export function openAudio(store) {
  const db = store.db;
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function track(id) {
    const row = db.prepare('SELECT * FROM audio_tracks WHERE id=?').get(id);
    if (!row) throw new AppError(404, '音轨不存在'); return row;
  }
  function clip(id) {
    const row = db.prepare('SELECT * FROM audio_clips WHERE id=?').get(id);
    if (!row) throw new AppError(404, '音频片段不存在'); return row;
  }
  function projectOf(clipRow) { return track(clipRow.track_id).project_id; }
  function detail(projectId) {
    store.project(projectId);
    return {
      project_id: projectId,
      tracks: db.prepare('SELECT * FROM audio_tracks WHERE project_id=? ORDER BY position,id').all(projectId).map(row => ({
        ...row, muted: Boolean(row.muted),
        clips: db.prepare('SELECT * FROM audio_clips WHERE track_id=? ORDER BY offset_ms,id').all(row.id).map(item => ({
          ...item,
          versions: db.prepare(`SELECT v.*,m.filename,m.mime,m.bytes FROM audio_versions v JOIN media m ON m.id=v.media_id
            WHERE v.clip_id=? ORDER BY v.number DESC`).all(item.id),
          regions: db.prepare('SELECT * FROM audio_regions WHERE clip_id=? ORDER BY position,id').all(item.id)
        }))
      }))
    };
  }
  function touch(clipId) { db.prepare('UPDATE audio_clips SET revision=revision+1,updated_at=? WHERE id=?').run(now(), clipId); }
  function createTrack(projectId, payload) {
    store.project(projectId);
    const kind = payload.kind ?? 'bgm';
    if (!audioKinds.includes(kind)) throw new AppError(400, '音轨类型应为 bgm / voice / sfx / other');
    const title = text(payload.title ?? '', 200, '音轨名称', true);
    const position = db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS next FROM audio_tracks WHERE project_id=?').get(projectId).next;
    db.prepare('INSERT INTO audio_tracks(id,project_id,title,kind,position,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), projectId, title, kind, position, now());
    return detail(projectId);
  }
  function updateTrack(id, patch) {
    return transaction(() => {
      const row = track(id); store.expected(row, patch.revision);
      if (Object.keys(patch).some(key => !['revision', 'title', 'kind', 'muted', 'gain_db'].includes(key))) throw new AppError(400, '不支持的音轨字段');
      const next = { ...row, ...patch, muted: patch.muted ?? Boolean(row.muted) };
      next.title = text(next.title, 200, '音轨名称', true);
      if (!audioKinds.includes(next.kind) || typeof next.muted !== 'boolean' || typeof next.gain_db !== 'number' || !(next.gain_db >= -60 && next.gain_db <= 12)) throw new AppError(400, '音轨类型、静音或音量（-60 到 +12 dB）不正确');
      db.prepare('UPDATE audio_tracks SET title=?,kind=?,muted=?,gain_db=?,revision=revision+1 WHERE id=?').run(next.title, next.kind, Number(next.muted), next.gain_db, id);
      return detail(row.project_id);
    });
  }
  function removeClipRows(clipId) {
    db.prepare('DELETE FROM audio_regions WHERE clip_id=?').run(clipId);
    db.prepare('DELETE FROM audio_versions WHERE clip_id=?').run(clipId);
    db.prepare('DELETE FROM audio_clips WHERE id=?').run(clipId);
  }
  // Deleting removes timeline rows only; media files stay in the append-only store and backups.
  function deleteTrack(id, revision) {
    return transaction(() => {
      const row = track(id); store.expected(row, revision);
      for (const item of db.prepare('SELECT id FROM audio_clips WHERE track_id=?').all(id)) removeClipRows(item.id);
      db.prepare('DELETE FROM audio_tracks WHERE id=?').run(id);
      return detail(row.project_id);
    });
  }
  function insertVersion(clipId, mediaId, note = '') {
    const number = db.prepare('SELECT COALESCE(MAX(number),0)+1 AS next FROM audio_versions WHERE clip_id=?').get(clipId).next;
    const id = randomUUID();
    db.prepare('INSERT INTO audio_versions(id,clip_id,number,media_id,note,created_at) VALUES(?,?,?,?,?,?)').run(id, clipId, number, mediaId, text(note, 5000, '版本说明'), now());
    db.prepare('UPDATE audio_clips SET active_version_id=?,revision=revision+1,updated_at=? WHERE id=?').run(id, now(), clipId);
    return id;
  }
  // media: a freshly uploaded file (inserted here) or { existing: media_id } from the asset library.
  function addClip(trackId, payload, media) {
    return transaction(() => {
      const row = track(trackId);
      const offset = ms(payload.offset_ms ?? 0, '开始位置');
      let mediaId, filename;
      if (media) {
        db.prepare('INSERT INTO media VALUES(?,?,?,?,?,?)').run(media.id, media.filename, media.stored_name, media.mime, media.bytes, media.sha256);
        mediaId = media.id; filename = media.filename;
      } else {
        const asset = db.prepare('SELECT a.title,m.id,m.mime,m.filename FROM library_assets a JOIN media m ON m.id=a.media_id WHERE a.id=?').get(payload.asset_id);
        if (!asset) throw new AppError(404, '素材不存在');
        if (!asset.mime.startsWith('audio/')) throw new AppError(400, '只有音频素材可以放上音轨');
        mediaId = asset.id; filename = asset.title;
      }
      const title = text(payload.title || filename.replace(/\.[^.]+$/, '') || '音频', 200, '片段名称', true);
      const id = randomUUID(), time = now();
      db.prepare('INSERT INTO audio_clips(id,track_id,title,offset_ms,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, trackId, title, offset, time, time);
      insertVersion(id, mediaId, payload.note ?? '');
      return { clip_id: id, ...detail(row.project_id) };
    });
  }
  function updateClip(id, patch) {
    return transaction(() => {
      const row = clip(id); store.expected(row, patch.revision);
      if (Object.keys(patch).some(key => !['revision', 'title', 'offset_ms', 'in_ms', 'out_ms', 'notes', 'active_version_id', 'track_id'].includes(key))) throw new AppError(400, '不支持的音频片段字段');
      const next = { ...row, ...patch };
      next.title = text(next.title, 200, '片段名称', true); text(next.notes, 50000, '修改要求');
      ms(next.offset_ms, '开始位置'); ms(next.in_ms, '入点'); ms(next.out_ms, '出点', { nullable: true });
      if (next.out_ms !== null && next.out_ms - next.in_ms < 100) throw new AppError(400, '出点须比入点晚至少 0.1 秒');
      if (!db.prepare('SELECT id FROM audio_versions WHERE id=? AND clip_id=?').get(next.active_version_id, id)) throw new AppError(400, '采用版本不属于这个音频片段');
      const target = track(next.track_id);
      if (target.project_id !== projectOf(row)) throw new AppError(400, '只能移动到同一项目的音轨');
      db.prepare('UPDATE audio_clips SET title=?,offset_ms=?,in_ms=?,out_ms=?,notes=?,active_version_id=?,track_id=?,revision=revision+1,updated_at=? WHERE id=?')
        .run(next.title, next.offset_ms, next.in_ms, next.out_ms, next.notes, next.active_version_id, next.track_id, now(), id);
      return detail(target.project_id);
    });
  }
  function deleteClip(id, revision) {
    return transaction(() => {
      const row = clip(id); store.expected(row, revision);
      const projectId = projectOf(row); removeClipRows(id);
      return detail(projectId);
    });
  }
  function addVersion(clipId, revision, media, note) {
    return transaction(() => {
      const row = clip(clipId); store.expected(row, revision);
      db.prepare('INSERT INTO media VALUES(?,?,?,?,?,?)').run(media.id, media.filename, media.stored_name, media.mime, media.bytes, media.sha256);
      const versionId = insertVersion(clipId, media.id, note ?? '');
      return { version_id: versionId, ...detail(projectOf(row)) };
    });
  }
  // The browser reports decoded duration once; it is informational and never overwrites a known value.
  function reportDuration(versionId, duration) {
    ms(duration, '时长', { min: 1 });
    const row = db.prepare('SELECT * FROM audio_versions WHERE id=?').get(versionId);
    if (!row) throw new AppError(404, '音频版本不存在');
    if (row.duration_ms == null) db.prepare('UPDATE audio_versions SET duration_ms=? WHERE id=?').run(duration, versionId);
    return { id: versionId, duration_ms: row.duration_ms ?? duration };
  }
  function replaceRegions(clipId, payload) {
    return transaction(() => {
      const row = clip(clipId); store.expected(row, payload.revision);
      if (!Array.isArray(payload.regions) || payload.regions.length > MAX_REGIONS) throw new AppError(400, `每个音频片段最多 ${MAX_REGIONS} 段框选`);
      const rows = payload.regions.map(item => {
        const start = ms(item?.start_ms, '框选开始'), end = ms(item?.end_ms, '框选结束');
        if (end - start < 100) throw new AppError(400, '音频框选至少 0.1 秒');
        return { start, end, note: text(item.note ?? '', 5000, '框选说明') };
      });
      db.prepare('DELETE FROM audio_regions WHERE clip_id=?').run(clipId);
      const insert = db.prepare('INSERT INTO audio_regions VALUES(?,?,?,?,?,?,?)');
      rows.forEach((item, index) => insert.run(randomUUID(), clipId, index, item.start, item.end, item.note, now()));
      touch(clipId);
      return detail(projectOf(row));
    });
  }
  return { detail, track, clip, createTrack, updateTrack, deleteTrack, addClip, updateClip, deleteClip, addVersion, reportDuration, replaceRegions };
}
