import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { backupData } from '../scripts/backup.mjs';
import { DatabaseSync } from 'node:sqlite';

let app, dir, base;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shot-workbench-test-'));
  app = await createApp({ dataDir: join(dir, 'data') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
async function call(path, method = 'GET', body) {
  const res = await fetch(base + path, { method, headers: { 'X-Workbench': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
async function fixture() {
  const { data: project } = await call('/api/projects', 'POST', { title: '测试项目' });
  const { data: shot } = await call(`/api/projects/${project.id}/shots`, 'POST', { title: '转头镜头' });
  return { project, shot };
}
async function upload(shot, content = Buffer.from('test media bytes'), name = 'clip.mp4') {
  const res = await fetch(`${base}/api/shots/${shot.id}/takes?filename=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'X-Workbench': '1', 'X-Shot-Revision': String(shot.revision) }, body: content
  });
  return { status: res.status, data: await res.json() };
}

test('drafts, immutable take snapshots and active take survive a server restart', async () => {
  const { project, shot } = await fixture();
  const update = await call(`/api/shots/${shot.id}`, 'PATCH', { revision: 0, prompt: '角色缓慢转头', notes: '最后停顿一秒', status: 'revise' });
  assert.equal(update.status, 200);
  const v1 = await upload(update.data); assert.equal(v1.status, 201);
  const v2draft = await call(`/api/shots/${shot.id}`, 'PATCH', { revision: v1.data.shot.revision, prompt: '角色缓慢转头，最后停顿一秒' });
  const v2 = await upload(v2draft.data, Buffer.from('second take')); assert.equal(v2.data.number, 2);
  const select = await call(`/api/shots/${shot.id}`, 'PATCH', { revision: v2.data.shot.revision, active_take_id: v1.data.id });
  assert.equal(select.status, 200);
  await app.close();
  app = await createApp({ dataDir: join(dir, 'data') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
  const saved = (await call(`/api/projects/${project.id}`)).data.shots[0];
  assert.equal(saved.prompt, '角色缓慢转头，最后停顿一秒');
  assert.equal(saved.active_take_id, v1.data.id);
  assert.equal(saved.takes.length, 2);
  assert.equal(saved.takes[1].prompt, '角色缓慢转头');
  assert.equal(saved.takes[1].notes, '最后停顿一秒');
});

test('stale writes and uploads cannot overwrite a newer draft', async () => {
  const { shot } = await fixture();
  await call(`/api/shots/${shot.id}`, 'PATCH', { revision: 0, prompt: 'new draft' });
  assert.equal((await call(`/api/shots/${shot.id}`, 'PATCH', { revision: 0, prompt: 'stale' })).status, 409);
  assert.equal((await upload(shot)).status, 409);
  assert.deepEqual(await readdir(join(dir, 'data', 'media')), []);
  assert.equal(app.store.shot(shot.id).prompt, 'new draft');
});

test('reordering requires exactly the current project members', async () => {
  const { project, shot } = await fixture();
  const second = (await call(`/api/projects/${project.id}/shots`, 'POST', { title: '第二段' })).data;
  const url = `/api/projects/${project.id}/order`;
  assert.equal((await call(url, 'PUT', { ids: [second.id, shot.id] })).data.shots[0].id, second.id);
  assert.equal((await call(url, 'PUT', { ids: [shot.id, shot.id] })).status, 409);
  assert.equal((await call(url, 'PUT', { ids: [shot.id] })).status, 409);
});

test('media byte ranges, suffix ranges and HEAD work for video seeking', async () => {
  const { shot } = await fixture();
  const content = Buffer.from('0123456789');
  const take = await upload(shot, content);
  const mediaId = app.store.detail(shot.project_id).shots[0].takes[0].media_id;
  const path = `${base}/media/${mediaId}`;
  const partial = await fetch(path, { headers: { Range: 'bytes=2-5' } });
  assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(await partial.text(), '2345');
  const suffix = await fetch(path, { headers: { Range: 'bytes=-3' } }); assert.equal(await suffix.text(), '789');
  assert.equal((await fetch(path, { headers: { Range: 'bytes=100-' } })).status, 416);
  const head = await fetch(path, { method: 'HEAD' }); assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '');
  assert.equal(take.status, 201);
});

test('backup can be opened with all referenced media after database restore', async () => {
  const { project, shot } = await fixture();
  await upload(shot, Buffer.from('original bytes'));
  const backupDir = join(dir, 'backup');
  await backupData(join(dir, 'data'), backupDir);
  const restored = await createApp({ dataDir: backupDir });
  try {
    const take = restored.store.detail(project.id).shots[0].takes[0];
    const media = restored.store.media(take.media_id);
    assert.equal((await readFile(join(backupDir, 'media', media.stored_name))).toString(), 'original bytes');
  } finally { restored.store.close(); }
});

test('local origin checks and field validation reject unintended writes', async () => {
  const { shot } = await fixture();
  const foreign = await fetch(base + '/api/projects', { method: 'POST', headers: { Origin: 'https://example.com', 'X-Workbench': '1', 'Content-Type': 'application/json' }, body: '{"title":"bad"}' });
  assert.equal(foreign.status, 403);
  const missingHeader = await fetch(base + '/api/projects', { method: 'POST', body: '{}' }); assert.equal(missingHeader.status, 403);
  assert.equal((await call(`/api/shots/${shot.id}`, 'PATCH', { revision: 0, status: 'wrong' })).status, 400);
  assert.equal((await call(`/api/shots/${shot.id}`, 'PATCH', { revision: 0, title: '' })).status, 400);
  assert.equal((await upload(shot, Buffer.from('bad'), 'active.html')).status, 415);
  const html = await fetch(base + '/'); assert.equal(html.status, 200); assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(base + '/src/store.mjs')).status, 404);
});

test('text-only segments can preserve versions without an AI or media service', async () => {
  const { shot, project } = await fixture();
  const draft = (await call(`/api/shots/${shot.id}`, 'PATCH', { revision: 0, prompt: '一个开场', notes: '更简短' })).data;
  assert.equal((await call(`/api/shots/${shot.id}/snapshot`, 'POST', { revision: draft.revision })).status, 201);
  const take = (await call(`/api/projects/${project.id}`)).data.shots[0].takes[0];
  assert.equal(take.media_id, null); assert.equal(take.prompt, '一个开场'); assert.equal(take.notes, '更简短');
});

test('30 seconds split into five independent shots shares one media file and preserves original take', async () => {
  const { project, shot } = await fixture();
  const following = (await call(`/api/projects/${project.id}/shots`, 'POST', { title: 'Following shot' })).data;
  const saved = (await call(`/api/shots/${shot.id}`, 'PATCH', { revision: 0, prompt: 'source prompt', notes: 'source notes' })).data;
  const uploaded = (await upload(saved)).data;
  const result = await call(`/api/shots/${shot.id}/split`, 'POST', { revision: uploaded.shot.revision, duration_ms: 30000, cuts_ms: [6000, 12000, 18000, 24000] });
  assert.equal(result.status, 201);
  assert.equal(result.data.shots.length, 6);
  assert.equal(result.data.shots[5].id, following.id);
  const segments = result.data.shots.slice(0, 5);
  assert.deepEqual(segments.map(s => [s.takes[0].start_ms, s.takes[0].end_ms]), [[0, 6000], [6000, 12000], [12000, 18000], [18000, 24000], [24000, 30000]]);
  assert.equal(new Set(segments.map(s => s.takes[0].media_id)).size, 1);
  assert.equal((await readdir(join(dir, 'data', 'media'))).length, 1);
  assert.equal(segments[0].takes[1].id, uploaded.id);
  assert.equal(segments[0].takes[1].start_ms, null);
  assert.equal(segments[1].prompt, 'source prompt');
  const edited = await call(`/api/shots/${segments[1].id}`, 'PATCH', { revision: segments[1].revision, notes: 'only second segment' });
  assert.equal(edited.status, 200);
  assert.equal(app.store.shot(shot.id).notes, 'source notes');
  const reSplit = await call(`/api/shots/${segments[1].id}/split`, 'POST', { revision: edited.data.revision, cuts_ms: [9000] });
  assert.equal(reSplit.status, 201);
  assert.deepEqual(reSplit.data.shots.slice(1, 3).map(s => [s.takes[0].start_ms, s.takes[0].end_ms]), [[6000, 9000], [9000, 12000]]);
});

test('invalid cuts, stale writes and image sources fail atomically', async () => {
  const { project, shot } = await fixture();
  const uploaded = (await upload(shot)).data;
  const url = `/api/shots/${shot.id}/split`;
  for (const cuts_ms of [[], [0], [30001], [10000, 5000], [6000, 6000], [50], ['6000'], Array(100).fill(1000)]) {
    assert.equal((await call(url, 'POST', { revision: uploaded.shot.revision, duration_ms: 30000, cuts_ms })).status, 400);
  }
  assert.equal((await call(url, 'POST', { revision: 0, duration_ms: 30000, cuts_ms: [15000] })).status, 409);
  assert.equal(app.store.detail(project.id).shots.length, 1);
  assert.equal(app.store.detail(project.id).shots[0].takes.length, 1);
  const image = (await upload(uploaded.shot, Buffer.from('image'), 'test.png')).data;
  assert.equal((await call(url, 'POST', { revision: image.shot.revision, duration_ms: 30000, cuts_ms: [15000] })).status, 400);
});

test('trim history and ranges survive backup restore without duplicating media', async () => {
  const { project, shot } = await fixture();
  const uploaded = (await upload(shot)).data;
  const result = await call(`/api/shots/${shot.id}/trim`, 'POST', { revision: uploaded.shot.revision, duration_ms: 30000, start_ms: 5000, end_ms: 12500 });
  assert.equal(result.status, 201);
  assert.equal(result.data.shots[0].takes[1].start_ms, null);
  const backupDir = join(dir, 'ranged-backup'); await backupData(join(dir, 'data'), backupDir);
  const restored = await createApp({ dataDir: backupDir });
  try {
    const take = restored.store.detail(project.id).shots[0].takes[0];
    assert.deepEqual([take.start_ms, take.end_ms, take.duration_ms], [5000, 12500, 30000]);
  } finally { restored.store.close(); }
});

test('v1 database migrates without losing existing media or drafts and creates a pre-upgrade snapshot', async () => {
  const { project, shot } = await fixture();
  const updated = (await call(`/api/shots/${shot.id}`, 'PATCH', { revision: 0, prompt: 'legacy draft' })).data;
  await upload(updated);
  await app.close();
  const old = new DatabaseSync(join(dir, 'data', 'workbench.sqlite'));
  old.exec('ALTER TABLE takes DROP COLUMN start_ms; ALTER TABLE takes DROP COLUMN end_ms; ALTER TABLE takes DROP COLUMN duration_ms; PRAGMA user_version=1;'); old.close();
  app = await createApp({ dataDir: join(dir, 'data') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
  const detail = (await call(`/api/projects/${project.id}`)).data;
  assert.equal(detail.shots[0].prompt, 'legacy draft');
  assert.equal(detail.shots[0].takes[0].start_ms, null);
  assert.equal(app.store.db.prepare('PRAGMA user_version').get().user_version, 6);
  const snapshot = new DatabaseSync(join(dir, 'data', 'schema-v1-before-v2.sqlite'), { readOnly: true });
  try { assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 1); assert.equal(snapshot.prepare('SELECT prompt FROM shots').get().prompt, 'legacy draft'); }
  finally { snapshot.close(); }
});
