import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { audioTypes } from './audio.mjs';

// Agent-side helpers for cli.mjs: stream a local audio file into a track or as a new clip version.
export function flags(args, allowed) {
  const values = {};
  for (let n = 0; n < args.length; n += 2) {
    if (!allowed.includes(args[n]) || args[n + 1] === undefined || values[args[n]] !== undefined) throw new Error('Invalid or duplicate option: ' + args[n]);
    values[args[n]] = args[n + 1];
  }
  return values;
}
async function file(input) {
  const path = resolve(input), info = await stat(path);
  if (!info.isFile() || !info.size || info.size > 1024 ** 3) throw new Error('Audio must be a nonempty file no larger than 1 GB');
  if (!audioTypes[extname(path).toLowerCase()]) throw new Error('Audio must be MP3, WAV, OGG, M4A or FLAC');
  return { path, info };
}
async function upload(base, route, { path, info }, headers = {}) {
  const response = await fetch(new URL(route, base), {
    method: 'POST', headers: { 'X-Workbench': '1', 'Content-Type': 'application/octet-stream', 'Content-Length': String(info.size), ...headers }, body: createReadStream(path), duplex: 'half'
  });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
const summary = (result, key) => ({ [key]: result[key], tracks: result.tracks.map(t => ({ id: t.id, title: t.title, kind: t.kind, clips: t.clips.map(c => ({ id: c.id, title: c.title, offset_ms: c.offset_ms, active_version_id: c.active_version_id, versions: c.versions.length })) })) });
export async function addClip({ trackId, input, opts, base }) {
  const source = await file(input), offset = opts['--offset'] === undefined ? 0 : Number(opts['--offset']);
  if (!Number.isFinite(offset) || offset < 0) throw new Error('--offset must be seconds ≥ 0');
  const query = new URLSearchParams({ filename: basename(source.path), offset_ms: String(Math.round(offset * 1000)), title: opts['--title'] ?? '', note: opts['--note'] ?? '' });
  return summary(await upload(base, `/api/audio/tracks/${encodeURIComponent(trackId)}/clips?${query}`, source), 'clip_id');
}
export async function addVersion({ clipId, input, opts, call, base }) {
  const source = await file(input), clip = await call(`/api/audio/clips/${encodeURIComponent(clipId)}`);
  const query = new URLSearchParams({ filename: basename(source.path), note: opts['--note'] ?? '' });
  return summary(await upload(base, `/api/audio/clips/${encodeURIComponent(clipId)}/versions?${query}`, source, { 'X-Clip-Revision': String(clip.revision) }), 'version_id');
}
