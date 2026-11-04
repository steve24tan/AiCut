// Optional QA for the 剪映 export: AiCut manifest -> scripts/export_jianying.py -> draft_content.json.
// Needs AICUT_PYTHON (a Python with pyJianYingDraft) and AICUT_FFMPEG (any ffmpeg) to make synthetic media.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const { AICUT_PYTHON: python, AICUT_FFMPEG: ffmpeg } = process.env;
if (!python || !ffmpeg) { console.error('Set AICUT_PYTHON (with pyJianYingDraft) and AICUT_FFMPEG to run this QA.'); process.exit(1); }
const scratch = await mkdtemp(join(tmpdir(), 'shot-jianying-'));
const app = await createApp({ dataDir: join(scratch, 'data') });
try {
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, method = 'GET', body) => { const res = await fetch(base + path, { method, headers: { 'X-Workbench': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await res.json(); assert.ok(res.ok, JSON.stringify(data)); return data; };
  const upload = async (path, file, headers = {}) => { const res = await fetch(base + path, { method: 'POST', headers: { 'X-Workbench': '1', ...headers }, body: createReadStream(file), duplex: 'half' }); const data = await res.json(); assert.ok(res.ok, JSON.stringify(data)); return data; };
  const media = join(scratch, 'media-in'); await mkdir(media);
  const png = join(media, 'still.png'), mp4 = join(media, 'motion.mp4'), wav = join(media, 'bgm.wav');
  await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x2b3a4a:s=360x640', '-frames:v', '1', png]);
  await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=30:duration=4', '-pix_fmt', 'yuv420p', mp4]);
  await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', wav]);
  const project = await call('/api/projects', 'POST', { title: '剪映导出 QA' });
  const still = await call(`/api/projects/${project.id}/shots`, 'POST', { title: '开场' });
  await upload(`/api/shots/${still.id}/takes?filename=still.png`, png, { 'X-Shot-Revision': '0' });
  const moving = await call(`/api/projects/${project.id}/shots`, 'POST', { title: '动作' });
  const take = await upload(`/api/shots/${moving.id}/takes?filename=motion.mp4`, mp4, { 'X-Shot-Revision': '0' });
  const split = await call(`/api/shots/${moving.id}/split`, 'POST', { revision: take.shot.revision, duration_ms: 4000, cuts_ms: [2000] });
  const lorraine = (await call(`/api/projects/${project.id}/characters`, 'POST', { name: 'Lorraine' }))[0];
  const first = split.shots[1]; // shots[0] is the still; [1] is the first half of the split video
  await call(`/api/shots/${first.id}`, 'PATCH', { revision: app.store.shot(first.id).revision, lines: [{ character_id: lorraine.id, text: '歡迎來到 Grand Archive！' }, { text: '（三天後……）' }] });
  const bgm = (await call(`/api/projects/${project.id}/audio/tracks`, 'POST', { title: 'BGM 1', kind: 'bgm' })).tracks[0];
  await call(`/api/audio/tracks/${bgm.id}`, 'PATCH', { revision: bgm.revision, gain_db: -6 });
  const added = await upload(`/api/audio/tracks/${bgm.id}/clips?filename=bgm.wav&offset_ms=1000`, wav);
  const clip = added.tracks[0].clips[0];
  await call(`/api/audio/versions/${clip.versions[0].id}`, 'PATCH', { duration_ms: 6000 }); // what the browser reports after decoding
  await call(`/api/audio/clips/${clip.id}`, 'PATCH', { revision: clip.revision, in_ms: 500, out_ms: 4500 });
  // A second, overlapping clip on the same AiCut track must land on its own 剪映 lane.
  await upload(`/api/audio/tracks/${bgm.id}/clips?filename=bgm.wav&offset_ms=2000`, wav);
  for (const version of app.audio.detail(project.id).tracks[0].clips.flatMap(c => c.versions)) await call(`/api/audio/versions/${version.id}`, 'PATCH', { duration_ms: 6000 });
  const shots = app.store.detail(project.id).shots;
  const manifest = await call(`/api/projects/${project.id}/timeline-export`, 'POST', { shot_durations: Object.fromEntries(shots.map(s => [s.id, 2000])) });
  assert.deepEqual(manifest.video.map(v => [v.kind, v.timeline_start_ms, v.source_start_ms]), [['image', 0, null], ['video', 2000, 0], ['video', 4000, 2000]]);
  const manifestFile = join(scratch, 'qa.aicut-timeline.json'); await writeFile(manifestFile, JSON.stringify(manifest));
  const drafts = join(scratch, 'drafts'); await mkdir(drafts);
  const { stdout } = await run(python, [join(root, 'scripts', 'export_jianying.py'), manifestFile, '--drafts', drafts, '--name', 'QA 草稿']);
  assert.match(stdout, /Draft "QA 草稿" written/);
  const content = JSON.parse(await readFile(join(drafts, 'QA 草稿', 'draft_content.json'), 'utf8'));
  const tracks = content.tracks.map(t => [t.type, t.name, t.segments.length]);
  assert.deepEqual(tracks, [['video', '画面', 3], ['audio', 'BGM 1', 1], ['audio', 'BGM 1 (2)', 1], ['text', '台词', 2]]);
  const [video, audioTrack, , text] = content.tracks;
  assert.deepEqual(video.segments.map(s => [s.target_timerange.start, s.target_timerange.duration]), [[0, 2000000], [2000000, 2000000], [4000000, 2000000]]);
  assert.equal(video.segments[2].source_timerange.start, 2000000, 'second half of the split video starts at 2 s in the source');
  const bgmSegment = audioTrack.segments[0];
  assert.deepEqual([bgmSegment.target_timerange.start, bgmSegment.target_timerange.duration, bgmSegment.source_timerange.start], [1000000, 4000000, 500000]);
  assert.ok(Math.abs(bgmSegment.volume - 0.501) < 0.01, 'track gain -6 dB becomes volume ~0.5');
  const texts = content.materials.texts.map(m => JSON.parse(m.content).text);
  assert.deepEqual(texts, ['歡迎來到 Grand Archive！', '（三天後……）']);
  assert.deepEqual(text.segments.map(s => [s.target_timerange.start, s.target_timerange.duration]), [[2000000, 1000000], [3000000, 1000000]], 'lines share shot 2 time evenly');
  assert.equal(content.canvas_config.width, 1080); assert.equal(content.canvas_config.height, 1920);
  console.log(`PASS: manifest -> 剪映 draft (pyJianYingDraft) with still + split video, trimmed BGM at -6 dB, overlap lane, Traditional subtitles. Files: ${(await readdir(join(drafts, 'QA 草稿'))).join(', ')}`);
} finally {
  await app.close();
  const absolute = resolve(scratch);
  if (!absolute.startsWith(resolve(tmpdir()) + sep + 'shot-jianying-')) throw new Error('Refusing cleanup outside test scratch directory');
  await rm(absolute, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(error => console.error(`Test scratch cleanup incomplete: ${error.message}`));
}
