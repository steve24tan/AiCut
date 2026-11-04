import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, delimiter, extname, isAbsolute } from 'node:path';
import { resultSchema, validateResult } from './jobs.mjs';

export function discoverCli(provider, env = process.env) {
  const override = env[provider === 'claude' ? 'SHOT_CLAUDE_BIN' : 'SHOT_CODEX_BIN'];
  if (override) {
    if (!isAbsolute(override) || !existsSync(override) || ['.cmd', '.bat', '.ps1'].includes(extname(override).toLowerCase())) return null;
    return /\.[mc]?js$/i.test(override) ? { command: process.execPath, prefix: [override] } : { command: override, prefix: [] };
  }
  for (const folder of (env.PATH || env.Path || '').split(delimiter).filter(Boolean)) {
    const binary = join(folder, provider + (process.platform === 'win32' ? '.exe' : ''));
    if (existsSync(binary)) return { command: binary, prefix: [] };
    const entries = provider === 'claude'
      ? [['@anthropic-ai', 'claude-code', 'bin', 'claude.exe'], ['@anthropic-ai', 'claude-code', 'cli.js']]
      : [['@openai', 'codex', 'bin', 'codex.js']];
    for (const pieces of entries) {
      const path = join(folder, 'node_modules', ...pieces);
      if (existsSync(path)) return path.endsWith('.js') ? { command: process.execPath, prefix: [path] } : { command: path, prefix: [] };
    }
  }
  return null;
}
export function childEnvironment(env = process.env) {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (/^(OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_BASE_URL|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))$/i.test(key)) delete result[key];
  }
  return result;
}
export function invocation(provider, folder) {
  if (provider === 'claude') return ['--print', '--tools', '', '--disable-slash-commands', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--output-format', 'json', '--json-schema', JSON.stringify(resultSchema)];
  return ['exec', '--ignore-user-config', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--output-schema', join(folder, 'schema.json'), '--output-last-message', join(folder, 'answer.json'), '-'];
}
export function instruction(job) {
  return `You are revising ONE shot's text prompt for the user's creative project.\nRead the immutable task snapshot below. Use its revision notes to rewrite the full prompt. Preserve details not requested to change. Do not change other shots. Do not run tools, edit files or claim to have generated/edited video. Video bytes are not attached. Return only JSON with revised_prompt and summary, in the user's language.\nIf snapshot.regions is non-empty, the user boxed areas of the frame (box_percent: left/top/width/height as % of the frame, origin top-left; times in ms relative to this segment, end_ms null = segment end). Apply each region's note only inside its box. The revised prompt must explicitly keep everything outside the boxes unchanged (composition, characters, background, camera, timing) and must not restyle or reframe the whole shot.\n\nTASK SNAPSHOT:\n${JSON.stringify(job.snapshot, null, 2)}\n`;
}
export async function subscriptionLogin(provider, cli, signal) {
  const text = await new Promise((resolve, reject) => {
    const child = spawn(cli.command, [...cli.prefix, ...(provider === 'claude' ? ['auth', 'status'] : ['login', 'status'])], { windowsHide: true, shell: false, env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const stop = () => child.kill();
    const timer = setTimeout(() => { stop(); reject(new Error('读取 CLI 登录状态超时')); }, 15000);
    signal.addEventListener('abort', stop, { once: true });
    const collect = chunk => { if (out.length < 64000) out += chunk; };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', error => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(error); });
    child.on('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', stop);
      if (signal.aborted) reject(new Error('任务已取消'));
      else if (code !== 0) reject(new Error('CLI 尚未登录，请先在终端完成订阅账号登录'));
      else resolve(out);
    });
    if (signal.aborted) stop();
  });
  if (provider === 'claude') {
    let status;
    try { status = JSON.parse(text); } catch { throw new Error('无法读取 Claude Code 登录类型，请升级 CLI 后重试'); }
    if (!['claude.ai', 'oauth_token'].includes(status.authMethod)) throw new Error('请使用 Claude 订阅登录；此入口不接受 API Key 或第三方计费登录');
  } else if (!/ChatGPT/i.test(text) || /API\s*key/i.test(text)) throw new Error('请使用 ChatGPT 账号登录 Codex；此入口不接受 API Key 登录');
  return true;
}
export async function executeNative(job, folder, signal) {
  const cli = discoverCli(job.provider);
  if (!cli) throw new Error('找不到本机 CLI。请安装、登录后重启本地服务，或选择外部 CLI 领取。');
  await subscriptionLogin(job.provider, cli, signal);
  const args = [...cli.prefix, ...invocation(job.provider, folder)];
  const output = await new Promise((resolve, reject) => {
    const child = spawn(cli.command, args, { cwd: folder, windowsHide: true, shell: false, detached: process.platform !== 'win32', env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, stopped = false, terminationError = null;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    function stop() {
      if (stopped || !child.pid) return; stopped = true;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } }
    }
    const abort = () => { terminationError = new Error('任务已取消或本地服务已停止'); stop(); };
    const timer = setTimeout(() => { terminationError = new Error('CLI 执行超过 10 分钟，已停止；未自动重试'); stop(); }, 10 * 60 * 1000);
    signal.addEventListener('abort', abort, { once: true });
    const collect = target => chunk => {
      size += Buffer.byteLength(chunk);
      if (size > 1024 * 1024) { terminationError = new Error('CLI 输出超过 1 MB 上限'); stop(); return; }
      if (target === 'out') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error); });
    child.on('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (terminationError) { reject(terminationError); return; }
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`CLI 退出码 ${code}。请检查本机 CLI 的登录、额度及版本；未自动重试。`));
    });
    if (signal.aborted) abort(); else child.stdin.end(instruction(job));
  });
  await writeFile(join(folder, 'stdout.txt'), output.stdout);
  // No auth files or environment values are read or copied to the task directory.
  await writeFile(join(folder, 'stderr.txt'), output.stderr);
  if (job.provider === 'codex') {
    if ((await stat(join(folder, 'answer.json'))).size > 300000) throw new Error('CLI 返回的结果过大');
    return validateResult(JSON.parse(await readFile(join(folder, 'answer.json'), 'utf8')));
  }
  const response = JSON.parse(output.stdout);
  if (response.is_error) throw new Error('Claude Code 返回失败结果，请检查登录、额度及 CLI 版本');
  return validateResult(response.structured_output ?? JSON.parse(response.result));
}

export function createRunner(jobs, dataDir, { executor = executeNative } = {}) {
  jobs.recover();
  let closing = false, running = null, pending = null;
  const queue = [];
  async function drain() {
    while (!closing && queue.length) {
      const id = queue.shift(); let job;
      try { job = jobs.start(id); } catch { continue; }
      const controller = new AbortController(); running = { id, controller };
      try {
        const folder = join(dataDir, 'jobs', id); await mkdir(folder, { recursive: true });
        await writeFile(join(folder, 'task.json'), JSON.stringify(job.snapshot, null, 2));
        await writeFile(join(folder, 'request.txt'), instruction(job));
        await writeFile(join(folder, 'schema.json'), JSON.stringify(resultSchema));
        const result = await executor(job, folder, controller.signal);
        if (!closing && jobs.get(id).status === 'running') {
          await writeFile(join(folder, 'result.json'), JSON.stringify(validateResult(result), null, 2));
          jobs.complete(id, result);
        }
      } catch (error) { if (!closing) jobs.fail(id, error.message); }
      finally { running = null; }
    }
  }
  return {
    providers: () => ['claude', 'codex'].map(provider => ({ id: provider, available: executor !== executeNative || Boolean(discoverCli(provider)) })),
    submit(id) {
      queue.push(id);
      if (!pending) pending = Promise.resolve().then(drain).finally(() => { pending = null; });
    },
    cancel(id) { const result = jobs.cancel(id); if (running?.id === id) running.controller.abort(); return result; },
    async close() { closing = true; running?.controller.abort(); if (pending) await pending; jobs.recover(); }
  };
}
