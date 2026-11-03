import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server.mjs';
import { splitPayload, options } from '../src/import-command.mjs';

let app, dir, base;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shot-import-'));
  app = await createApp({ dataDir: join(dir, 'data') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
});
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
const cli = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, ['cli.mjs', ...args], { cwd: resolve('.'), env: { ...process.env, SHOT_WORKBENCH_URL: base } })).stdout);

test('CLI creates project, streams a spaced filename and splits 30 seconds into five shared-media segments', async () => {
  const project = await cli('projects', 'create', 'Local import project');
  const file = join(dir, 'source with spaces.mp4'); const original = Buffer.from('synthetic media upload fixture'); await writeFile(file, original);
  const result = await cli('import', project.id, file, '--segments', '5', '--duration', '30');
  assert.equal(result.segments, 5); assert.equal(result.project.shots.length, 5);
  assert.deepEqual(result.project.shots.map(shot => [shot.takes[0].start_ms, shot.takes[0].end_ms]), [[0,6000],[6000,12000],[12000,18000],[18000,24000],[24000,30000]]);
  assert.equal((await readdir(join(dir, 'data', 'media'))).length, 1);
  assert.deepEqual(await readFile(file), original);
  const divided = await cli('split', result.project.shots[1].id, '--segments', '2');
  assert.deepEqual(divided.shots.slice(1,3).map(shot => [shot.takes[0].start_ms,shot.takes[0].end_ms]), [[6000,9000],[9000,12000]]);
  const stamp = await (await fetch(`${base}/api/projects/${project.id}/stamp`)).json(); assert.equal(stamp.length, 6);
});

test('invalid splitting options do not create partial shots or copy files', async () => {
  const project = await cli('projects', 'create', 'Invalid import');
  const file = join(dir, 'source.mp4'); await writeFile(file, 'fixture');
  for (const extra of [['--segments','0','--duration','30'], ['--cuts','12,5','--duration','30'], ['--segments','5','--duration','bad'], ['--segments','5','--cuts','','--duration','30']]) {
    await assert.rejects(cli('import',project.id,file,...extra));
  }
  assert.equal(app.store.detail(project.id).shots.length, 0);
  assert.deepEqual(await readdir(join(dir,'data','media')),[]);
});

test('image import works without duration while cut times must be ordered and in range', async () => {
  const project = await cli('projects','create','Images');
  const file = join(dir,'image.png'); await writeFile(file,'image fixture');
  const imported = await cli('import',project.id,file); assert.equal(imported.segments,1);
  assert.equal(app.store.detail(project.id).shots[0].takes[0].filename,'image.png');
  await assert.rejects(cli('split',imported.shot_id,'--segments','2','--duration','30'));
  assert.deepEqual(splitPayload(options(['--cuts','5,12,18,25']),30000).cuts_ms,[5000,12000,18000,25000]);
  assert.throws(()=>splitPayload(options(['--segments','5']),300),/0.1 seconds/);
});

test('missing duration probe fails before upload rather than guessing a timeline', async () => {
  const project = await cli('projects','create','Probe required');
  const file = join(dir,'unknown.mp4'); await writeFile(file,'fixture');
  const previous = process.env.SHOT_FFPROBE_BIN; process.env.SHOT_FFPROBE_BIN = join(dir,'missing-ffprobe');
  try { await assert.rejects(cli('import',project.id,file,'--segments','5'), /No duration was guessed/); }
  finally { if(previous === undefined) delete process.env.SHOT_FFPROBE_BIN; else process.env.SHOT_FFPROBE_BIN = previous; }
  assert.equal(app.store.detail(project.id).shots.length,0);
});
