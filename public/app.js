import { setupSegments, bindSegmentCard, renderTimeline, rangeText } from './segments.js';
import { setupJobs, bindJobCard, refreshJobs } from './jobs.js';
import { setupLibrary, bindLibraryCard, referencesText } from './library.js';
const $ = selector => document.querySelector(selector);
const labels = { todo: '待生成', revise: '待微调', review: '待检查', approved: '已确认' };
let projects = [], project = null, filter = 'all', busy = false, uploadTarget = null;
let nameAction = null, toastTimer;
const edits = new Map();
async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'X-Workbench': '1', ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || '本地服务请求失败');
  return result;
}
function toast(message, error = false) {
  const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, error ? 6500 : 2800);
}
function saveState() {
  const values = [...edits.values()];
  const failed = values.some(e => e.error);
  const pending = values.some(e => e.saved < e.seq || e.running);
  $('#save-state').textContent = failed ? '保存失败 · 内容仍在页面，请先重试' : pending ? '正在保存到本地…' : '✓ 所有修改已保存到本地';
  $('#save-state').classList.toggle('error', failed);
  for (const [id, edit] of edits) {
    const el = document.querySelector(`[data-id="${id}"] .card-save`);
    if (el) { el.textContent = edit.error ? '保存失败 · 点此重试' : edit.saved < edit.seq || edit.running ? '保存中…' : '已保存'; el.classList.toggle('error', Boolean(edit.error)); }
  }
}
function shotById(id) { return project.shots.find(s => s.id === id); }
function markEdit(shot, field, value) {
  shot[field] = value;
  let edit = edits.get(shot.id);
  if (!edit) { edit = { seq: 0, saved: 0, timer: null, running: null, error: null, patch: {} }; edits.set(shot.id, edit); }
  edit.patch[field] = value; edit.seq++; edit.error = null;
  clearTimeout(edit.timer); edit.timer = setTimeout(() => flush(shot.id).catch(error => toast(error.message, true)), 650);
  saveState();
}
async function flush(id) {
  const edit = edits.get(id); if (!edit) return;
  clearTimeout(edit.timer);
  if (edit.running) { await edit.running; return flush(id); }
  if (edit.saved === edit.seq) return;
  const shot = shotById(id), seq = edit.seq, patch = { ...edit.patch, revision: shot.revision };
  edit.error = null;
  edit.running = api(`/api/shots/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then(updated => {
    shot.revision = updated.revision; shot.updated_at = updated.updated_at; edit.saved = seq;
  }).catch(error => { edit.error = error.message; throw error; }).finally(() => { edit.running = null; saveState(); });
  saveState(); await edit.running;
  if (edit.saved < edit.seq) await flush(id);
}
async function flushAll() { for (const id of edits.keys()) await flush(id); }
async function action(fn) {
  if (busy) return;
  busy = true;
  const controls = [...document.querySelectorAll('input,textarea,select,button')].filter(el => !el.disabled);
  controls.forEach(el => { el.disabled = true; });
  document.body.setAttribute('aria-busy', 'true');
  try { await flushAll(); await fn(); }
  catch (error) { toast(error.message, true); }
  finally {
    controls.filter(el => el.isConnected).forEach(el => { el.disabled = false; });
    busy = false; document.body.removeAttribute('aria-busy');
    document.dispatchEvent(new Event('workbench-idle'));
  }
}
function textDialog(title, content, description = '') {
  $('#text-heading').textContent = title; $('#text-description').textContent = description; $('#text-content').value = content;
  $('#text-dialog').showModal();
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制，可以直接发给 AI'); }
  catch { textDialog('复制修改请求', text, '浏览器未允许自动复制，请在下面全选并复制。'); $('#text-content').focus(); $('#text-content').select(); }
}
function requestText(shot) {
  const number = project.shots.indexOf(shot) + 1;
  const take = shot.takes.find(t => t.id === shot.active_take_id);
  const range = take?.end_ms != null ? `\n原视频范围：${rangeText(take)}（${take.filename}）` : '';
  return `项目：${project.title}\n片段：${String(number).padStart(2, '0')} · ${shot.title}\n采用版本：${take ? 'v' + take.number : '尚无'}${range}\n\n【当前 Prompt／内容草稿】\n${shot.prompt || '（未填写）'}\n\n【本段修改要求】\n${shot.notes || '（未填写）'}${referencesText(shot)}\n\n请根据以上要求修改这个片段，返回可直接使用的完整修改稿。修改范围限于本段，其他片段保持原样。`;
}
async function refreshProjects() { projects = await api('/api/projects'); renderProjects(); }
function renderProjects() {
  $('#projects').replaceChildren();
  for (const item of projects) {
    const button = document.createElement('button'); button.classList.toggle('active', project?.id === item.id);
    const name = document.createElement('span'); name.textContent = '▤  ' + item.title;
    const count = document.createElement('small'); count.textContent = item.shot_count;
    button.append(name, count); button.addEventListener('click', () => action(() => load(item.id))); $('#projects').append(button);
  }
}
async function load(id) {
  const next = await api(`/api/projects/${id}`);
  project = next; edits.clear(); renderProjects(); render(); saveState();
  await refreshJobs();
}
function render() {
  $('#project-title').textContent = project?.title || '你的下一段，从这里开始。';
  $('#project-description').textContent = project ? '逐段查看，随手记下修改，再把新版放回来。' : '每个片段，都有自己的想法、修改与版本。';
  for (const id of ['export', 'import-files', 'add-shot']) $('#' + id).disabled = !project;
  $('#total').textContent = project?.shots.length || 0;
  $('#empty').hidden = Boolean(project?.shots.length);
  $('#empty-create').textContent = project ? '添加第一个片段' : '创建第一个项目';
  $('#shots').replaceChildren();
  renderTimeline(project, id => action(async () => {
    filter = 'all'; updateFilters(); render();
    const card = document.querySelector(`[data-id="${id}"]`);
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.querySelector('textarea').focus({ preventScroll: true });
  }));
  if (!project) return;
  for (const [index, shot] of project.shots.entries()) {
    if (filter !== 'all' && shot.status !== filter) continue;
    const card = $('#shot-template').content.firstElementChild.cloneNode(true);
    card.dataset.id = shot.id; card.querySelector('.shot-number').textContent = String(index + 1).padStart(2, '0');
    for (const input of card.querySelectorAll('[data-field]')) {
      input.value = shot[input.dataset.field];
      input.addEventListener('input', () => markEdit(shot, input.dataset.field, input.value));
    }
    card.querySelector('.card-save').addEventListener('click', () => flush(shot.id).catch(error => toast(error.message, true)));
    const take = shot.takes.find(t => t.id === shot.active_take_id);
    if (take?.media_id) {
      const media = document.createElement(take.mime.startsWith('video/') ? 'video' : 'img');
      media.src = `/media/${take.media_id}`;
      if (media.tagName === 'VIDEO') { media.controls = true; media.preload = 'metadata'; }
      else media.alt = shot.title;
      media.addEventListener('error', () => {
        const warning = document.createElement('div'); warning.className = 'media-warning'; warning.textContent = '浏览器无法预览此编码。原文件已保存，可尝试 MP4 / H.264。'; card.querySelector('.media-stage').append(warning);
      });
      card.querySelector('.media-stage').replaceChildren(media);
    } else if (take) card.querySelector('.media-placeholder p').textContent = '文字快照 · v' + take.number;
    bindSegmentCard(card, shot, take);
    const select = card.querySelector('.take-select');
    if (!shot.takes.length) { select.add(new Option('尚无版本', '')); select.disabled = true; }
    for (const version of shot.takes) select.add(new Option(`v${version.number} · ${version.filename || '文字快照'}`, version.id));
    select.value = shot.active_take_id || '';
    select.addEventListener('change', () => action(async () => {
      await api(`/api/shots/${shot.id}`, { method: 'PATCH', body: JSON.stringify({ revision: shot.revision, active_take_id: select.value }) });
      await load(project.id); toast('已切换采用版本；下一版草稿保持原样');
    }));
    card.querySelector('.inspect-take').disabled = !take;
    card.querySelector('.inspect-take').addEventListener('click', () => {
      if (!take) return;
      textDialog(`v${take.number} · 版本快照`, `保存时间：${new Date(take.created_at).toLocaleString()}\n素材：${take.filename || '文字快照'}\n范围：${rangeText(take)}\n\n【Prompt】\n${take.prompt}\n\n【修改要求】\n${take.notes}`, '历史快照只读。切换采用版本不会覆盖正在编辑的草稿。');
    });
    card.querySelector('.copy-request').addEventListener('click', () => copy(requestText(shot)));
    card.querySelector('.snapshot').addEventListener('click', () => action(async () => {
      await api(`/api/shots/${shot.id}/snapshot`, { method: 'POST', body: JSON.stringify({ revision: shot.revision }) });
      await load(project.id); toast('已保存文字快照');
    }));
    card.querySelector('.import-take').addEventListener('click', () => { if (!busy) { uploadTarget = shot.id; $('#file-input').click(); } });
    card.querySelector('.move-up').disabled = index === 0;
    card.querySelector('.move-down').disabled = index === project.shots.length - 1;
    for (const [selector, delta] of [['.move-up', -1], ['.move-down', 1]]) card.querySelector(selector).addEventListener('click', () => action(async () => {
      const ids = project.shots.map(s => s.id); [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
      await api(`/api/projects/${project.id}/order`, { method: 'PUT', body: JSON.stringify({ ids }) }); await load(project.id);
    }));
    bindJobCard(card, shot);
    bindLibraryCard(card, shot);
    $('#shots').append(card);
  }
  if (!$('#shots').childElementCount && project.shots.length) {
    const message = document.createElement('p'); message.textContent = '这个筛选条件下还没有片段。'; $('#shots').append(message);
  }
  saveState();
}
function askName(kind) {
  if (busy) return;
  nameAction = kind; $('#name-heading').textContent = kind === 'project' ? '新建项目' : '添加片段';
  $('#name-input').value = kind === 'project' ? '' : `片段 ${String(project.shots.length + 1).padStart(2, '0')}`;
  $('#name-dialog').showModal(); $('#name-input').focus();
}
$('#new-project').addEventListener('click', () => askName('project'));
$('#add-shot').addEventListener('click', () => askName('shot'));
$('#empty-create').addEventListener('click', () => askName(project ? 'shot' : 'project'));
$('#name-form').addEventListener('submit', event => {
  event.preventDefault(); const title = $('#name-input').value.trim(); if (!title) return;
  action(async () => {
    if (nameAction === 'project') {
      const item = await api('/api/projects', { method: 'POST', body: JSON.stringify({ title }) });
      await refreshProjects(); filter = 'all'; updateFilters(); await load(item.id);
    } else {
      await api(`/api/projects/${project.id}/shots`, { method: 'POST', body: JSON.stringify({ title }) }); await refreshProjects(); await load(project.id);
    }
    $('#name-dialog').close();
  });
});
for (const el of document.querySelectorAll('[data-close]')) el.addEventListener('click', () => el.closest('dialog').close());
function updateFilters() { for (const el of document.querySelectorAll('[data-filter]')) el.classList.toggle('selected', el.dataset.filter === filter); }
for (const el of document.querySelectorAll('[data-filter]')) el.addEventListener('click', () => action(async () => { filter = el.dataset.filter; updateFilters(); render(); }));
$('#import-files').addEventListener('click', () => { if (!busy) { uploadTarget = null; $('#file-input').click(); } });
$('#file-input').addEventListener('change', event => {
  const files = [...event.target.files]; event.target.value = ''; if (!files.length) return;
  const target = uploadTarget;
  action(async () => {
    // Keep input disabled during upload so a later reload cannot discard newly typed edits.
    const controls = [...document.querySelectorAll('input,textarea,select,button')].filter(el => !el.disabled);
    controls.forEach(el => { el.disabled = true; });
    let completed = 0;
    try {
      for (const file of files) {
        if (file.size > 1024 ** 3) throw new Error(`${file.name} 超过 1 GB 上限`);
        toast(`正在导入 ${completed + 1}/${files.length}：${file.name}`);
        const shot = target ? shotById(target) : await api(`/api/projects/${project.id}/shots`, { method: 'POST', body: JSON.stringify({ title: file.name.replace(/\.[^.]+$/, '').slice(0, 200) || '新片段' }) });
        const result = await api(`/api/shots/${shot.id}/takes?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Shot-Revision': String(shot.revision) }, body: file });
        if (target) shot.revision = result.shot.revision;
        completed++;
      }
      toast(`已导入 ${completed} 个素材，原文件保留在本地`);
    } finally {
      controls.forEach(el => { el.disabled = false; });
      await refreshProjects(); await load(project.id);
    }
  });
});
$('#export').addEventListener('click', () => action(async () => {
  const text = `# ${project.title}\n\n` + project.shots.map(shot => requestText(shot) + `\n\n状态：${labels[shot.status]}`).join('\n\n---\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'shot-revisions.md'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出文字清单；素材备份请看使用说明');
}));
$('#help').addEventListener('click', () => textDialog('本地使用与备份', `1. 添加片段：可以先写文字，也可以一次导入多个视频／图片。\n2. 编辑 Prompt 和修改要求：停止输入约 0.65 秒后保存。顶部会提示保存状态。\n3. 复制本段修改请求：包含项目、片段、采用版本、当前草稿和修改要求。\n4. 导入新版：为当前草稿保存一个带素材的只读版本，旧版继续保留。\n5. 存快照：为当前文字存一个不带素材的版本。\n6. 选择采用版本：只切换预览，不覆盖下一版草稿。\n7. 视频卡片点 ✂ 分段：均分或在播放位置添加边界，各段共用原文件。调整范围存新版；单段循环可取消。目前不导出独立剪辑文件。\n\n数据位置：项目目录下 data/（SQLite 数据库与 media/ 素材）。\n备份：在项目目录运行 npm run backup。备份写入 backups/ 的时间戳目录。\n恢复：先停止服务，再把完整备份目录复制为一个新的数据目录，用 SHOT_DATA_DIR 指向它。不要只恢复 SQLite 文件。\n\n导出修改清单仅导出文字，不包含素材，不能替代完整备份。\n支持 MP4、WebM、MOV、PNG、JPG、WebP；视频能否播放取决于浏览器编码支持。\n核心管理可离线使用；可选 CLI 作业使用其订阅账号与网络连接。`, 'AiCut v0.5.1 · 本地分段创作工作台'));
window.addEventListener('beforeunload', event => {
  if ([...edits.values()].some(e => e.saved < e.seq || e.running) || busy) { event.preventDefault(); event.returnValue = ''; }
});
setupSegments({ action, api, toast, shotById, refresh: async id => { filter = 'all'; updateFilters(); await refreshProjects(); await load(id); } });
await setupJobs({ api, action, toast, textDialog, getProject: () => project, reload: load });
await setupLibrary({ api, action, toast, getProject: () => project, reload: load });
setInterval(async () => {
  const dirty = () => [...edits.values()].some(edit => edit.saved < edit.seq || edit.running);
  if (busy || dirty() || document.hidden || document.querySelector('dialog[open]')) return;
  const id = project?.id;
  try {
    if (!id) {
      const items = await api('/api/projects');
      if (!project && !busy && !document.querySelector('dialog[open]') && items.length) await action(async () => { projects = items; await load(items[0].id); });
      return;
    }
    const stamp = await api(`/api/projects/${id}/stamp`);
    if (project?.id !== id || busy || dirty() || document.querySelector('dialog[open]')) return;
    const current = project.shots.map(({ id, title, position, revision, active_take_id }) => ({ id, title, position, revision, active_take_id }));
    if (JSON.stringify(stamp) !== JSON.stringify(current)) await action(async () => { await refreshProjects(); await load(id); });
  } catch { /* A stopped server must not discard local unsaved edits. */ }
}, 1500);
try { await refreshProjects(); if (projects.length) await load(projects[0].id); else { render(); saveState(); } }
catch (error) { $('#save-state').textContent = '无法连接本地服务'; $('#save-state').classList.add('error'); toast(error.message, true); }
