#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { importFile, splitExisting, options } from './src/import-command.mjs';

const args = process.argv.slice(2), base = process.env.SHOT_WORKBENCH_URL || 'http://127.0.0.1:4317';
const url = new URL(base);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('SHOT_WORKBENCH_URL must be a local HTTP URL');
async function call(path, method = 'GET', body) {
  const res = await fetch(new URL(path, url), { method, headers: { 'X-Workbench': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await res.json(); if (!res.ok) throw new Error(value.error || `HTTP ${res.status}`); return value;
}
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
  else if (group === 'jobs' && id && command === 'complete' && option === '--file' && file) {
    result = await call(`/api/jobs/${encodeURIComponent(id)}/complete`, 'POST', JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')));
  } else {
    console.log('Usage (local server must be running):\n  node cli.mjs projects\n  node cli.mjs projects create NAME\n  node cli.mjs import PROJECT_ID FILE [--segments 5] [--duration 30]\n  node cli.mjs split SHOT_ID --segments 5 [--duration 30]\n  node cli.mjs split SHOT_ID --cuts 5,12,18,25 --duration 30\n  node cli.mjs shots PROJECT_ID\n  node cli.mjs jobs list\n  node cli.mjs jobs read JOB_ID\n  node cli.mjs jobs claim JOB_ID\n  node cli.mjs jobs complete JOB_ID --file result.json\n  node cli.mjs jobs cancel JOB_ID\n\nresult.json: {"revised_prompt":"full revised prompt","summary":"changes made"}\nChoose manual/external CLI in the UI to use claim and complete. Results require adoption in the UI.');
    process.exitCode = args.length ? 1 : 0;
  }
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
