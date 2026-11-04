#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { importFile, splitExisting, options } from './src/import-command.mjs';
import { flags, addClip, addVersion } from './src/audio-command.mjs';

const args = process.argv.slice(2), base = process.env.SHOT_WORKBENCH_URL || 'http://127.0.0.1:4317';
const url = new URL(base);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('SHOT_WORKBENCH_URL must be a local HTTP URL');
async function call(path, method = 'GET', body) {
  const res = await fetch(new URL(path, url), { method, headers: { 'X-Workbench': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await res.json(); if (!res.ok) throw new Error(value.error || `HTTP ${res.status}`); return value;
}
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
try {
  let result;
  const [group, command, id, option, file] = args;
  if (group === 'projects' && command === 'create' && id) result = await call('/api/projects', 'POST', { title: args.slice(2).join(' ') });
  else if (group === 'projects' && !command) result = await call('/api/projects');
  else if (group === 'import' && command && id) result = await importFile({ projectId: command, file: id, opts: options(args.slice(3)), call, base: url });
  else if (group === 'split' && command) result = await splitExisting({ shotId: command, opts: options(args.slice(2)), call, base: url });
  else if (group === 'shots' && command) result = (await call(`/api/projects/${encodeURIComponent(command)}`)).shots;
  else if (group === 'jobs' && (!command || command === 'list')) result = await call('/api/jobs');
  else if (group === 'jobs' && id && command === 'read') result = await call(`/api/jobs/${encodeURIComponent(id)}`);
  else if (group === 'jobs' && id && ['claim', 'cancel'].includes(command)) result = await call(`/api/jobs/${encodeURIComponent(id)}/${command}`, 'POST', {});
  else if (group === 'jobs' && id && command === 'complete' && option === '--file' && file) result = await call(`/api/jobs/${encodeURIComponent(id)}/complete`, 'POST', await json(file));
  else if (group === 'jobs' && id && command === 'fail' && option === '--message' && file) result = await call(`/api/jobs/${encodeURIComponent(id)}/fail`, 'POST', { message: file });
  else if (group === 'tasks' && (!command || command === 'list')) result = await call(`/api/tasks${id ? '?project=' + encodeURIComponent(id) : ''}`);
  else if (group === 'tasks' && id && command === 'read') result = await call(`/api/tasks/${encodeURIComponent(id)}`);
  else if (group === 'tasks' && id && ['claim', 'cancel'].includes(command)) result = await call(`/api/tasks/${encodeURIComponent(id)}/${command}`, 'POST', {});
  else if (group === 'tasks' && id && command === 'complete' && option === '--file' && file) result = await call(`/api/tasks/${encodeURIComponent(id)}/complete`, 'POST', await json(file));
  else if (group === 'tasks' && id && command === 'fail' && option === '--message' && file) result = await call(`/api/tasks/${encodeURIComponent(id)}/fail`, 'POST', { message: file });
  else if (group === 'audio' && command === 'track' && id && option) {
    const opts = flags(args.slice(4), ['--kind']);
    result = await call(`/api/projects/${encodeURIComponent(id)}/audio/tracks`, 'POST', { title: option, kind: opts['--kind'] ?? 'bgm' });
  } else if (group === 'audio' && command === 'add' && id && option) result = await addClip({ trackId: id, input: option, opts: flags(args.slice(4), ['--offset', '--title', '--note']), base: url });
  else if (group === 'audio' && command === 'version' && id && option) result = await addVersion({ clipId: id, input: option, opts: flags(args.slice(4), ['--note']), call, base: url });
  else if (group === 'audio' && command && !id) result = await call(`/api/projects/${encodeURIComponent(command)}/audio`);
  else {
    console.log(`Usage (local server must be running):
  node cli.mjs projects
  node cli.mjs projects create NAME
  node cli.mjs import PROJECT_ID FILE [--segments 5] [--duration 30]
  node cli.mjs split SHOT_ID --segments 5 [--duration 30]
  node cli.mjs split SHOT_ID --cuts 5,12,18,25 --duration 30
  node cli.mjs shots PROJECT_ID

Prompt revision jobs (per shot):
  node cli.mjs jobs list | read JOB_ID | claim JOB_ID | cancel JOB_ID
  node cli.mjs jobs complete JOB_ID --file result.json   {"revised_prompt":"…","summary":"…"}
  node cli.mjs jobs fail JOB_ID --message "reason"

Audio tasks (process / mix / voice / music):
  node cli.mjs tasks list [PROJECT_ID] | read TASK_ID | claim TASK_ID | cancel TASK_ID
  node cli.mjs tasks complete TASK_ID --file result.json  {"summary":"…","outputs":[{"clip_id":"…","version_id":"…"}]}
  node cli.mjs tasks fail TASK_ID --message "reason"

Audio timeline:
  node cli.mjs audio PROJECT_ID
  node cli.mjs audio track PROJECT_ID NAME [--kind bgm|voice|sfx|other]
  node cli.mjs audio add TRACK_ID FILE [--offset SECONDS] [--title NAME] [--note TEXT]
  node cli.mjs audio version CLIP_ID FILE [--note TEXT]

Results never overwrite silently: new audio becomes a new version or clip that the user can A/B in the UI.`);
    process.exitCode = args.length ? 1 : 0;
  }
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
