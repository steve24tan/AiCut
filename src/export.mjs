import { join } from 'node:path';
import { AppError } from './store.mjs';

// Timeline manifest for finishing editors (scripts/export_jianying.py turns it into a 剪映 draft).
// The browser supplies each shot's on-timeline duration because it has probed the media;
// everything else (paths, ranges, audio placement, dialogue) comes from the database.
export function buildManifest(store, audio, mediaDir, projectId, payload) {
  const project = store.detail(projectId), durations = payload?.shot_durations;
  if (!durations || typeof durations !== 'object') throw new AppError(400, '缺少每段时长');
  const media = id => { const row = store.media(id); return row ? join(mediaDir, row.stored_name) : null; };
  let at = 0;
  const video = [], subtitles = [];
  for (const [index, shot] of project.shots.entries()) {
    const duration = durations[shot.id];
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 86400000) throw new AppError(400, `片段 ${index + 1} 的时长不正确，请等时间线读完视频长度再导出`);
    const take = shot.takes.find(t => t.id === shot.active_take_id);
    const kind = !take?.media_id ? 'empty' : take.mime.startsWith('video/') ? 'video' : 'image';
    video.push({ number: index + 1, title: shot.title, kind, path: take?.media_id ? media(take.media_id) : null, timeline_start_ms: at, duration_ms: duration, source_start_ms: kind === 'video' ? take.start_ms ?? 0 : null });
    // Lines share the shot's time evenly; the editor can retime them.
    const lines = shot.lines.filter(line => line.text.trim());
    lines.forEach((line, n) => {
      const start = at + Math.round(duration * n / lines.length), end = at + Math.round(duration * (n + 1) / lines.length);
      subtitles.push({ start_ms: start, duration_ms: Math.max(1, end - start), text: line.text, character: line.character });
    });
    at += duration;
  }
  const tracks = audio.detail(projectId).tracks.map(track => ({
    title: track.title, kind: track.kind, muted: track.muted, gain_db: track.gain_db,
    clips: track.clips.map(clip => {
      const version = clip.versions.find(v => v.id === clip.active_version_id);
      const end = clip.out_ms ?? version?.duration_ms;
      if (end == null) throw new AppError(400, `音频「${clip.title}」还没有读出长度，请等波形显示后再导出`);
      return { title: clip.title, path: media(version.media_id), version: version.number, timeline_start_ms: clip.offset_ms, source_start_ms: clip.in_ms, duration_ms: Math.max(1, end - clip.in_ms) };
    })
  }));
  return { format: 'aicut-timeline', version: 1, project: { id: project.id, title: project.title }, exported_at: new Date().toISOString(), duration_ms: at, video, audio: tracks, subtitles };
}
