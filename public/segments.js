const $ = selector => document.querySelector(selector);
let context, selection = null;
export const time = ms => `${(ms / 1000).toFixed(3).replace(/\.?0+$/, '')}s`;
export const rangeText = take => take?.end_ms != null ? `${time(take.start_ms)} → ${time(take.end_ms)}` : '完整视频';

export function setupSegments(handlers) {
  context = handlers;
  const video = $('#segment-video');
  function ready() {
    if (!selection) return;
    if (Number.isFinite(video.duration) && video.duration > 0) {
      selection.duration = selection.take.duration_ms ?? Math.round(video.duration * 1000);
      selection.start = selection.take.start_ms ?? 0;
      selection.end = selection.take.end_ms ?? selection.duration;
      if (!selection.initialized) {
        selection.initialized = true;
        $('#trim-start').value = selection.start / 1000; $('#trim-end').value = selection.end / 1000;
        video.currentTime = selection.start / 1000;
        if (selection.mode === 'split') equalSplit(); else renderCuts();
      }
    }
  }
  video.addEventListener('loadedmetadata', () => {
    if (video.duration === Infinity) video.currentTime = 1e10;
    ready();
  });
  video.addEventListener('durationchange', ready);
  video.addEventListener('seeked', ready);
  video.addEventListener('error', () => { $('#segment-summary').textContent = '视频无法读取，请检查浏览器是否支持这个编码。'; });
  $('#equal-split').addEventListener('click', equalSplit);
  $('#cut-here').addEventListener('click', () => {
    if (!selection?.initialized) return;
    const point = Math.round(video.currentTime * 1000);
    if (point - selection.start < 100 || selection.end - point < 100 || selection.cuts.some(cut => Math.abs(cut - point) < 100)) {
      context.toast('分割点之间至少保留 0.1 秒', true); return;
    }
    if (selection.cuts.length >= 99) { context.toast('一次最多分成 100 段', true); return; }
    selection.cuts.push(point); selection.cuts.sort((a, b) => a - b); renderCuts();
  });
  for (const id of ['trim-start', 'trim-end']) $('#' + id).addEventListener('input', renderCuts);
  $('#segment-dialog').addEventListener('close', () => { video.pause(); video.removeAttribute('src'); video.load(); selection = null; });
  document.addEventListener('workbench-idle', () => { if (selection) updateSummary(); });
  $('#apply-segments').addEventListener('click', () => context.action(async () => {
    if (!valid()) throw new Error('请检查时间边界，每段至少 0.1 秒');
    const shot = context.shotById(selection.shotId);
    const payload = { revision: shot.revision, duration_ms: selection.duration };
    if (selection.mode === 'split') payload.cuts_ms = selection.cuts;
    else { payload.start_ms = Number($('#trim-start').value) * 1000; payload.end_ms = Number($('#trim-end').value) * 1000; }
    if (selection.mode === 'trim') { payload.start_ms = Math.round(payload.start_ms); payload.end_ms = Math.round(payload.end_ms); }
    await context.api(`/api/shots/${shot.id}/${selection.mode}`, { method: 'POST', body: JSON.stringify(payload) });
    const mode = selection.mode;
    $('#segment-dialog').close();
    await context.refresh(shot.project_id);
    context.toast(mode === 'split' ? '分段已保存，每段可独立备注；原视频保留在历史版本' : '范围已保存为新版，旧范围仍在历史版本');
  }));
}
function equalSplit() {
  if (!selection?.initialized) return;
  const count = Number($('#segment-count').value);
  if (!Number.isInteger(count) || count < 2 || count > 100) { context.toast('请输入 2–100 的段数', true); return; }
  if ((selection.end - selection.start) / count < 100) { context.toast('每段至少 0.1 秒，请减少段数', true); return; }
  selection.cuts = Array.from({ length: count - 1 }, (_, n) => Math.round(selection.start + (selection.end - selection.start) * (n + 1) / count));
  renderCuts();
}
function valid() {
  if (!selection?.initialized) return false;
  const bounds = selection.mode === 'split' ? [selection.start, ...selection.cuts, selection.end] : [Math.round(Number($('#trim-start').value) * 1000), Math.round(Number($('#trim-end').value) * 1000)];
  return (selection.mode !== 'split' || selection.cuts.length > 0) && bounds.every((n, i) => Number.isSafeInteger(n) && n >= 0 && n <= selection.duration && (!i || n - bounds[i - 1] >= 100));
}
function renderCuts() {
  if (!selection) return;
  const list = $('#cut-list'); list.replaceChildren();
  if (selection.mode === 'split' && selection.initialized) {
    selection.cuts.forEach((cut, index) => {
      const row = document.createElement('div'); row.className = 'cut-row';
      const label = document.createElement('label'); label.textContent = `边界 ${index + 1}（秒）`;
      const input = document.createElement('input'); input.type = 'number'; input.step = '0.001'; input.value = cut / 1000; input.setAttribute('aria-label', `边界 ${index + 1}（秒）`);
      input.addEventListener('input', () => { selection.cuts[index] = input.value.trim() ? Math.round(Number(input.value) * 1000) : NaN; updateSummary(); });
      const seek = document.createElement('button'); seek.textContent = '预览'; seek.addEventListener('click', () => { if (Number.isFinite(selection.cuts[index])) $('#segment-video').currentTime = selection.cuts[index] / 1000; });
      const remove = document.createElement('button'); remove.textContent = '移除'; remove.addEventListener('click', () => { selection.cuts.splice(index, 1); renderCuts(); });
      label.append(input); row.append(label, seek, remove); list.append(row);
    });
  }
  updateSummary();
}
function updateSummary() {
  const okay = valid(); $('#apply-segments').disabled = !okay;
  $('#segment-summary').textContent = !selection?.initialized ? '正在读取视频时长…' : !okay ? '边界须按顺序排列、不能超出范围，每段至少 0.1 秒。' : selection.mode === 'split' ? `${time(selection.start)} → ${time(selection.end)}，共 ${selection.cuts.length + 1} 段。保存后各段独立备注，共用原文件。` : `新范围 ${$('#trim-start').value}s → ${$('#trim-end').value}s；原范围保留为历史版本。`;
}
function open(shot, take, mode) {
  selection = { shotId: shot.id, take, mode, initialized: false, cuts: [] };
  $('#segment-heading').textContent = mode === 'split' ? '视频分段' : '调整本段范围';
  $('#segment-description').textContent = mode === 'split' ? '先均分，再修改边界；也可以播放视频，在当前画面添加分割点。第一段沿用当前卡片，其余段紧接在后。' : '输入原视频中的开始／结束秒数。保存会创建一个新版本，不覆盖历史。';
  $('#trim-fields').hidden = mode !== 'trim'; $('.segment-tools').hidden = mode !== 'split';
  $('#cut-list').replaceChildren(); $('#apply-segments').disabled = true;
  $('#segment-summary').textContent = '正在读取视频时长…';
  $('#segment-video').src = `/media/${take.media_id}`;
  $('#segment-dialog').showModal();
}

export function bindSegmentCard(card, shot, take) {
  if (!take?.mime?.startsWith('video/')) return;
  const bar = card.querySelector('.range-bar'); bar.hidden = false;
  card.querySelector('.range-label').textContent = rangeText(take);
  card.querySelector('.split-video').addEventListener('click', () => context.action(() => open(shot, take, 'split')));
  card.querySelector('.trim-range').addEventListener('click', () => context.action(() => open(shot, take, 'trim')));
  const video = card.querySelector('video'), loop = card.querySelector('.loop-segment');
  if (take.end_ms == null) { loop.checked = false; loop.parentElement.hidden = true; return; }
  const start = take.start_ms / 1000, end = take.end_ms / 1000;
  video.addEventListener('loadedmetadata', () => { video.currentTime = start; });
  function check() {
    if (video.seeking) return;
    if (video.currentTime < start - 0.002) video.currentTime = start;
    if (video.currentTime >= end - 0.002) {
      if (loop.checked && !video.paused) video.currentTime = start;
      else { video.pause(); if (video.currentTime > end + 0.002) video.currentTime = end; }
    }
  }
  video.addEventListener('play', () => { if (video.currentTime >= end - 0.002 || video.currentTime < start) video.currentTime = start; });
  video.addEventListener('timeupdate', check);
  video.addEventListener('seeked', check);
  video.addEventListener('ended', () => { if (loop.checked) { video.currentTime = start; video.play().catch(() => {}); } });
  if (video.requestVideoFrameCallback) {
    const frame = () => { if (!video.isConnected) return; check(); video.requestVideoFrameCallback(frame); };
    video.requestVideoFrameCallback(frame);
  }
}

export function renderTimeline(project, select) {
  const nav = $('#timeline'); nav.replaceChildren();
  if (!project) return;
  project.shots.forEach((shot, index) => {
    const take = shot.takes.find(t => t.id === shot.active_take_id);
    const button = document.createElement('button'); button.textContent = `${String(index + 1).padStart(2, '0')} · ${shot.title}`;
    const label = document.createElement('small'); label.textContent = take?.mime?.startsWith('video/') ? rangeText(take) : '文字 / 图片'; button.append(label);
    button.addEventListener('click', () => select(shot.id)); nav.append(button);
  });
}
