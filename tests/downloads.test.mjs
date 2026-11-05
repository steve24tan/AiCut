import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { discoverYtdlp, ytdlpArgs } from '../src/downloads.mjs';
const fake = resolve('tests/fixtures/fake-ytdlp.mjs');
let app, dir, base;
async function start(options = { ytdlp: { command: process.execPath, prefix: [fake] } }) {
  app = await createApp({ dataDir: join(dir, 'data'), ...options }); await new Promise(done => app.server.listen(0, '127.0.0.1', done)); base = `http://127.0.0.1:${app.server.address().port}`;
}
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'shot-downloads-')); await start(); });
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
async function call(path, method = 'GET', body) { const response = await fetch(base + path, { method, headers: { 'X-Workbench': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() }; }
const project = async () => (await call('/api/projects', 'POST', { title: 'Downloads' })).data;
async function finished(id) {
  for (let n = 0; n < 100; n++) { const { data } = await call(`/api/downloads/${id}`); if (data.status !== 'running') return data; await new Promise(done => setTimeout(done, 50)); }
  throw new Error('download did not finish');
}
const leftovers = async () => (await readdir(join(dir, 'data', 'downloads')).catch(() => [])).length;

test('a video link becomes a new shot with the source in its notes', async () => {
  const p = await project();
  const started = await call(`/api/projects/${p.id}/downloads`, 'POST', { url: ' https://www.youtube.com/watch?v=abc ', kind: 'video' });
  assert.equal(started.status, 202); assert.equal(started.data.status, 'running');
  const done = await finished(started.data.id);
  assert.equal(done.status, 'done', done.error); assert.equal(done.progress, 100);
  const shot = app.store.detail(p.id).shots[0];
  assert.equal(shot.id, done.result.shot_id); assert.equal(shot.title, '测试视频_ A_B');
  assert.equal(shot.takes.length, 1); assert.equal(shot.takes[0].mime, 'video/mp4');
  assert.equal(shot.notes, '来源：https://www.youtube.com/watch?v=abc\n作者：Some Channel');
  const media = app.store.media(shot.takes[0].media_id);
  assert.equal(media.filename, '测试视频_ A_B.mp4');
  assert.equal(await readFile(join(dir, 'data', 'media', media.stored_name), 'utf8'), 'fake mp4 bytes');
  assert.equal(await leftovers(), 0, 'download folder is removed');
  assert.deepEqual((await call(`/api/downloads?project=${p.id}`)).data.items.map(i => i.id), [done.id]);
  assert.equal((await call('/api/downloads?project=other')).data.items.length, 0);
});

test('an audio link becomes a library asset with provenance', async () => {
  const p = await project();
  const done = await finished((await call(`/api/projects/${p.id}/downloads`, 'POST', { url: 'https://www.tiktok.com/@a/video/1', kind: 'audio' })).data.id);
  assert.equal(done.status, 'done', done.error);
  const asset = app.library.list().find(a => a.id === done.result.asset_id);
  assert.deepEqual([asset.title, asset.mime, asset.source_url, asset.author], ['测试视频_ A_B', 'audio/mpeg', 'https://www.tiktok.com/@a/video/1', 'Some Channel']);
  assert.equal(app.store.detail(p.id).shots.length, 0, 'audio does not create shots');
});

test('failures, cancellation and files outside the download folder leave nothing behind', async () => {
  const p = await project(), go = async url => (await call(`/api/projects/${p.id}/downloads`, 'POST', { url })).data.id;
  const failed = await finished(await go('https://www.youtube.com/watch?v=fail'));
  assert.deepEqual([failed.status, failed.error], ['failed', '[youtube] abc: Video unavailable']);
  const escaped = await finished(await go('https://example.com/escape'));
  assert.equal(escaped.status, 'failed'); assert.match(escaped.error, /不在下载目录/);
  const wrongType = await finished(await go('https://example.com/webm'));
  assert.equal(wrongType.status, 'failed'); assert.match(wrongType.error, /ffmpeg/);
  const slow = await go('https://example.com/slow');
  for (let n = 0; n < 40 && (await call(`/api/downloads/${slow}`)).data.progress === 0; n++) await new Promise(done => setTimeout(done, 50));
  assert.equal((await call(`/api/downloads/${slow}`)).data.progress, 12.5, 'progress lines are parsed while running');
  assert.equal((await call(`/api/downloads/${slow}/cancel`, 'POST', {})).data.status, 'cancelled');
  assert.equal((await finished(slow)).status, 'cancelled');
  assert.equal(app.store.detail(p.id).shots.length, 0);
  assert.equal((await readdir(join(dir, 'data', 'media'))).length, 0);
  await new Promise(done => setTimeout(done, 200));
  assert.equal(await leftovers(), 0);
});

test('links, kinds and a missing yt-dlp are rejected before anything runs', async () => {
  const p = await project();
  for (const body of [{ url: 'ftp://example.com/a' }, { url: 'not a link' }, { url: 7 }, { url: 'https://example.com', kind: 'gif' }]) {
    assert.equal((await call(`/api/projects/${p.id}/downloads`, 'POST', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call('/api/projects/nope/downloads', 'POST', { url: 'https://example.com' })).status, 404);
  assert.equal((await call('/api/downloads/nope')).status, 404);
  await app.close(); const saved = process.env.SHOT_YTDLP_BIN; process.env.SHOT_YTDLP_BIN = join(dir, 'missing', 'yt-dlp.exe');
  try {
    await start({});
    assert.equal((await call('/api/downloads')).data.available, false);
    assert.equal((await call(`/api/projects/${p.id}/downloads`, 'POST', { url: 'https://example.com' })).status, 503);
  } finally { if (saved === undefined) delete process.env.SHOT_YTDLP_BIN; else process.env.SHOT_YTDLP_BIN = saved; }
});

test('yt-dlp discovery and arguments', () => {
  assert.equal(discoverYtdlp({ SHOT_YTDLP_BIN: 'relative/yt-dlp.exe' }), null);
  assert.equal(discoverYtdlp({ SHOT_YTDLP_BIN: resolve('start.cmd') }), null, 'shell wrappers are refused');
  assert.deepEqual(discoverYtdlp({ SHOT_YTDLP_BIN: fake }), { command: process.execPath, prefix: [fake] });
  assert.equal(discoverYtdlp({ PATH: dir }), null);
  const video = ytdlpArgs('video', 'https://x.test/-v', 'D:\\out', {});
  assert.deepEqual(video.slice(-2), ['--', 'https://x.test/-v'], 'the URL can never be read as an option');
  assert.ok(video.includes('--no-playlist') && video.includes('--merge-output-format') && !video.includes('-x'));
  const audio = ytdlpArgs('audio', 'https://x.test', 'D:\\out', { SHOT_YTDLP_COOKIES_BROWSER: 'firefox', SHOT_FFMPEG_BIN: 'C:\\ffmpeg\\bin' });
  assert.ok(audio.includes('-x') && audio[audio.indexOf('--audio-format') + 1] === 'mp3');
  assert.equal(audio[audio.indexOf('--cookies-from-browser') + 1], 'firefox'); assert.equal(audio[audio.indexOf('--ffmpeg-location') + 1], 'C:\\ffmpeg\\bin');
});
