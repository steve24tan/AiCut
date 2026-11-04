import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { createHerdr, discoverHerdr } from '../src/herdr.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/fake-herdr.mjs', import.meta.url));
let app, dir, base, log;
const agents = [{ name: 'lead', pane_id: 'w1:p1', agent: 'claude', agent_status: 'idle', cwd: 'D:/GA' }, { name: 'astra', pane_id: 'w1:p2', agent: 'codex', agent_status: 'working' }, { name: null, pane_id: 'w1:p3', agent: 'codex', agent_status: 'blocked' }];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shot-tasks-')); log = join(dir, 'prompts.log');
  Object.assign(process.env, { FAKE_HERDR_AGENTS: JSON.stringify(agents), FAKE_HERDR_LOG: log }); delete process.env.FAKE_HERDR_DOWN;
  app = await createApp({ dataDir: join(dir, 'data'), herdr: createHerdr(discoverHerdr({ SHOT_HERDR_BIN: fake })) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
});
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
async function call(path, method = 'GET', body) { const response = await fetch(base + path, { method, headers: { 'X-Workbench': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() }; }
const prompts = async () => existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) : [];
const cli = (...args) => promisify(execFile)(process.execPath, ['cli.mjs', ...args], { cwd: root, env: { ...process.env, SHOT_WORKBENCH_URL: base } }).then(r => JSON.parse(r.stdout));
async function setup() {
  const project = (await call('/api/projects', 'POST', { title: 'Task project' })).data;
  const bgm = (await call(`/api/projects/${project.id}/audio/tracks`, 'POST', { title: 'BGM 1', kind: 'bgm' })).data.tracks[0];
  const response = await fetch(`${base}/api/audio/tracks/${bgm.id}/clips?filename=theme.wav`, { method: 'POST', headers: { 'X-Workbench': '1' }, body: 'original bytes' });
  const created = await response.json();
  const clip = created.tracks[0].clips[0];
  return { project, bgm, clip };
}

test('herdr agent discovery maps names, panes and states, and reports a stopped server', async () => {
  const listed = (await call('/api/herdr/agents')).data;
  assert.equal(listed.available, true);
  assert.deepEqual(listed.agents.map(a => [a.target, a.kind, a.status]), [['lead', 'claude', 'idle'], ['astra', 'codex', 'working'], ['w1:p3', 'codex', 'blocked']]);
  process.env.FAKE_HERDR_DOWN = '1';
  const down = (await call('/api/herdr/agents')).data;
  assert.equal(down.available, false); assert.match(down.message, /no herdr server is running/);
  assert.equal((await createHerdr(null).agents()).available, false);
});

test('process task: herdr pointer prompt, busy agents refused, full agent round trip through cli.mjs', async () => {
  const { project, clip } = await setup();
  await call(`/api/audio/clips/${clip.id}/regions`, 'PUT', { revision: clip.revision, regions: [{ start_ms: 8000, end_ms: 16000, note: '鼓点降低' }] });
  const pushed = await call(`/api/projects/${project.id}/tasks`, 'POST', { kind: 'process', clip_id: clip.id, instruction: '整体含蓄一点', target: 'herdr:lead' });
  assert.equal(pushed.status, 202); assert.equal(pushed.data.status, 'queued');
  const task = pushed.data;
  assert.equal(task.snapshot.clip.regions[0].note, '鼓点降低'); assert.equal(task.snapshot.instruction, '整体含蓄一点');
  assert.ok(existsSync(task.snapshot.clip.active_version.path), 'snapshot points at the local source file');
  const [sent] = await prompts();
  assert.equal(sent.target, 'lead'); assert.match(sent.text, new RegExp(`tasks read ${task.id}`)); assert.doesNotMatch(sent.text, /\n/);
  for (const busy of ['astra', 'w1:p3']) {
    const refused = await call(`/api/projects/${project.id}/tasks`, 'POST', { kind: 'process', clip_id: clip.id, target: `herdr:${busy}` });
    assert.equal(refused.status, 409);
  }
  assert.deepEqual((await call(`/api/tasks?project=${project.id}`)).data.map(t => t.status), ['failed', 'failed', 'queued'], 'refused pushes stay visible as failed');
  assert.equal((await call(`/api/projects/${project.id}/tasks`, 'POST', { kind: 'process', clip_id: clip.id, target: 'herdr:bad name' })).status, 400);
  // The agent side, exactly as the pointer prompt tells it.
  assert.equal((await cli('tasks', 'read', task.id)).snapshot.clip.id, clip.id);
  assert.equal((await cli('tasks', 'claim', task.id)).status, 'running');
  const output = join(dir, 'soft.wav'); await writeFile(output, 'processed bytes');
  const imported = await cli('audio', 'version', clip.id, output, '--note', '鼓 -9dB');
  const resultFile = join(dir, 'result.json');
  await writeFile(resultFile, JSON.stringify({ summary: '用分轨把鼓压低 9 dB', outputs: [{ clip_id: clip.id, version_id: imported.version_id }] }));
  assert.equal((await cli('tasks', 'complete', task.id, '--file', resultFile)).status, 'completed');
  const versions = app.audio.detail(project.id).tracks[0].clips[0].versions;
  assert.deepEqual(versions.map(v => [v.number, v.note]), [[2, '鼓 -9dB'], [1, '']]);
  assert.equal((await call(`/api/tasks/${task.id}/complete`, 'POST', { summary: 'again' })).status, 409);
});

test('voice, music and mix tasks validate input and deliver new clips', async () => {
  const { project, bgm, clip } = await setup();
  const voiceTrack = (await call(`/api/projects/${project.id}/audio/tracks`, 'POST', { title: '配音 1', kind: 'voice' })).data.tracks[1];
  const shot = (await call(`/api/projects/${project.id}/shots`, 'POST', { title: 'Opening' })).data;
  const lorraine = (await call(`/api/projects/${project.id}/characters`, 'POST', { name: 'Lorraine', voice_id: 'v-123' })).data[0];
  assert.equal((await call(`/api/projects/${project.id}/tasks`, 'POST', { kind: 'voice', shot_id: shot.id, track_id: voiceTrack.id, target: 'manual' })).status, 400, 'no lines yet');
  await call(`/api/shots/${shot.id}`, 'PATCH', { revision: shot.revision, lines: [{ character_id: lorraine.id, text: '欢迎！', delivery: '兴奋' }] });
  assert.equal((await call(`/api/projects/${project.id}/tasks`, 'POST', { kind: 'voice', shot_id: shot.id, track_id: bgm.id, target: 'manual' })).status, 400, 'voice needs a voice track');
  const voice = await call(`/api/projects/${project.id}/tasks`, 'POST', { kind: 'voice', shot_id: shot.id, track_id: voiceTrack.id, timeline_offset_ms: 2500, target: 'manual' });
  assert.equal(voice.status, 202); assert.deepEqual(voice.data.snapshot.lines[0], { character: 'Lorraine', provider: 'elevenlabs', voice_id: 'v-123', voice_notes: '', text: '欢迎！', delivery: '兴奋' });
  assert.equal(voice.data.snapshot.shot.timeline_offset_ms, 2500); assert.deepEqual(await prompts(), [], 'manual tasks type nothing into herdr');
  const line = join(dir, 'line.mp3'); await writeFile(line, 'voice bytes');
  const added = await cli('audio', 'add', voiceTrack.id, line, '--offset', '2.5', '--title', 'Lorraine · 欢迎');
  const voiceClip = app.audio.detail(project.id).tracks[1].clips.find(c => c.id === added.clip_id);
  assert.deepEqual([voiceClip.offset_ms, voiceClip.title], [2500, 'Lorraine · 欢迎']);
  for (const bad of [{ duration_ms: 1000, instruction: 'x' }, { duration_ms: 30000, instruction: ' ' }, { duration_ms: 30000, instruction: 'x', track_id: voiceTrack.id }]) {
    assert.equal((await call(`/api/projects/${project.id}/tasks`, 'POST', { kind: 'music', track_id: bgm.id, target: 'manual', ...bad })).status, 400);
  }
  const music = await call(`/api/projects/${project.id}/tasks`, 'POST', { kind: 'music', track_id: bgm.id, duration_ms: 30000, offset_ms: 4000, instruction: '轻快、递进的 lo-fi', target: 'herdr:lead' });
  assert.equal(music.status, 202); assert.match(music.data.snapshot.deliver, /--offset 4 /);
  assert.equal((await call(`/api/projects/${project.id}/tasks`, 'POST', { kind: 'mix', clip_ids: [clip.id], target: 'manual' })).status, 400);
  const mix = await call(`/api/projects/${project.id}/tasks`, 'POST', { kind: 'mix', clip_ids: [clip.id, voiceClip.id], instruction: '对齐拍子后交叉淡化', target: 'manual' });
  assert.equal(mix.status, 202); assert.equal(mix.data.snapshot.clips.length, 2);
  assert.equal((await call(`/api/projects/${project.id}/tasks`, 'POST', { kind: 'karaoke', target: 'manual' })).status, 400);
  assert.equal((await call(`/api/tasks/${mix.data.id}/fail`, 'POST', { message: '没有分轨模型' })).data.status, 'failed');
});

test('prompt revision jobs can go to a herdr agent and use the manual protocol', async () => {
  const project = (await call('/api/projects', 'POST', { title: 'Prompt project' })).data;
  const shot = (await call(`/api/projects/${project.id}/shots`, 'POST', { title: 'Shot' })).data;
  const job = await call(`/api/shots/${shot.id}/jobs`, 'POST', { revision: shot.revision, provider: 'herdr', target: 'lead' });
  assert.equal(job.status, 202); assert.equal(job.data.target, 'herdr:lead');
  assert.match((await prompts())[0].text, new RegExp(`jobs read ${job.data.id}`));
  assert.equal((await call(`/api/jobs/${job.data.id}/claim`, 'POST', {})).status, 200);
  assert.equal((await call(`/api/jobs/${job.data.id}/complete`, 'POST', { revised_prompt: 'better', summary: 'done' })).data.status, 'completed');
  const refused = await call(`/api/shots/${shot.id}/jobs`, 'POST', { revision: app.store.shot(shot.id).revision, provider: 'herdr', target: 'astra' });
  assert.equal(refused.status, 409);
  assert.equal(app.jobs.list(project.id)[0].status, 'failed', 'a refused push does not block the shot');
  const second = await call(`/api/shots/${shot.id}/jobs`, 'POST', { revision: app.store.shot(shot.id).revision, provider: 'herdr', target: 'lead' });
  assert.equal((await call(`/api/jobs/${second.data.id}/fail`, 'POST', { message: 'cannot' })).data.status, 'failed');
});
