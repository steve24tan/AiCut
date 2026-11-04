// Stand-in for the herdr CLI in tests: prints the same JSON envelopes and records prompts.
import { appendFileSync } from 'node:fs';
const [group, command, target, text] = process.argv.slice(2);
const agents = JSON.parse(process.env.FAKE_HERDR_AGENTS || '[]');
if (process.env.FAKE_HERDR_DOWN) {
  process.stderr.write(JSON.stringify({ id: 'cli:agent:list', error: { code: 'server_not_running', message: 'no herdr server is running' } }));
  process.exit(1);
}
if (group === 'agent' && command === 'list') {
  process.stdout.write(JSON.stringify({ id: 'cli:agent:list', result: { type: 'agent_list', agents } }));
} else if (group === 'agent' && command === 'prompt') {
  appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify({ target, text }) + '\n');
  process.stdout.write(JSON.stringify({ id: 'cli:agent:prompt', result: { type: 'agent_prompted', agent: agents.find(a => a.name === target) } }));
} else { process.stderr.write(JSON.stringify({ error: { code: 'unsupported', message: 'fake herdr: unsupported' } })); process.exit(2); }
