import { stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { upload } from './audio-command.mjs';

// Agent-side helper for cli.mjs: attach a depth map (white = near) to a shot's micro-motion rig.
// Creates a camera-only rig on the active still when there is none; a still camera becomes a slow push.
const depthTypes = ['.png', '.jpg', '.jpeg', '.webp'];
export async function attachDepth({ shotId, input, call, base }) {
  const path = resolve(input), info = await stat(path);
  if (!info.isFile() || !info.size || info.size > 1024 ** 3) throw new Error('Depth map must be a nonempty file no larger than 1 GB');
  if (!depthTypes.includes(extname(path).toLowerCase())) throw new Error('Depth map must be PNG, JPG or WebP');
  const shot = await call(`/api/shots/${encodeURIComponent(shotId)}`);
  let rig = null; try { rig = shot.motion ? JSON.parse(shot.motion) : null; } catch { rig = null; }
  const take = shot.takes.find(t => t.id === rig?.source_take_id) || shot.takes.find(t => t.id === shot.active_take_id);
  if (!take?.mime?.startsWith('image/')) throw new Error('This shot has no still image to animate');
  if (rig?.source_take_id !== take.id) rig = { source_take_id: take.id, duration_ms: 4000, regions: [] };
  const media = await upload(base, `/api/shots/${encodeURIComponent(shotId)}/depth?filename=${encodeURIComponent(basename(path))}`, { path, info });
  const camera = rig.camera?.move && rig.camera.move !== 'none' ? rig.camera : { strength: 4, cycles: 1, focus: 50, ...rig.camera, move: 'push' };
  const updated = await call(`/api/shots/${encodeURIComponent(shotId)}`, 'PATCH', { revision: shot.revision, motion: JSON.stringify({ ...rig, depth_media_id: media.media_id, camera }) });
  return { shot_id: updated.id, revision: updated.revision, motion: JSON.parse(updated.motion) };
}
