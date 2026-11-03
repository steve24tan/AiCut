let ctx, providers = [], records = [], loading = false;
const labels = { queued: '排队中', running: 'CLI 作业中', completed: '已完成，待采用', failed: '执行失败', cancelled: '已取消', interrupted: '已中断，请重新推送', applied: '已采用' };
const names = { claude: 'Claude Code', codex: 'Codex CLI', manual: '外部 CLI 领取' };
export async function setupJobs(context) {
  ctx = context;
  try { providers = await ctx.api('/api/cli'); } catch { providers = []; }
  document.addEventListener('workbench-idle', () => { for (const card of document.querySelectorAll('.shot-card')) updateCard(card); });
  setInterval(() => { if (!document.hidden) refreshJobs().catch(() => {}); }, 1500);
}
export async function refreshJobs() {
  const project = ctx.getProject(); if (!project || loading) return;
  loading = true;
  try {
    const data = await ctx.api(`/api/jobs?project=${project.id}`);
    if (ctx.getProject()?.id !== project.id) return;
    records = data;
    for (const card of document.querySelectorAll('.shot-card')) updateCard(card);
  } finally { loading = false; }
}
export function bindJobCard(card, shot) {
  const box = document.createElement('div'); box.className = 'job-box';
  const row = document.createElement('div'); row.className = 'job-push-row';
  const select = document.createElement('select'); select.className = 'job-provider'; select.setAttribute('aria-label', '本段 CLI');
  for (const id of ['claude', 'codex', 'manual']) {
    const available = id === 'manual' || providers.find(p => p.id === id)?.available;
    const option = new Option(names[id] + (available ? '' : ' · 未安装'), id); option.disabled = !available; select.add(option);
  }
  select.value = providers.find(p => p.available)?.id || 'manual';
  const push = document.createElement('button'); push.className = 'push-job'; push.textContent = '推送任务 →';
  push.addEventListener('click', () => ctx.action(async () => {
    await ctx.api(`/api/shots/${shot.id}/jobs`, { method: 'POST', body: JSON.stringify({ revision: shot.revision, provider: select.value }) });
    await refreshJobs(); ctx.toast(select.value === 'manual' ? '已进入外部 CLI 待办队列' : '已交给本地 CLI；完成后可预览并采用');
  }));
  row.append(select, push);
  const status = document.createElement('div'); status.className = 'job-state'; status.setAttribute('role', 'status');
  const actions = document.createElement('div'); actions.className = 'job-actions';
  const hint = document.createElement('small'); hint.textContent = '推送会将本段文字交给 CLI 处理，使用其登录与额度；不附加视频文件。';
  box.append(row, status, actions, hint); card.append(box); updateCard(card);
}
function updateCard(card) {
  const state = card.querySelector('.job-state'), actions = card.querySelector('.job-actions'); if (!state) return;
  const items = records.filter(job => job.shot_id === card.dataset.id && job.project_id === ctx.getProject()?.id);
  const push = card.querySelector('.push-job');
  if (!document.body.hasAttribute('aria-busy')) push.disabled = items.some(j => ['queued', 'running'].includes(j.status));
  const key = JSON.stringify(items.map(job => [job.id, job.status, job.updated_at, job.error]));
  if (card.dataset.jobsKey === key) return;
  const previousSelection = actions.querySelector('select')?.value;
  card.dataset.jobsKey = key;
  const job = items[0]; actions.replaceChildren();
  state.textContent = job ? `${names[job.provider]} · ${labels[job.status]}${job.error ? ' · ' + job.error : ''}` : '尚未推送任务';
  if (!job) return;
  const history = document.createElement('select'); history.setAttribute('aria-label', '任务记录');
  for (const item of items) history.add(new Option(`${new Date(item.created_at).toLocaleTimeString()} · ${names[item.provider]} · ${labels[item.status]}`, item.id));
  if (items.some(item => item.id === previousSelection)) history.value = previousSelection;
  const view = document.createElement('button'); view.textContent = '查看任务 / 结果';
  view.addEventListener('click', async () => {
    try {
      const detail = await ctx.api(`/api/jobs/${history.value}`);
      ctx.textDialog('CLI 任务与结果', `任务 ID：${detail.id}\n执行器：${names[detail.provider]}\n状态：${labels[detail.status]}\n\n【推送时的片段内容】\n${JSON.stringify(detail.snapshot, null, 2)}\n\n【返回的修改稿】\n${detail.result?.revised_prompt || '尚无结果'}\n\n【修改说明】\n${detail.result?.summary || detail.error || ''}`, '任务保存推送时的快照。CLI 不会自动覆盖当前草稿；采用结果会保留旧文字快照。');
    } catch (error) { ctx.toast(error.message, true); }
  });
  actions.append(history, view);
  if (job.status === 'completed') {
    const apply = document.createElement('button'); apply.textContent = '采用结果'; apply.className = 'primary';
    apply.addEventListener('click', () => ctx.action(async () => {
      const shot = ctx.getProject().shots.find(s => s.id === job.shot_id);
      await ctx.api(`/api/jobs/${job.id}/apply`, { method: 'POST', body: JSON.stringify({ revision: shot.revision }) });
      await ctx.reload(shot.project_id); await refreshJobs(); ctx.toast('已更新本段 Prompt，旧文字已存快照，素材与备注保留');
    }));
    actions.append(apply);
  }
  if (['queued', 'running'].includes(job.status)) {
    const cancel = document.createElement('button'); cancel.textContent = '取消';
    cancel.addEventListener('click', () => ctx.action(async () => { await ctx.api(`/api/jobs/${job.id}/cancel`, { method: 'POST', body: '{}' }); await refreshJobs(); }));
    actions.append(cancel);
  }
}
