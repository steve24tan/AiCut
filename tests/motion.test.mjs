import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('motion rig saves normalized with the shot revision and validates every field', async () => {
  const { project, shot, takeId } = await shotWith('still.png');
  const saved = await call(`/api/shots/${shot.id}`, 'PATCH', { revision: shot.revision, motion: JSON.stringify({ ...JSON.parse(rig(takeId)), extra: 'dropped' }) });
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(saved.data.motion), JSON.parse(rig(takeId)), 'unknown fields are dropped');
  let revision = saved.data.revision;
  const video = await shotWith('clip.mp4');
  for (const bad of [
    'not json', rig('missing-take'), rig(video.takeId), rig(takeId, { duration_ms: 500 }), rig(takeId, { duration_ms: 20000 }),
    rig(takeId, { regions: [region({ effect: 'explode' })] }), rig(takeId, { regions: [region({ x: 9000 })] }), rig(takeId, { regions: [region({ strength: 11 })] }),
    rig(takeId, { regions: [region({ speed: 0 })] }), rig(takeId, { regions: [region({ feather: 80 })] }), rig(takeId, { regions: [region({ pivot_x: -1 })] }),
    rig(takeId, { regions: Array.from({ length: 9 }, () => region()) })
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
