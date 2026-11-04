// Audio tasks for agents: per-clip processing, multi-clip mix, per-shot dubbing and BGM generation.
import { targetSelect } from './agents.js';
const $ = selector => document.querySelector(selector);
export const taskKinds = { process: '处理音频', mix: '混音', voice: '配音', music: '生成音乐' };
const labels = { queued: '等 agent 领取', running: 'agent 处理中', completed: '已完成', failed: '失败', cancelled: '已取消' };
let ctx, tasks = [], seen = new Map();
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }
const who = target => target === 'manual' ? '手动' : target.replace(/^herdr:/, 'herdr · ');
export function statusLine(task) { return task ? `${taskKinds[task.kind]} · ${who(task.target)} · ${labels[task.status]}${task.error ? ' · ' + task.error : ''}` : ''; }
async function push(payload, select) {
  const task = await ctx.api(`/api/projects/${ctx.getProject().id}/tasks`, { method: 'POST', body: JSON.stringify({ ...payload, target: select.value }) });
  await refreshTasks();
  if (task.target === 'manual') { ctx.copy(task.pointer); ctx.toast('已建立任务并复制指令：贴给任何 agent 即可'); }
  else ctx.toast(`已推送给 ${who(task.target)}；完成后新音频会出现在时间线，可 A/B 对比`);
  return task;
}
export async function refreshTasks() {
  const project = ctx.getProject(); if (!project) { tasks = []; return; }
  const list = await ctx.api(`/api/tasks?project=${project.id}`);
  if (ctx.getProject()?.id !== project.id) return;
  for (const task of list) {
    const before = seen.get(task.id);
    if (before && before !== task.status && ['completed', 'failed'].includes(task.status)) ctx.toast(`AI 任务${task.status === 'completed' ? '完成' : '失败'}：${task.title}`, task.status === 'failed');
    seen.set(task.id, task.status);
  }
  const changed = JSON.stringify(list.map(t => [t.id, t.status])) !== JSON.stringify(tasks.map(t => [t.id, t.status]));
  tasks = list;
  // Update status lines in place so a half-typed instruction is never redrawn away.
  if (changed) {
    for (const node of document.querySelectorAll('.task-state[data-clip]')) node.textContent = statusLine(latest(t => t.clip_ids.includes(node.dataset.clip))) || node.dataset.empty || '';
    for (const node of document.querySelectorAll('.task-state[data-shot]')) node.textContent = statusLine(latest(t => t.kind === 'voice' && t.shot_id === node.dataset.shot));
  }
  if ($('#tasks-dialog').open) renderTaskList();
}
const latest = predicate => tasks.find(predicate);
// Inspector block for one clip.
export function clipTaskSection(clip) {
  const box = el('div', 'task-box');
  box.append(el('strong', '', '交给 AI 处理这段音频'));
  const note = el('textarea'); note.rows = 2; note.maxLength = 5000; note.placeholder = '补充说明（可空）：例如「本地分轨处理，不要重新生成」或「用 ElevenLabs 重新生成框选这段」';
  const select = targetSelect(ctx.api);
  const go = el('button', 'primary', '推送处理任务 →');
  go.addEventListener('click', () => ctx.action(() => push({ kind: 'process', clip_id: clip.id, instruction: note.value }, select)));
  const row = el('div', 'task-row'); row.append(select, go);
  const state = el('small', 'task-state'); state.dataset.clip = clip.id; state.dataset.empty = '会带上整段修改要求、音频框选和本地文件路径。';
  state.textContent = statusLine(latest(t => t.clip_ids.includes(clip.id))) || state.dataset.empty;
  box.append(note, row, state); return box;
}
export function mixTaskSection(clips, tracks) {
  const box = el('div', 'task-box mix');
  box.append(el('strong', '', `混音 · 已选 ${clips.length} 段`), el('small', 'muted', clips.map(c => c.title).join(' + ') + '（Shift+点击 增减选择）'));
  const note = el('textarea'); note.rows = 2; note.maxLength = 5000; note.placeholder = '怎么混？例如：A 的 0:24 接 B 的 0:08，对齐拍子，在小节线交叉淡化 2 秒';
  const output = el('select'); output.setAttribute('aria-label', '输出到音轨');
  for (const track of tracks) output.add(new Option(`输出到：${track.title}`, track.id));
  const select = targetSelect(ctx.api);
  const go = el('button', 'primary', '推送混音任务 →');
  go.addEventListener('click', () => ctx.action(() => push({ kind: 'mix', clip_ids: clips.map(c => c.id), track_id: output.value, instruction: note.value }, select)));
  const row = el('div', 'task-row'); row.append(output, select, go);
  box.append(note, row); return box;
}
// Card button: dub this shot's dialogue onto the first voice track.
export function voiceTaskControls(shot) {
  const row = el('div', 'task-row voice-task');
  const select = targetSelect(ctx.api, '配音执行者');
  const go = el('button', '', '生成配音 →'); go.title = '把这一段的台词和角色声音交给 agent，配音会放到配音音轨上这一段的位置';
  const state = el('small', 'task-state', statusLine(latest(t => t.kind === 'voice' && t.shot_id === shot.id))); state.dataset.shot = shot.id;
  go.addEventListener('click', () => ctx.action(async () => {
    const track = ctx.getAudio()?.tracks.find(t => t.kind === 'voice');
    if (!track) throw new Error('先在时间线点「＋ 配音」建立配音音轨');
    await push({ kind: 'voice', shot_id: shot.id, track_id: track.id, timeline_offset_ms: ctx.shotStart(shot.id) }, select);
  }));
  row.append(select, go, state); return row;
}
function renderTaskList() {
  const list = $('#tasks-list'); list.replaceChildren();
  if (!tasks.length) list.append(el('p', '', '还没有 AI 任务。'));
  for (const task of tasks) {
    const item = el('div', `task-item ${task.status}`);
    const title = el('strong', '', task.title), meta = el('small', '', `${statusLine(task)} · ${new Date(task.created_at).toLocaleString()}`);
    const buttons = el('div', 'task-row');
    const view = el('button', '', '查看'); view.addEventListener('click', async () => {
      const detail = await ctx.api(`/api/tasks/${task.id}`);
      ctx.textDialog(task.title, `状态：${labels[detail.status]}\n执行者：${who(detail.target)}\n\n【给 agent 的指令】\n${detail.pointer}\n\n【任务内容】\n${JSON.stringify(detail.snapshot, null, 2)}\n\n【结果】\n${detail.result ? JSON.stringify(detail.result, null, 2) : detail.error || '尚无'}`, '任务内容在推送时固定。结果音频已作为新版本／新片段导回时间线。');
    });
    const copy = el('button', '', '复制指令'); copy.addEventListener('click', async () => ctx.copy((await ctx.api(`/api/tasks/${task.id}`)).pointer));
    buttons.append(view, copy);
    if (['queued', 'running'].includes(task.status)) {
      const cancel = el('button', '', '取消'); cancel.addEventListener('click', () => ctx.action(async () => { await ctx.api(`/api/tasks/${task.id}/cancel`, { method: 'POST', body: '{}' }); await refreshTasks(); }));
      buttons.append(cancel);
    }
    item.append(title, meta, buttons); list.append(item);
  }
}
export function setupTasks(context) {
  ctx = context;
  $('#editor-tasks').addEventListener('click', () => ctx.action(async () => { await refreshTasks(); renderTaskList(); $('#tasks-dialog').showModal(); }));
  $('#editor-music').addEventListener('click', () => {
    const tracks = (ctx.getAudio()?.tracks || []).filter(t => t.kind === 'bgm');
    if (!tracks.length) { ctx.toast('先点「＋ BGM」建立 BGM 音轨', true); return; }
    const output = $('#music-track'); output.replaceChildren(); for (const t of tracks) output.add(new Option(t.title, t.id));
    $('#music-offset').value = (ctx.getPlayhead() / 1000).toFixed(2);
    const fresh = targetSelect(ctx.api); fresh.id = 'music-target'; $('#music-target').replaceWith(fresh);
    $('#music-dialog').showModal(); $('#music-prompt').focus();
  });
  $('#music-form').addEventListener('submit', event => {
    event.preventDefault();
    ctx.action(async () => {
      await push({ kind: 'music', track_id: $('#music-track').value, instruction: $('#music-prompt').value, duration_ms: Math.round(Number($('#music-duration').value) * 1000), offset_ms: Math.max(0, Math.round(Number($('#music-offset').value) * 1000)) }, $('#music-target'));
      $('#music-dialog').close();
    });
  });
  setInterval(() => { if (ctx.getProject() && !document.hidden) refreshTasks().catch(() => {}); }, 3000);
}
