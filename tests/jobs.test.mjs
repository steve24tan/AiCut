import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server.mjs';
import { backupData } from '../scripts/backup.mjs';
import { executeNative, childEnvironment, invocation, subscriptionLogin } from '../src/runner.mjs';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

let app, dir, base;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('external CLI reads, claims and completes a queued shot task', async () => {
  const { shot } = await setup(); const job = (await enqueue(shot)).data;
  const run = async args => JSON.parse((await promisify(execFile)(process.execPath, ['cli.mjs', ...args], { cwd: resolve('.'), env: { ...process.env, SHOT_WORKBENCH_URL: base } })).stdout);
  assert.equal((await run(['jobs', 'read', job.id])).snapshot.shot.notes, 'slower turn');
  assert.equal((await run(['jobs', 'claim', job.id])).status, 'running');
  const file = join(dir, 'external-result.json');
  await writeFile(file, '\uFEFF' + JSON.stringify({ revised_prompt: 'external CLI result', summary: 'done' }));
  assert.equal((await run(['jobs', 'complete', job.id, '--file', file])).status, 'completed');
  assert.equal(app.store.shot(shot.id).prompt, 'base prompt');
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shot-jobs-'));
  app = await createApp({ dataDir: join(dir, 'data'), executor: async job => ({ revised_prompt: job.snapshot.shot.prompt + ' revised', summary: 'updated one shot' }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
});
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
async function call(path, method = 'GET', payload) {
  const response = await fetch(base + path, { method, headers: { 'X-Workbench': '1', 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: response.status, data: await response.json() };
}
async function setup() {
  const project = (await call('/api/projects', 'POST', { title: 'CLI project' })).data;
  const shot = (await call(`/api/projects/${project.id}/shots`, 'POST', { title: 'first' })).data;
  const saved = (await call(`/api/shots/${shot.id}`, 'PATCH', { revision: 0, prompt: 'base prompt', notes: 'slower turn' })).data;
  return { project, shot: saved };
}
async function enqueue(shot, provider = 'manual') { return call(`/api/shots/${shot.id}/jobs`, 'POST', { revision: shot.revision, provider }); }
async function waitJob(id, status = 'completed') {
  for (let n = 0; n < 100; n++) { const job = (await call(`/api/jobs/${id}`)).data; if (job.status === status) return job; await delay(20); }
  throw new Error('Job state timed out: ' + status);
}
test('native queue completes without changing draft; adopting creates old-text snapshot', async () => {
  const { shot, project } = await setup();
  const queued = await enqueue(shot, 'claude'); assert.equal(queued.status, 202);
  const done = await waitJob(queued.data.id);
  assert.equal(done.snapshot.shot.notes, 'slower turn');
  assert.equal(app.store.shot(shot.id).prompt, 'base prompt');
  const applied = await call(`/api/jobs/${done.id}/apply`, 'POST', { revision: shot.revision });
  assert.equal(applied.status, 200);
  assert.equal(app.store.shot(shot.id).prompt, 'base prompt revised');
  assert.equal(app.store.detail(project.id).shots[0].takes[0].prompt, 'base prompt');
  assert.equal(app.store.shot(shot.id).notes, 'slower turn');
  assert.equal((await call(`/api/jobs/${done.id}/apply`, 'POST', { revision: shot.revision + 1 })).status, 409);
});
test('manual CLI claim is exclusive; duplicate queue and stale apply cannot overwrite edits', async () => {
  const { shot } = await setup();
  const job = (await enqueue(shot)).data;
  assert.equal((await enqueue(shot)).status, 409);
  assert.equal((await call(`/api/jobs/${job.id}/claim`, 'POST', {})).status, 200);
  assert.equal((await call(`/api/jobs/${job.id}/claim`, 'POST', {})).status, 409);
  assert.equal((await call(`/api/jobs/${job.id}/complete`, 'POST', { revised_prompt: 'new', summary: 'change' })).status, 200);
  await call(`/api/shots/${shot.id}`, 'PATCH', { revision: shot.revision, notes: 'newer user edit' });
  assert.equal((await call(`/api/jobs/${job.id}/apply`, 'POST', { revision: shot.revision + 1 })).status, 409);
  assert.equal(app.store.shot(shot.id).prompt, 'base prompt');
  assert.equal(app.store.shot(shot.id).notes, 'newer user edit');
  assert.equal((await call(`/api/jobs/${job.id}`)).data.result.revised_prompt, 'new');
});
test('cancel and invalid results cannot be accepted as completed work', async () => {
  const { shot } = await setup();
  const first = (await enqueue(shot)).data;
  assert.equal((await call(`/api/jobs/${first.id}/complete`, 'POST', { revised_prompt: 'x', summary: 'x' })).status, 409);
  await call(`/api/jobs/${first.id}/claim`, 'POST', {});
  assert.equal((await call(`/api/jobs/${first.id}/complete`, 'POST', { revised_prompt: '', summary: 'empty' })).status, 400);
  assert.equal((await call(`/api/jobs/${first.id}/cancel`, 'POST', {})).status, 200);
  assert.equal((await call(`/api/jobs/${first.id}/complete`, 'POST', { revised_prompt: 'x', summary: 'x' })).status, 409);
  assert.equal((await call(`/api/jobs/${first.id}/apply`, 'POST', { revision: shot.revision })).status, 409);
});
test('runner errors are visible and restarting does not re-run jobs', async () => {
  const { shot } = await setup();
  await app.close();
  app = await createApp({ dataDir: join(dir, 'data'), executor: async () => { throw new Error('synthetic login failure'); } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
  const first = (await enqueue(shot, 'codex')).data;
  assert.match((await waitJob(first.id, 'failed')).error, /synthetic login failure/);
  const queued = (await enqueue(shot)).data;
  await call(`/api/jobs/${queued.id}/claim`, 'POST', {});
  await app.close();
  app = await createApp({ dataDir: join(dir, 'data'), executor: async () => { throw new Error('must not run'); } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await call(`/api/jobs/${queued.id}`)).data.status, 'interrupted');
});
test('job snapshots and results survive backup restore', async () => {
  const { shot } = await setup(); const job = (await enqueue(shot, 'codex')).data; await waitJob(job.id);
  await backupData(join(dir, 'data'), join(dir, 'backup'));
  const restored = await createApp({ dataDir: join(dir, 'backup') });
  try { assert.equal(restored.jobs.get(job.id).result.revised_prompt, 'base prompt revised'); assert.equal(restored.jobs.get(job.id).snapshot.shot.prompt, 'base prompt'); }
  finally { await restored.runner.close(); restored.store.close(); }
});
test('both native CLI protocols use stdin and subscription-style auth without shell execution', async () => {
  const { shot } = await setup();
  const original = { claude: process.env.SHOT_CLAUDE_BIN, codex: process.env.SHOT_CODEX_BIN };
  process.env.SHOT_CLAUDE_BIN = resolve('tests/fixtures/local-cli.mjs'); process.env.SHOT_CODEX_BIN = process.env.SHOT_CLAUDE_BIN;
  try {
    const job = (await enqueue(shot)).data;
    for (const provider of ['claude', 'codex']) {
      const result = await executeNative({ ...job, provider }, join(dir, 'data'), new AbortController().signal);
      assert.equal(result.revised_prompt, 'Synthetic revised prompt');
    }
    const env = childEnvironment({ OPENAI_API_KEY: 'fake', ANTHROPIC_API_KEY: 'fake', PATH: 'safe' });
    assert.deepEqual(env, { PATH: 'safe' });
    assert.ok(invocation('codex', dir).includes('read-only'));
    assert.ok(!invocation('claude', dir).some(arg => arg.includes('skip-permissions')));
  } finally {
    for (const provider of ['claude', 'codex']) { const key = provider === 'claude' ? 'SHOT_CLAUDE_BIN' : 'SHOT_CODEX_BIN'; if (original[provider] === undefined) delete process.env[key]; else process.env[key] = original[provider]; }
  }
});

test('native runner serializes tasks and cancellation releases the next job', async () => {
  const { shot, project } = await setup();
  const second = (await call(`/api/projects/${project.id}/shots`, 'POST', { title: 'second' })).data;
  await app.close(); let running = 0, maximum = 0;
  app = await createApp({ dataDir: join(dir, 'data'), executor: async (job, folder, signal) => {
    running++; maximum = Math.max(maximum, running);
    try {
      if (job.shot_id === shot.id) await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); if (signal.aborted) reject(new Error('cancelled')); });
      return { revised_prompt: 'second completed', summary: 'done' };
    } finally { running--; }
  } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
  const firstJob = (await enqueue(shot, 'claude')).data; await waitJob(firstJob.id, 'running');
  const secondJob = (await enqueue(second, 'codex')).data;
  assert.equal((await call(`/api/jobs/${secondJob.id}`)).data.status, 'queued');
  await call(`/api/jobs/${firstJob.id}/cancel`, 'POST', {});
  await waitJob(secondJob.id); assert.equal(maximum, 1);
  assert.equal((await call(`/api/jobs/${firstJob.id}`)).data.status, 'cancelled');
});

test('API-key login types are refused before any model request', async () => {
  const old = process.env.SHOT_TEST_API_AUTH; process.env.SHOT_TEST_API_AUTH = '1';
  const cli = { command: process.execPath, prefix: [resolve('tests/fixtures/local-cli.mjs')] };
  try { for (const provider of ['claude', 'codex']) await assert.rejects(subscriptionLogin(provider, cli, new AbortController().signal), /API Key/); }
  finally { if (old === undefined) delete process.env.SHOT_TEST_API_AUTH; else process.env.SHOT_TEST_API_AUTH = old; }
});

test('v2 upgrade preserves ranges and creates a pre-jobs database snapshot', async () => {
  const { shot, project } = await setup();
  await app.close();
  const legacy = new DatabaseSync(join(dir, 'data', 'workbench.sqlite'));
  legacy.exec('DROP TABLE jobs; PRAGMA user_version=2;'); legacy.close();
  app = await createApp({ dataDir: join(dir, 'data') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal(app.store.detail(project.id).shots[0].prompt, shot.prompt);
  assert.equal(app.store.db.prepare('PRAGMA user_version').get().user_version, 4);
  const backup = new DatabaseSync(join(dir, 'data', 'schema-v2-before-v3.sqlite'), { readOnly: true });
  try { assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 2); }
  finally { backup.close(); }
});
