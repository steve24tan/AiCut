// Shared "who does this" picker: live herdr agents plus a manual option (copy the instruction yourself).
const states = { idle: '空闲', done: '空闲', working: '工作中', blocked: '等确认', unknown: '状态未知' };
const KEY = 'aicut:agent-target';
let cache = null, fetchedAt = 0, pending = null;
export function agentInfo(api, force = false) {
  if (!force && cache && Date.now() - fetchedAt < 5000) return Promise.resolve(cache);
  pending ??= api('/api/herdr/agents').catch(() => ({ available: false, message: '无法读取 herdr agent 列表', agents: [] }))
    .then(info => { cache = info; fetchedAt = Date.now(); pending = null; return info; });
  return pending;
}
export const agentLabel = agent => `herdr · ${agent.name || agent.pane_id}（${agent.kind} · ${states[agent.status] || agent.status}）`;
function remembered() { try { return localStorage.getItem(KEY); } catch { return null; } }
export function remember(value) { try { localStorage.setItem(KEY, value); } catch { /* optional */ } }
// Fills a <select> with targets "herdr:<name>" and "manual"; keeps the user's last choice when still available.
export function targetSelect(api, label = 'AI 执行者') {
  const select = document.createElement('select'); select.className = 'target-select'; select.setAttribute('aria-label', label);
  select.add(new Option('手动 · 复制指令给任意 agent', 'manual'));
  agentInfo(api).then(info => {
    for (const agent of info.agents) {
      const option = new Option(agentLabel(agent), `herdr:${agent.target}`);
      if (['working', 'blocked'].includes(agent.status)) option.textContent += ' — 忙';
      select.add(option);
    }
    if (!info.available) select.title = info.message;
    const last = remembered(), first = info.agents.find(a => !['working', 'blocked'].includes(a.status));
    if (last && [...select.options].some(o => o.value === last)) select.value = last;
    else if (first) select.value = `herdr:${first.target}`;
  });
  select.addEventListener('change', () => remember(select.value));
  return select;
}
