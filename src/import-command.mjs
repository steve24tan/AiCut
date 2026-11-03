import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, extname, resolve } from 'node:path';

const videos = ['.mp4', '.webm', '.mov'];
const images = ['.png', '.jpg', '.jpeg', '.webp'];
export function options(args) {
  const values = {};
  for (let n = 0; n < args.length; n += 2) {
    if (!['--segments', '--cuts', '--duration', '--title'].includes(args[n]) || args[n + 1] === undefined || values[args[n]] !== undefined) throw new Error('Invalid or duplicate import/split option: ' + args[n]);
    values[args[n]] = args[n + 1];
  }
  if (values['--segments'] !== undefined && values['--cuts'] !== undefined) throw new Error('Choose --segments or --cuts, not both');
  return values;
}
export async function probeDuration(input) {
  const binary = process.env.SHOT_FFPROBE_BIN || 'ffprobe';
  if (/\.(cmd|bat|ps1)$/i.test(binary)) throw new Error('ffprobe must be a native executable, not a shell wrapper');
  try {
    const { stdout } = await promisify(execFile)(binary, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration:format=duration', '-of', 'json', input], { windowsHide: true, shell: false, timeout: 20000, maxBuffer: 1024 * 1024 });
    const info = JSON.parse(stdout);
    if (!info.streams?.length) throw new Error('No video stream');
    const seconds = [info.streams[0].duration, info.format?.duration].map(Number).find(value => Number.isFinite(value) && value > 0);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Unknown duration');
    return Math.round(seconds * 1000);
  } catch { throw new Error('Cannot read video duration with ffprobe. Install ffprobe or provide the known duration in seconds with --duration. No duration was guessed.'); }
}
export function splitPayload(opts, duration, start = 0, end = duration) {
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 86400000) throw new Error('Duration must be positive and no longer than 24 hours');
  let cuts;
  if (opts['--segments'] !== undefined) {
    const count = Number(opts['--segments']);
    if (!Number.isInteger(count) || count < 2 || count > 100) throw new Error('--segments must be 2–100');
    cuts = Array.from({ length: count - 1 }, (_, i) => Math.round(start + (end - start) * (i + 1) / count));
  } else if (opts['--cuts'] !== undefined) cuts = opts['--cuts'].split(',').map(value => value.trim() ? Math.round(Number(value) * 1000) : NaN);
  else throw new Error('Provide --segments COUNT or --cuts SECONDS,SECONDS');
  const bounds = [start, ...cuts, end];
  if (!cuts.length || cuts.length > 99 || bounds.some((value, i) => !Number.isSafeInteger(value) || value < 0 || value > duration || (i && value - bounds[i - 1] < 100))) throw new Error('Cuts must be increasing, inside the source range and at least 0.1 seconds apart');
  return { duration_ms: duration, cuts_ms: cuts };
}
function explicitDuration(opts) {
  const seconds = Number(opts['--duration']);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--duration must be positive seconds');
  return Math.round(seconds * 1000);
}
export async function importFile({ projectId, file, opts, call, base }) {
  const path = resolve(file), info = await stat(path), ext = extname(path).toLowerCase();
  if (!info.isFile() || !info.size || info.size > 1024 ** 3) throw new Error('Import requires a nonempty file no larger than 1 GB');
  if (![...videos, ...images].includes(ext)) throw new Error('Unsupported file extension');
  const name = (opts['--title'] || basename(path, extname(path))).trim();
  if (!name || name.length > 200) throw new Error('Title must contain 1–200 characters');
  const shouldSplit = opts['--segments'] !== undefined || opts['--cuts'] !== undefined;
  let split;
  if (shouldSplit) {
    if (!videos.includes(ext)) throw new Error('Only videos can be split');
    const duration = opts['--duration'] === undefined ? await probeDuration(path) : explicitDuration(opts);
    split = splitPayload(opts, duration); // Validate before any server mutation.
  } else if (opts['--duration'] !== undefined) throw new Error('--duration requires --segments or --cuts');
  await call(`/api/projects/${encodeURIComponent(projectId)}`);
  const shot = await call(`/api/projects/${encodeURIComponent(projectId)}/shots`, 'POST', { title: name });
  let imported;
  try {
    const response = await fetch(new URL(`/api/shots/${shot.id}/takes?filename=${encodeURIComponent(basename(path))}`, base), {
      method: 'POST', headers: { 'X-Workbench': '1', 'X-Shot-Revision': String(shot.revision), 'Content-Type': 'application/octet-stream', 'Content-Length': String(info.size) }, body: createReadStream(path), duplex: 'half'
    });
    imported = await response.json(); if (!response.ok) throw new Error(imported.error || `HTTP ${response.status}`);
  } catch (error) { throw new Error(`Import failed. Empty shot ${shot.id} was retained for inspection; do not blindly repeat the import. ${error.message}`); }
  if (!split) return { project_id: projectId, shot_id: shot.id, take_id: imported.id, segments: 1 };
  try {
    const result = await call(`/api/shots/${shot.id}/split`, 'POST', { revision: imported.shot.revision, ...split });
    return { project_id: projectId, shot_id: shot.id, segments: split.cuts_ms.length + 1, project: result };
  } catch (error) { throw new Error(`Media imported as shot ${shot.id}, but splitting failed. Retry 'split ${shot.id}', not import. ${error.message}`); }
}
export async function splitExisting({ shotId, opts, call, base }) {
  const shot = await call(`/api/shots/${encodeURIComponent(shotId)}`);
  const take = shot.takes.find(item => item.id === shot.active_take_id);
  if (!take?.mime?.startsWith('video/')) throw new Error('Adopt a video take before splitting');
  const duration = take.duration_ms ?? (opts['--duration'] === undefined ? await probeDuration(new URL(`/media/${take.media_id}`, base).href) : explicitDuration(opts));
  return call(`/api/shots/${shot.id}/split`, 'POST', { revision: shot.revision, ...splitPayload(opts, duration, take.start_ms ?? 0, take.end_ms ?? duration) });
}
