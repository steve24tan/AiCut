import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, delimiter, isAbsolute, extname } from 'node:path';
import { AppError } from './store.mjs';

// Talks to the user's running herdr server through its CLI. AiCut only lists agents and
// submits a short pointer prompt; the agent then reads/claims the task with cli.mjs.
export const TARGET = /^([a-z][a-z0-9_-]{0,31}|w\d+:p\d+)$/;
export function discoverHerdr(env = process.env) {
  const override = env.SHOT_HERDR_BIN;
  if (override) {
    if (!isAbsolute(override) || !existsSync(override) || ['.cmd', '.bat', '.ps1'].includes(extname(override).toLowerCase())) return null;
    return /\.[mc]?js$/i.test(override) ? { command: process.execPath, prefix: [override] } : { command: override, prefix: [] };
  }
  for (const folder of (env.PATH || env.Path || '').split(delimiter).filter(Boolean)) {
    const binary = join(folder, process.platform === 'win32' ? 'herdr.exe' : 'herdr');
    if (existsSync(binary)) return { command: binary, prefix: [] };
  }
  return null;
}
function parse(text) {
  try { return JSON.parse(text); } catch { return null; }
}
function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin.command, [...bin.prefix, ...args], { windowsHide: true, shell: false, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const out = parse(stdout), err = parse(stderr);
      if (error || out?.error || err?.error) reject(new Error((out?.error || err?.error)?.message || error?.message || 'herdr 命令失败'));
      else resolve(out?.result ?? out ?? {});
    });
  });
}
export function createHerdr(bin = discoverHerdr()) {
  async function agents() {
    if (!bin) return { available: false, message: '找不到 herdr。请安装 herdr，或用 SHOT_HERDR_BIN 指定 herdr 可执行文件后重启 AiCut。', agents: [] };
    try {
      const result = await run(bin, ['agent', 'list']);
      return { available: true, agents: (result.agents || []).map(item => ({
        target: item.name || item.pane_id, name: item.name || null, pane_id: item.pane_id,
        kind: item.display_agent || item.agent || 'agent', status: item.agent_status, cwd: item.cwd || item.foreground_cwd || null
      })).filter(item => TARGET.test(item.target)) };
    } catch (error) { return { available: false, message: `herdr 未连接：${error.message}`, agents: [] }; }
  }
  // Refuses to type into an agent that is busy or waiting on an approval dialog.
  async function prompt(target, text) {
    if (!TARGET.test(target)) throw new AppError(400, 'herdr agent 名称不正确');
    const list = await agents();
    if (!list.available) throw new AppError(503, list.message);
    const agent = list.agents.find(item => item.target === target);
    if (!agent) throw new AppError(404, `herdr 里找不到 agent「${target}」，请刷新列表`);
    if (agent.status === 'working') throw new AppError(409, `agent「${target}」正在工作，等它空下来再推送`);
    if (agent.status === 'blocked') throw new AppError(409, `agent「${target}」正在等确认，请先到 herdr 处理`);
    await run(bin, ['agent', 'prompt', target, text.replace(/\s*\n\s*/g, ' ')]);
    return agent;
  }
  return { agents, prompt };
}
