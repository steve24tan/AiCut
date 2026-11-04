import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
let app, dir, base;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'shot-voices-')); app = await createApp({ dataDir: join(dir, 'data') }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`; });
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
async function call(path, method = 'GET', body) { const response = await fetch(base + path, { method, headers: { 'X-Workbench': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() }; }
async function setup() {
  const project = (await call('/api/projects', 'POST', { title: 'Voice project' })).data;
  const shot = (await call(`/api/projects/${project.id}/shots`, 'POST', { title: 'Opening' })).data;
  const list = (await call(`/api/projects/${project.id}/characters`, 'POST', { name: 'Lorraine' })).data;
  return { project, shot, lorraine: list[0] };
}

test('characters: create, validate, edit', async () => {
  const { project, lorraine } = await setup();
  assert.deepEqual([lorraine.name, lorraine.provider, lorraine.voice_id], ['Lorraine', 'elevenlabs', '']);
  assert.equal((await call(`/api/projects/${project.id}/characters`, 'POST', { name: 'Lorraine' })).status, 409);
  assert.equal((await call(`/api/projects/${project.id}/characters`, 'POST', { name: ' ' })).status, 400);
  assert.equal((await call(`/api/projects/${project.id}/characters`, 'POST', { name: 'Dante', provider: 'azure' })).status, 400);
  const edited = await call(`/api/characters/${lorraine.id}`, 'PATCH', { revision: 0, voice_id: 'abc123', voice_notes: '年轻女声、台湾腔' });
  assert.equal(edited.status, 200); assert.equal(edited.data[0].voice_id, 'abc123');
  assert.equal((await call(`/api/characters/${lorraine.id}`, 'PATCH', { revision: 0, voice_id: 'stale' })).status, 409);
  assert.equal((await call(`/api/projects/${project.id}/characters`)).data.length, 1);
});

test('dialogue saves with the shot revision, validates atomically and reaches CLI snapshots', async () => {
  const { project, shot, lorraine } = await setup();
  const other = (await call('/api/projects', 'POST', { title: 'Other' })).data;
  const stranger = (await call(`/api/projects/${other.id}/characters`, 'POST', { name: 'Stranger' })).data[0];
  const saved = await call(`/api/shots/${shot.id}`, 'PATCH', { revision: shot.revision, prompt: 'p', lines: [{ character_id: lorraine.id, text: '欢迎来到 Grand Archive！', delivery: '兴奋' }, { character_id: null, text: '（旁白）三天后……' }] });
  assert.equal(saved.status, 200);
  let detail = app.store.detail(project.id).shots[0];
  assert.deepEqual(detail.lines.map(l => [l.position, l.character, l.text, l.delivery]), [[0, 'Lorraine', '欢迎来到 Grand Archive！', '兴奋'], [1, null, '（旁白）三天后……', '']]);
  for (const bad of [[{ character_id: stranger.id, text: 'x' }], [{ text: 5 }], Array.from({ length: 51 }, () => ({ text: 'x' })), 'nope']) {
    assert.equal((await call(`/api/shots/${shot.id}`, 'PATCH', { revision: detail.revision, prompt: 'changed', lines: bad })).status, 400);
  }
  detail = app.store.detail(project.id).shots[0];
  assert.equal(detail.lines.length, 2); assert.equal(detail.prompt, 'p', 'a rejected line list rolls back the whole save');
  await call(`/api/characters/${lorraine.id}`, 'PATCH', { revision: 0, voice_id: 'voice-1' });
  const current = app.store.shot(shot.id);
  assert.equal(current.revision, detail.revision + 1, 'voice change bumps shots that use the character');
  const job = (await call(`/api/shots/${shot.id}/jobs`, 'POST', { revision: current.revision, provider: 'manual' })).data;
  assert.deepEqual(job.snapshot.lines[0], { character: 'Lorraine', provider: 'elevenlabs', voice_id: 'voice-1', voice_notes: '', text: '欢迎来到 Grand Archive！', delivery: '兴奋' });
  assert.equal((await call(`/api/characters/${lorraine.id}`, 'DELETE', { revision: 1 })).status, 409, 'characters in use cannot be deleted');
  await call(`/api/shots/${shot.id}`, 'PATCH', { revision: current.revision, lines: [] });
  assert.equal((await call(`/api/characters/${lorraine.id}`, 'DELETE', { revision: 1 })).status, 200);
  assert.deepEqual(app.store.detail(project.id).characters, []);
});
