import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { backupData } from '../scripts/backup.mjs';
let app, dir, base;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'shot-audio-')); app = await createApp({ dataDir: join(dir, 'data') }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`; });
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
async function call(path, method = 'GET', body) { const response = await fetch(base + path, { method, headers: { 'X-Workbench': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() }; }
async function send(path, bytes = 'synthetic audio', headers = {}) { const response = await fetch(base + path, { method: 'POST', headers: { 'X-Workbench': '1', 'Content-Type': 'application/octet-stream', ...headers }, body: bytes }); return { status: response.status, data: await response.json() }; }
async function setup() {
  const project = (await call('/api/projects', 'POST', { title: 'Audio project' })).data;
  const tracks = (await call(`/api/projects/${project.id}/audio/tracks`, 'POST', { title: 'BGM 1', kind: 'bgm' })).data.tracks;
  return { project, track: tracks[0] };
}
const clipOf = (state, id) => state.tracks.flatMap(t => t.clips).find(c => c.id === id);

test('tracks and clips: upload, library asset, validation and cleanup of rejected uploads', async () => {
  const { project, track } = await setup();
  assert.equal((await call(`/api/projects/${project.id}/audio/tracks`, 'POST', { title: 'x', kind: 'drums' })).status, 400);
  const uploaded = await send(`/api/audio/tracks/${track.id}/clips?filename=theme.mp3&offset_ms=1500`);
  assert.equal(uploaded.status, 201);
  const clip = clipOf(uploaded.data, uploaded.data.clip_id);
  assert.equal(clip.title, 'theme'); assert.equal(clip.offset_ms, 1500); assert.equal(clip.versions.length, 1); assert.equal(clip.active_version_id, clip.versions[0].id);
  const before = (await readdir(join(dir, 'data', 'media'))).length;
  assert.equal((await send(`/api/audio/tracks/${track.id}/clips?filename=clip.mp4`)).status, 415);
  assert.equal((await send(`/api/audio/tracks/${track.id}/clips?filename=empty.wav`, '')).status, 400);
  assert.equal((await readdir(join(dir, 'data', 'media'))).length, before, 'rejected uploads leave no files');
  const asset = await (await fetch(base + '/api/library/import?filename=whoosh.wav', { method: 'POST', headers: { 'X-Workbench': '1' }, body: 'sfx bytes' })).json();
  const image = await (await fetch(base + '/api/library/import?filename=meme.png', { method: 'POST', headers: { 'X-Workbench': '1' }, body: 'png bytes' })).json();
  const fromAsset = await call(`/api/audio/tracks/${track.id}/clips`, 'POST', { asset_id: asset.id, offset_ms: 0 });
  assert.equal(fromAsset.status, 201); assert.equal(clipOf(fromAsset.data, fromAsset.data.clip_id).versions[0].media_id, asset.media_id, 'library assets are reused, not copied');
  assert.equal((await call(`/api/audio/tracks/${track.id}/clips`, 'POST', { asset_id: image.id })).status, 400);
  assert.equal((await call(`/api/audio/tracks/${track.id}/clips`, 'POST', { asset_id: asset.id, offset_ms: -5 })).status, 400);
  const detail = (await call(`/api/projects/${project.id}/audio`)).data;
  assert.deepEqual(detail.tracks[0].clips.map(c => c.offset_ms), [0, 1500]);
});

test('clip edits, versions for A/B and stale writes', async () => {
  const { project, track } = await setup();
  const other = (await call('/api/projects', 'POST', { title: 'Other' })).data;
  const foreign = (await call(`/api/projects/${other.id}/audio/tracks`, 'POST', { title: 'X', kind: 'sfx' })).data.tracks[0];
  const voice = (await call(`/api/projects/${project.id}/audio/tracks`, 'POST', { title: '配音 1', kind: 'voice' })).data.tracks[1];
  const created = await send(`/api/audio/tracks/${track.id}/clips?filename=theme.wav`);
  let clip = clipOf(created.data, created.data.clip_id);
  const edited = await call(`/api/audio/clips/${clip.id}`, 'PATCH', { revision: clip.revision, offset_ms: 4000, in_ms: 2000, out_ms: 12000, notes: '含蓄一点，降低鼓点' });
  assert.equal(edited.status, 200); clip = clipOf(edited.data, clip.id);
  assert.deepEqual([clip.offset_ms, clip.in_ms, clip.out_ms, clip.notes], [4000, 2000, 12000, '含蓄一点，降低鼓点']);
  for (const bad of [{ out_ms: 2050 }, { in_ms: -1 }, { title: '  ' }, { track_id: foreign.id }, { active_version_id: 'nope' }, { volume: 1 }]) {
    assert.equal((await call(`/api/audio/clips/${clip.id}`, 'PATCH', { revision: clip.revision, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call(`/api/audio/clips/${clip.id}`, 'PATCH', { revision: clip.revision - 1, notes: 'stale' })).status, 409);
  assert.equal((await send(`/api/audio/clips/${clip.id}/versions?filename=v2.wav`, 'new bytes', { 'X-Clip-Revision': String(clip.revision - 1) })).status, 409);
  const v2 = await send(`/api/audio/clips/${clip.id}/versions?filename=v2.wav&note=${encodeURIComponent('鼓 -9dB')}`, 'new bytes', { 'X-Clip-Revision': String(clip.revision) });
  assert.equal(v2.status, 201); clip = clipOf(v2.data, clip.id);
  assert.deepEqual(clip.versions.map(v => [v.number, v.note]), [[2, '鼓 -9dB'], [1, '']]);
  assert.equal(clip.active_version_id, v2.data.version_id); assert.equal(clip.in_ms, 2000, 'trim is kept across versions so A/B compares the same window');
  const back = await call(`/api/audio/clips/${clip.id}`, 'PATCH', { revision: clip.revision, active_version_id: clip.versions[1].id, track_id: voice.id });
  assert.equal(back.status, 200); assert.equal(back.data.tracks[1].clips[0].active_version_id, clip.versions[1].id);
  const version = clip.versions[0].id;
  assert.equal((await call(`/api/audio/versions/${version}`, 'PATCH', { duration_ms: 30000 })).data.duration_ms, 30000);
  assert.equal((await call(`/api/audio/versions/${version}`, 'PATCH', { duration_ms: 1 })).data.duration_ms, 30000, 'known duration is not overwritten');
  assert.equal((await call(`/api/audio/versions/${version}`, 'PATCH', { duration_ms: 0 })).status, 400);
});

test('audio regions replace atomically, bump revision and validate', async () => {
  const { track } = await setup();
  const created = await send(`/api/audio/tracks/${track.id}/clips?filename=theme.wav`);
  const clip = clipOf(created.data, created.data.clip_id);
  const saved = await call(`/api/audio/clips/${clip.id}/regions`, 'PUT', { revision: clip.revision, regions: [{ start_ms: 8000, end_ms: 16000, note: '鼓点降低' }, { start_ms: 0, end_ms: 4000 }] });
  assert.equal(saved.status, 200);
  const current = clipOf(saved.data, clip.id);
  assert.equal(current.revision, clip.revision + 1); assert.deepEqual(current.regions.map(r => [r.position, r.start_ms, r.note]), [[0, 8000, '鼓点降低'], [1, 0, '']]);
  for (const bad of [[{ start_ms: 100, end_ms: 150 }], [{ start_ms: -1, end_ms: 500 }], [{ start_ms: 0, end_ms: 500, note: 3 }], Array.from({ length: 21 }, () => ({ start_ms: 0, end_ms: 500 }))]) {
    assert.equal((await call(`/api/audio/clips/${clip.id}/regions`, 'PUT', { revision: current.revision, regions: bad })).status, 400);
  }
  assert.equal(app.audio.detail(saved.data.project_id).tracks[0].clips[0].regions.length, 2, 'failed writes keep saved regions');
  assert.equal((await call(`/api/audio/clips/${clip.id}/regions`, 'PUT', { revision: clip.revision, regions: [] })).status, 409);
});

test('timeline export manifest: paths, ranges, subtitles, and refusal without durations', async () => {
  const { project, track } = await setup();
  const shot = (await call(`/api/projects/${project.id}/shots`, 'POST', { title: 'Opening' })).data;
  await send(`/api/shots/${shot.id}/takes?filename=still.png`, 'png bytes', { 'X-Shot-Revision': '0' });
  await call(`/api/shots/${shot.id}`, 'PATCH', { revision: app.store.shot(shot.id).revision, lines: [{ text: 'one' }, { text: ' ' }, { text: 'two' }] });
  const created = await send(`/api/audio/tracks/${track.id}/clips?filename=theme.wav&offset_ms=500`);
  const clip = clipOf(created.data, created.data.clip_id);
  assert.equal((await call(`/api/projects/${project.id}/timeline-export`, 'POST', { shot_durations: {} })).status, 400);
  const pending = await call(`/api/projects/${project.id}/timeline-export`, 'POST', { shot_durations: { [shot.id]: 3000 } });
  assert.equal(pending.status, 400); assert.match(pending.data.error, /还没有读出长度/);
  await call(`/api/audio/versions/${clip.versions[0].id}`, 'PATCH', { duration_ms: 8000 });
  const manifest = (await call(`/api/projects/${project.id}/timeline-export`, 'POST', { shot_durations: { [shot.id]: 3000 } })).data;
  assert.equal(manifest.format, 'aicut-timeline'); assert.equal(manifest.duration_ms, 3000);
  assert.equal(manifest.video[0].kind, 'image'); assert.ok(manifest.video[0].path.startsWith(join(dir, 'data', 'media')));
  assert.deepEqual(manifest.subtitles.map(s => [s.start_ms, s.duration_ms, s.text]), [[0, 1500, 'one'], [1500, 1500, 'two']]);
  assert.deepEqual(manifest.audio[0].clips.map(c => [c.timeline_start_ms, c.source_start_ms, c.duration_ms]), [[500, 0, 8000]]);
});

test('deleting tracks and clips keeps media; backup and v5 upgrade keep audio', async () => {
  const { project, track } = await setup();
  const created = await send(`/api/audio/tracks/${track.id}/clips?filename=theme.wav`, 'keep me');
  const clip = clipOf(created.data, created.data.clip_id);
  await call(`/api/audio/clips/${clip.id}/regions`, 'PUT', { revision: clip.revision, regions: [{ start_ms: 0, end_ms: 1000, note: 'intro' }] });
  await backupData(join(dir, 'data'), join(dir, 'backup'));
  const restored = await createApp({ dataDir: join(dir, 'backup') });
  try { assert.equal(restored.audio.detail(project.id).tracks[0].clips[0].regions[0].note, 'intro'); } finally { await restored.runner.close(); restored.store.close(); }
  const media = (await readdir(join(dir, 'data', 'media'))).length;
  const second = (await call(`/api/projects/${project.id}/audio/tracks`, 'POST', { title: 'SFX', kind: 'sfx' })).data.tracks[1];
  const removed = await call(`/api/audio/tracks/${track.id}`, 'DELETE', { revision: track.revision });
  assert.equal(removed.status, 200); assert.deepEqual(removed.data.tracks.map(t => t.id), [second.id]);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM audio_versions').get().n, 0);
  assert.equal((await readdir(join(dir, 'data', 'media'))).length, media, 'media files stay');
  await app.close();
  const legacy = new DatabaseSync(join(dir, 'data', 'workbench.sqlite'));
  legacy.exec('DROP TABLE audio_regions; DROP TABLE audio_versions; DROP TABLE audio_clips; DROP TABLE audio_tracks; PRAGMA user_version=5;'); legacy.close();
  app = await createApp({ dataDir: join(dir, 'data') }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal(app.store.db.prepare('PRAGMA user_version').get().user_version, 6);
  assert.deepEqual(app.audio.detail(project.id).tracks, []);
  const snapshot = new DatabaseSync(join(dir, 'data', 'schema-v5-before-v6.sqlite'), { readOnly: true });
  try { assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 5); } finally { snapshot.close(); }
});
