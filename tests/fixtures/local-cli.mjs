// Synthetic CLI protocol fixture. Does not call a model or use credentials.
import { writeFile } from 'node:fs/promises';
if (process.argv.includes('auth')) { console.log(JSON.stringify({ authMethod: process.env.SHOT_TEST_API_AUTH ? 'api_key' : 'claude.ai', loggedIn: true })); }
else if (process.argv.includes('login')) { console.log(process.env.SHOT_TEST_API_AUTH ? 'Logged in using an API key' : 'Logged in using ChatGPT'); }
else {
  let text = ''; for await (const chunk of process.stdin) text += chunk;
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) throw new Error('API environment was not stripped');
  if (!text.includes('TASK SNAPSHOT:')) throw new Error('Missing shot snapshot');
  const result = { revised_prompt: 'Synthetic revised prompt', summary: 'Synthetic CLI protocol completed' };
  if (process.argv.includes('exec')) {
    await writeFile(process.argv[process.argv.indexOf('--output-last-message') + 1], JSON.stringify(result));
  } else console.log(JSON.stringify({ structured_output: result, is_error: false }));
}
