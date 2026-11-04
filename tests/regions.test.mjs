import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { backupData } from '../scripts/backup.mjs';
import { instruction } from '../src/runner.mjs';
let app, dir, base;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'shot-regions-')); app = await createApp({ dataDir: join(dir, 'data') }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`; });
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
async function call(path, method = 'GET', body) { const response = await fetch(base + path, { method, headers: { 'X-Workbench': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() }; }
async function shotWithMedia(filename = 'frame.png') {
  const project = (await call('/api/projects', 'POST', { title: 'Region project' })).data;
  const shot = (await call(`/api/projects/${project.id}/shots`, 'POST', { title: 'First' })).data;
  const response = await fetch(`${base}/api/shots/${shot.id}/takes?filename=${filename}`, { method: 'POST', headers: { 'X-Workbench': '1', 'X-Shot-Revision': '0' }, body: 'synthetic media' });
  return { project, shot: (await response.json()).shot };
}
const box = (extra = {}) => ({ x: 6000, y: 7000, w: 3000, h: 2000, note: 'sword turns gold', ...extra });

test('regions replace atomically, bump revision and reject invalid boxes', async () => {
  const project = (await call('/api/projects', 'POST', { title: 'No media' })).data;
  const empty = (await call(`/api/projects/${project.id}/shots`, 'POST', { title: 'Empty' })).data;
  assert.equal((await call(`/api/shots/${empty.id}/regions`, 'PUT', { revision: 0, regions: [box()] })).status, 400);
  const { shot } = await shotWithMedia();
  const saved = await call(`/api/shots/${shot.id}/regions`, 'PUT', { revision: shot.revision, regions: [box(), box({ x: 0, y: 0, w: 500, h: 500, note: '' })] });
  assert.equal(saved.status, 200);
  const current = saved.data.shots[0];
  assert.equal(current.revision, shot.revision + 1);
  assert.deepEqual(current.regions.map(r => [r.position, r.x, r.note, r.end_ms]), [[0, 6000, 'sword turns gold', null], [1, 0, '', null]]);
  for (const bad of [box({ x: 8000 }), box({ w: 10 }), box({ x: 1.5 }), box({ start_ms: 500, end_ms: 550 }), box({ note: 7 })]) {
    assert.equal((await call(`/api/shots/${shot.id}/regions`, 'PUT', { revision: current.revision, regions: [box(), bad] })).status, 400);
  }
  assert.equal((await call(`/api/shots/${shot.id}/regions`, 'PUT', { revision: current.revision, regions: Array.from({ length: 21 }, () => box()) })).status, 400);
  assert.equal((await call(`/api/shots/${shot.id}/regions`, 'PUT', { revision: shot.revision, regions: [] })).status, 409);
  assert.equal(app.store.regions(shot.id).length, 2, 'failed writes leave the saved boxes untouched');
  const cleared = await call(`/api/shots/${shot.id}/regions`, 'PUT', { revision: current.revision, regions: [] });
  assert.equal(cleared.status, 200); assert.equal(cleared.data.shots[0].regions.length, 0);
});

test('regions reach the job snapshot and instruction, and editing them blocks stale adoption', async () => {
  const { shot } = await shotWithMedia();
  const current = (await call(`/api/shots/${shot.id}/regions`, 'PUT', { revision: shot.revision, regions: [box()] })).data.shots[0];
  const job = (await call(`/api/shots/${shot.id}/jobs`, 'POST', { revision: current.revision, provider: 'manual' })).data;
  assert.deepEqual(job.snapshot.regions, [{ number: 1, placement: '右下', box_percent: { left: 60, top: 70, width: 30, height: 20 }, start_ms: 0, end_ms: null, note: 'sword turns gold' }]);
  assert.match(instruction(job), /only inside its box/);
  await call(`/api/jobs/${job.id}/claim`, 'POST', {}); await call(`/api/jobs/${job.id}/complete`, 'POST', { revised_prompt: 'new', summary: 'done' });
  await call(`/api/shots/${shot.id}/regions`, 'PUT', { revision: current.revision, regions: [box({ note: 'changed' })] });
  assert.equal((await call(`/api/jobs/${job.id}/apply`, 'POST', { revision: app.store.shot(shot.id).revision })).status, 409);
  assert.equal(app.jobs.get(job.id).snapshot.regions[0].note, 'sword turns gold');
});

test('ranged boxes respect the segment and splitting copies them into every overlapping segment', async () => {
  const { shot } = await shotWithMedia('source.mp4');
  const split = (await call(`/api/shots/${shot.id}/split`, 'POST', { revision: shot.revision, duration_ms: 30000, cuts_ms: [10000, 20000] })).data;
  const middle = split.shots[1];
  assert.equal((await call(`/api/shots/${middle.id}/regions`, 'PUT', { revision: middle.revision, regions: [box({ start_ms: 10000 })] })).status, 400);
  assert.equal((await call(`/api/shots/${middle.id}/regions`, 'PUT', { revision: middle.revision, regions: [box({ start_ms: 0, end_ms: 10001 })] })).status, 400);
  const whole = split.shots[0];
  const marked = (await call(`/api/shots/${whole.id}/regions`, 'PUT', { revision: whole.revision, regions: [box({ note: 'all' }), box({ start_ms: 3000, end_ms: 7000, note: 'span' }), box({ start_ms: 8000, end_ms: 9000, note: 'tail' })] })).data.shots[0];
  const again = (await call(`/api/shots/${whole.id}/split`, 'POST', { revision: marked.revision, cuts_ms: [5000] })).data;
  const [a, b] = again.shots;
  assert.deepEqual(a.regions.map(r => [r.note, r.start_ms, r.end_ms]), [['all', 0, null], ['span', 3000, 5000]]);
  assert.deepEqual(b.regions.map(r => [r.note, r.start_ms, r.end_ms]), [['all', 0, null], ['span', 0, 2000], ['tail', 3000, 4000]]);
  assert.equal(again.shots[2].regions.length, 0, 'other cards are not touched');
});

test('backup and v4 upgrade keep regions and snapshot the old schema', async () => {
  const { project, shot } = await shotWithMedia();
  await call(`/api/shots/${shot.id}/regions`, 'PUT', { revision: shot.revision, regions: [box()] });
  await backupData(join(dir, 'data'), join(dir, 'backup'));
  const restored = await createApp({ dataDir: join(dir, 'backup') });
  try { assert.equal(restored.store.detail(project.id).shots[0].regions[0].note, 'sword turns gold'); } finally { await restored.runner.close(); restored.store.close(); }
  await app.close();
  const legacy = new DatabaseSync(join(dir, 'data', 'workbench.sqlite')); legacy.exec('DROP TABLE shot_regions; PRAGMA user_version=4;'); legacy.close();
  app = await createApp({ dataDir: join(dir, 'data') }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal(app.store.db.prepare('PRAGMA user_version').get().user_version, 7);
  assert.deepEqual(app.store.detail(project.id).shots[0].regions, []);
  const snapshot = new DatabaseSync(join(dir, 'data', 'schema-v4-before-v5.sqlite'), { readOnly: true });
  try { assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 4); } finally { snapshot.close(); }
});
