import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
let app, dir, base;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'shot-motion-')); app = await createApp({ dataDir: join(dir, 'data') }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`; });
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
async function call(path, method = 'GET', body) { const response = await fetch(base + path, { method, headers: { 'X-Workbench': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() }; }
async function shotWith(filename) {
  const project = (await call('/api/projects', 'POST', { title: 'Motion' })).data;
  const shot = (await call(`/api/projects/${project.id}/shots`, 'POST', { title: 'Still' })).data;
  const take = await (await fetch(`${base}/api/shots/${shot.id}/takes?filename=${filename}`, { method: 'POST', headers: { 'X-Workbench': '1', 'X-Shot-Revision': '0' }, body: 'bytes' })).json();
  return { project, shot: take.shot, takeId: take.id };
}
const region = (extra = {}) => ({ x: 6000, y: 6500, w: 2500, h: 1500, effect: 'tremble', strength: 4, speed: 1, feather: 25, pivot_x: 7250, pivot_y: 7250, ...extra });
const rig = (takeId, extra = {}) => JSON.stringify({ source_take_id: takeId, duration_ms: 4000, regions: [region()], ...extra });
const normalized = (takeId, extra = {}) => ({ source_take_id: takeId, duration_ms: 4000, regions: [region()], depth_media_id: null, camera: { move: 'none', strength: 4, cycles: 1, focus: 50 }, ...extra });
async function depth(shotId, filename = 'depth.png') {
  const response = await fetch(`${base}/api/shots/${shotId}/depth?filename=${filename}`, { method: 'POST', headers: { 'X-Workbench': '1' }, body: 'depth' });
  return { status: response.status, data: await response.json() };
}

test('motion rig saves normalized with the shot revision and validates every field', async () => {
  const { project, shot, takeId } = await shotWith('still.png');
  const saved = await call(`/api/shots/${shot.id}`, 'PATCH', { revision: shot.revision, motion: JSON.stringify({ ...JSON.parse(rig(takeId)), extra: 'dropped' }) });
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(saved.data.motion), normalized(takeId), 'unknown fields are dropped, camera defaults filled in');
  let revision = saved.data.revision;
  const video = await shotWith('clip.mp4');
  for (const bad of [
    'not json', rig('missing-take'), rig(video.takeId), rig(takeId, { duration_ms: 500 }), rig(takeId, { duration_ms: 20000 }),
    rig(takeId, { regions: [region({ effect: 'explode' })] }), rig(takeId, { regions: [region({ x: 9000 })] }), rig(takeId, { regions: [region({ strength: 11 })] }),
    rig(takeId, { regions: [region({ speed: 0 })] }), rig(takeId, { regions: [region({ feather: 80 })] }), rig(takeId, { regions: [region({ pivot_x: -1 })] }),
    rig(takeId, { regions: Array.from({ length: 9 }, () => region()) }),
    rig(takeId, { camera: { move: 'push' } }), rig(takeId, { depth_media_id: 'missing' }), rig(takeId, { depth_media_id: 7 })
  ]) assert.equal((await call(`/api/shots/${shot.id}`, 'PATCH', { revision, motion: bad })).status, 400, bad);
  assert.equal(app.store.shot(shot.id).revision, revision, 'rejected rigs change nothing');
  assert.equal((await call(`/api/shots/${shot.id}`, 'PATCH', { revision: revision - 1, motion: '' })).status, 409);
  const cleared = await call(`/api/shots/${shot.id}`, 'PATCH', { revision, motion: '' });
  assert.equal(cleared.data.motion, '');
  assert.equal(app.store.detail(project.id).shots[0].motion, '');
});

test('v6 databases upgrade to v7 with a snapshot and an empty rig', async () => {
  const { project } = await shotWith('still.png');
  await app.close();
  const legacy = new DatabaseSync(join(dir, 'data', 'workbench.sqlite')); legacy.exec('ALTER TABLE shots DROP COLUMN motion; PRAGMA user_version=6;'); legacy.close();
  app = await createApp({ dataDir: join(dir, 'data') }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal(app.store.db.prepare('PRAGMA user_version').get().user_version, 7);
  assert.equal(app.store.detail(project.id).shots[0].motion, '');
  const snapshot = new DatabaseSync(join(dir, 'data', 'schema-v6-before-v7.sqlite'), { readOnly: true });
  try { assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 6); } finally { snapshot.close(); }
});

test('depth maps upload as media, not takes, and unlock camera moves', async () => {
  const { shot, takeId } = await shotWith('still.png');
  assert.equal((await depth(shot.id, 'depth.mp4')).status, 415, 'depth must be an image');
  assert.equal((await depth('no-such-shot')).status, 404);
  const uploaded = await depth(shot.id);
  assert.equal(uploaded.status, 201);
  assert.equal(app.store.media(uploaded.data.media_id).mime, 'image/png');
  const after = app.store.shot(shot.id);
  assert.equal(after.revision, shot.revision, 'uploading a depth map does not touch the shot');
  assert.equal(app.store.detail(after.project_id).shots[0].takes.length, 1, 'depth map is not a take');
  const camera = { move: 'orbit', strength: 6, cycles: 2, focus: 70 };
  const saved = await call(`/api/shots/${shot.id}`, 'PATCH', { revision: after.revision, motion: rig(takeId, { regions: [], depth_media_id: uploaded.data.media_id, camera: { ...camera, extra: 1 } }) });
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(saved.data.motion), normalized(takeId, { regions: [], depth_media_id: uploaded.data.media_id, camera }), 'camera-only rig with a depth map is valid');
  const video = await shotWith('clip.mp4');
  for (const bad of [
    { move: 'zoom' }, { move: 'pan', strength: 0 }, { move: 'pan', cycles: 1.5 }, { move: 'pan', cycles: 5 }, { move: 'pan', focus: 101 }
  ]) assert.equal((await call(`/api/shots/${shot.id}`, 'PATCH', { revision: saved.data.revision, motion: rig(takeId, { depth_media_id: uploaded.data.media_id, camera: bad }) })).status, 400, JSON.stringify(bad));
  assert.equal((await call(`/api/shots/${shot.id}`, 'PATCH', { revision: saved.data.revision, motion: rig(takeId, { depth_media_id: video.takeId }) })).status, 400, 'take ids are not depth maps');
  assert.equal((await call(`/api/shots/${shot.id}`, 'PATCH', { revision: saved.data.revision, motion: rig(takeId, { regions: [region({ effect: 'flow' })] }) })).status, 200, 'flow is a region effect');
});

test('cli motion depth attaches a depth map and starts a slow push, keeping existing regions', async () => {
  const { shot, takeId } = await shotWith('still.png');
  const cli = (...args) => promisify(execFile)(process.execPath, ['cli.mjs', ...args], { cwd: resolve('.'), env: { ...process.env, SHOT_WORKBENCH_URL: base } }).then(r => JSON.parse(r.stdout));
  const file = join(dir, 'depth.png'); await writeFile(file, 'depth');
  const first = await cli('motion', 'depth', shot.id, file);
  assert.deepEqual({ ...first.motion, depth_media_id: 'x' }, normalized(takeId, { regions: [], depth_media_id: 'x', camera: { move: 'push', strength: 4, cycles: 1, focus: 50 } }));
  const withRegions = await call(`/api/shots/${shot.id}`, 'PATCH', { revision: first.revision, motion: rig(takeId, { depth_media_id: first.motion.depth_media_id, camera: { move: 'orbit', strength: 2, cycles: 3, focus: 80 } }) });
  const second = await cli('motion', 'depth', shot.id, file);
  assert.notEqual(second.motion.depth_media_id, first.motion.depth_media_id, 'a new depth map is a new media row');
  assert.deepEqual(second.motion.regions, [region()]); assert.deepEqual(second.motion.camera, { move: 'orbit', strength: 2, cycles: 3, focus: 80 });
  assert.equal(second.revision, withRegions.data.revision + 1);
  const video = await shotWith('clip.mp4');
  await assert.rejects(cli('motion', 'depth', video.shot.id, file), /no still image/);
});
