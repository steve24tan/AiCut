// Frame regions: boxes the user draws on a shot's picture to say "only change this area".
// Coordinates are integers in 1/10000 of the frame; times are ms relative to the segment start.
const $ = selector => document.querySelector(selector);
const SCALE = 10000, MIN = 50, MAX_REGIONS = 20;
let ctx, draft = null, media = null, drawing = null;
const pct = value => (value / 100).toFixed(1).replace(/\.0$/, '');
const secs = ms => (ms / 1000).toFixed(3).replace(/\.?0+$/, '') + 's';
export function placement(box) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const col = cx < SCALE / 3 ? 0 : cx > SCALE * 2 / 3 ? 2 : 1, row = cy < SCALE / 3 ? 0 : cy > SCALE * 2 / 3 ? 2 : 1;
  return [['左上', '正上方', '右上'], ['左侧', '画面中央', '右侧'], ['左下', '正下方', '右下']][row][col];
}
const isVideo = take => take?.mime?.startsWith('video/');
const active = (box, rel) => rel == null || (rel >= box.start_ms && (box.end_ms == null || rel < box.end_ms));
export function regionsText(shot) {
  if (!shot.regions?.length) return '';
  const take = shot.takes.find(t => t.id === shot.active_take_id);
  const lines = shot.regions.map((box, index) => {
    const when = isVideo(take) ? ` · 本段 ${secs(box.start_ms)} → ${box.end_ms == null ? '段尾' : secs(box.end_ms)}` : '';
    return `#${index + 1} ${placement(box)} · 左 ${pct(box.x)}% 上 ${pct(box.y)}% 宽 ${pct(box.w)}% 高 ${pct(box.h)}%${when}\n要求：${box.note || '未填写'}`;
  });
  return `\n\n【画面框选 · 只改框内（坐标为画面百分比，原点在左上角）】\n${lines.join('\n')}\n框外：构图、角色、背景、镜头与节奏保持不变，不要重新构图或整体换风格。`;
}
function boxElement(box, index, className) {
  const el = document.createElement('div'); el.className = className;
  Object.assign(el.style, { left: box.x / 100 + '%', top: box.y / 100 + '%', width: box.w / 100 + '%', height: box.h / 100 + '%' });
  const badge = document.createElement('span'); badge.textContent = index + 1; el.append(badge);
  return el;
}
function relativeMs() {
  if (!isVideo(draft?.take) || !media) return null;
  return Math.round(media.currentTime * 1000) - (draft.take.start_ms ?? 0);
}
function segmentLength() {
  if (!isVideo(draft?.take)) return null;
  if (draft.take.end_ms != null) return draft.take.end_ms - draft.take.start_ms;
  return Number.isFinite(media?.duration) && media.duration > 0 ? Math.round(media.duration * 1000) : null;
}
function renderLayer() {
  const layer = $('#region-layer'); layer.replaceChildren();
  const rel = relativeMs();
  draft.items.forEach((box, index) => {
    const el = boxElement(box, index, 'region-box');
    el.classList.toggle('inactive', !active(box, rel)); el.classList.toggle('selected', draft.selected === index);
    layer.append(el);
  });
  if (drawing?.box) layer.append(boxElement(drawing.box, draft.items.length, 'region-box drawing'));
  if (isVideo(draft.take)) $('#region-time').textContent = `本段 ${secs(Math.max(0, rel ?? 0))}${segmentLength() ? ' / ' + secs(segmentLength()) : ''}`;
}
function renderList() {
  const list = $('#region-list'); list.replaceChildren();
  const video = isVideo(draft.take);
  draft.items.forEach((box, index) => {
    const row = document.createElement('div'); row.className = 'region-row'; row.classList.toggle('selected', draft.selected === index);
    const badge = document.createElement('span'); badge.className = 'region-badge'; badge.textContent = index + 1;
    const meta = document.createElement('div'); meta.className = 'region-meta'; meta.textContent = `${placement(box)} · 宽 ${pct(box.w)}% × 高 ${pct(box.h)}%`;
    const note = document.createElement('textarea'); note.rows = 2; note.maxLength = 5000; note.value = box.note; note.placeholder = '框里要改成什么？例如：剑换成金色，其他不变'; note.setAttribute('aria-label', `框 ${index + 1} 的修改要求`);
    note.addEventListener('input', () => { box.note = note.value; });
    note.addEventListener('focus', () => { draft.selected = index; renderLayer(); for (const el of list.children) el.classList.toggle('selected', el === row); });
    const buttons = document.createElement('div'); buttons.className = 'region-row-actions';
    if (video) {
      for (const [field, label] of [['start_ms', '开始（秒）'], ['end_ms', '结束（秒）']]) {
        const wrap = document.createElement('label'); wrap.textContent = label;
        const input = document.createElement('input'); input.type = 'number'; input.step = '0.001'; input.min = '0';
        input.value = box[field] == null ? '' : box[field] / 1000; if (field === 'end_ms') input.placeholder = '段尾';
        input.addEventListener('input', () => { box[field] = input.value.trim() === '' ? (field === 'end_ms' ? null : 0) : Math.round(Number(input.value) * 1000); renderLayer(); summary(); });
        wrap.append(input); buttons.append(wrap);
      }
      const seek = document.createElement('button'); seek.textContent = '跳到这一帧';
      seek.addEventListener('click', () => { media.pause(); media.currentTime = ((draft.take.start_ms ?? 0) + box.start_ms) / 1000; });
      buttons.append(seek);
    }
    const remove = document.createElement('button'); remove.textContent = '删除';
    remove.addEventListener('click', () => { draft.items.splice(index, 1); draft.selected = null; renderList(); renderLayer(); summary(); });
    buttons.append(remove);
    row.append(badge, meta, note, buttons); list.append(row);
  });
}
function problem() {
  const length = segmentLength();
  for (const [index, box] of draft.items.entries()) {
    if (!Number.isSafeInteger(box.start_ms) || box.start_ms < 0 || (box.end_ms != null && (!Number.isSafeInteger(box.end_ms) || box.end_ms - box.start_ms < 100))) return `框 ${index + 1}：结束须比开始晚至少 0.1 秒，或留空表示到段尾`;
    if (length != null && draft.take.end_ms != null && (box.start_ms >= length || (box.end_ms != null && box.end_ms > length))) return `框 ${index + 1}：时间超出本段（${secs(length)}）`;
  }
  return '';
}
function summary() {
  const issue = problem(); $('#region-save').disabled = Boolean(issue);
  $('#region-summary').textContent = issue || (draft.items.length ? `${draft.items.length} 个框。复制请求和 CLI 任务会写明只改框内。` : (isVideo(draft.take) ? '暂停在要改的画面，按住鼠标拖出一个框。' : '按住鼠标在画面上拖出一个框。'));
  $('#region-summary').classList.toggle('error', Boolean(issue));
}
function point(event) {
  const rect = $('#region-layer').getBoundingClientRect();
  const clamp = value => Math.min(SCALE, Math.max(0, Math.round(value * SCALE)));
  return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
}
function exportPng(kind) {
  const width = media.videoWidth || media.naturalWidth, height = media.videoHeight || media.naturalHeight;
  if (!width || !height) { ctx.toast('画面尚未载入，请稍候再试', true); return; }
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const g = canvas.getContext('2d'), rel = relativeMs();
  const boxes = draft.items.map((box, index) => ({ box, index })).filter(({ box }) => active(box, rel));
  if (!boxes.length) { ctx.toast(isVideo(draft.take) ? '当前画面没有生效的框' : '还没有框', true); return; }
  const rect = box => [box.x * width / SCALE, box.y * height / SCALE, box.w * width / SCALE, box.h * height / SCALE];
  if (kind === 'mask') {
    g.fillStyle = '#000'; g.fillRect(0, 0, width, height); g.fillStyle = '#fff';
    for (const { box } of boxes) g.fillRect(...rect(box));
  } else {
    g.drawImage(media, 0, 0, width, height);
    const line = Math.max(3, Math.round(Math.min(width, height) / 180)), font = Math.max(16, line * 6);
    g.lineWidth = line; g.font = `bold ${font}px sans-serif`; g.textBaseline = 'top';
    for (const { box, index } of boxes) {
      const [x, y, w, h] = rect(box);
      g.strokeStyle = '#ff2d2d'; g.strokeRect(x, y, w, h);
      const label = String(index + 1), pad = line * 1.5, tw = g.measureText(label).width + pad * 2;
      g.fillStyle = '#ff2d2d'; g.fillRect(x, Math.max(0, y - font - pad * 2), tw, font + pad * 2);
      g.fillStyle = '#fff'; g.fillText(label, x + pad, Math.max(0, y - font - pad * 2) + pad);
    }
  }
  canvas.toBlob(blob => {
    if (!blob) { ctx.toast('浏览器无法导出这张画面', true); return; }
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    const base = (draft.title || 'shot').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
    link.href = url; link.download = `${base}${rel != null ? '_' + secs(Math.max(0, rel)).replace('.', '-') : ''}_${kind === 'mask' ? 'mask' : '框选'}.png`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    ctx.toast(kind === 'mask' ? '已下载 mask：框内白、框外黑，原画面尺寸' : '已下载标注图，可直接发给 AI');
  }, 'image/png');
}
export function setupRegions(context) {
  ctx = context;
  const layer = $('#region-layer');
  layer.addEventListener('pointerdown', event => {
    if (!draft || event.button !== 0) return;
    if (draft.items.length >= MAX_REGIONS) { ctx.toast(`每段最多 ${MAX_REGIONS} 个框`, true); return; }
    if (isVideo(draft.take)) media.pause();
    layer.setPointerCapture(event.pointerId); drawing = { from: point(event), box: null }; event.preventDefault();
  });
  layer.addEventListener('pointermove', event => {
    if (!drawing) return;
    const to = point(event), from = drawing.from;
    drawing.box = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
    renderLayer();
  });
  const finish = () => {
    if (!drawing) return;
    const box = drawing.box; drawing = null;
    if (box && box.w >= MIN && box.h >= MIN) {
      const length = segmentLength(), rel = relativeMs();
      const start = rel == null ? 0 : Math.max(0, Math.min(rel, length != null ? length - 100 : rel));
      draft.items.push({ ...box, start_ms: start, end_ms: null, note: '' }); draft.selected = draft.items.length - 1;
      renderList(); summary();
      $('#region-list').lastElementChild?.querySelector('textarea')?.focus();
    }
    renderLayer();
  };
  layer.addEventListener('pointerup', finish); layer.addEventListener('pointercancel', finish);
  $('#region-play').addEventListener('click', () => { if (media.paused) media.play().catch(() => {}); else media.pause(); });
  $('#region-seek').addEventListener('input', () => { media.pause(); media.currentTime = Number($('#region-seek').value) / 1000; });
  $('#region-export-frame').addEventListener('click', () => exportPng('frame'));
  $('#region-export-mask').addEventListener('click', () => exportPng('mask'));
  $('#region-dialog').addEventListener('close', () => {
    if (media?.tagName === 'VIDEO') { media.pause(); media.removeAttribute('src'); media.load(); }
    media?.remove(); media = null; draft = null; drawing = null;
  });
  $('#region-save').addEventListener('click', () => ctx.action(async () => {
    if (problem()) throw new Error(problem());
    const shot = ctx.shotById(draft.shotId);
    const regions = draft.items.map(({ x, y, w, h, start_ms, end_ms, note }) => ({ x, y, w, h, start_ms, end_ms, note }));
    await ctx.api(`/api/shots/${shot.id}/regions`, { method: 'PUT', body: JSON.stringify({ revision: shot.revision, regions }) });
    const projectId = shot.project_id, count = regions.length;
    $('#region-dialog').close(); await ctx.reload(projectId);
    ctx.toast(count ? `已保存 ${count} 个框；复制请求和 CLI 任务会写明只改框内` : '已清除本段框选');
  }));
}
function open(shot, take) {
  draft = { shotId: shot.id, title: shot.title, take, selected: null, items: (shot.regions || []).map(({ x, y, w, h, start_ms, end_ms, note }) => ({ x, y, w, h, start_ms, end_ms, note })) };
  const video = isVideo(take);
  media = document.createElement(video ? 'video' : 'img'); media.className = 'region-media'; media.src = `/media/${take.media_id}`;
  if (video) {
    media.preload = 'auto'; media.muted = true; media.playsInline = true;
    const start = take.start_ms ?? 0, element = media;
    const sync = () => {
      if (media !== element || !draft) return; // Events can still fire while the dialog closes.
      const length = segmentLength(); const seek = $('#region-seek');
      seek.min = start; seek.max = start + (length ?? 0); seek.value = Math.round(media.currentTime * 1000);
      if (take.end_ms != null && media.currentTime * 1000 >= take.end_ms - 2) { media.pause(); media.currentTime = take.end_ms / 1000; }
      $('#region-play').textContent = media.paused ? '▶' : '❚❚'; renderLayer();
    };
    media.addEventListener('loadedmetadata', () => { if (media !== element) return; media.currentTime = start / 1000; sync(); summary(); });
    for (const name of ['timeupdate', 'seeked', 'play', 'pause']) media.addEventListener(name, sync);
  } else media.alt = shot.title;
  media.addEventListener('error', () => { if (draft) $('#region-summary').textContent = '浏览器无法读取这个画面，请检查编码。'; });
  $('#region-player').hidden = !video;
  $('#region-frame').prepend(media);
  $('#region-heading').textContent = `画面框选 · ${shot.title}`;
  renderLayer(); renderList(); summary();
  $('#region-dialog').showModal();
}
// Card overlay: follows object-fit: contain letterboxing so boxes sit on the picture, not the grey bars.
function placeOverlay(stage, element, overlay) {
  const width = element.videoWidth || element.naturalWidth, height = element.videoHeight || element.naturalHeight;
  if (!width || !height) { overlay.hidden = true; return; }
  const scale = Math.min(stage.clientWidth / width, stage.clientHeight / height);
  const w = width * scale, h = height * scale;
  Object.assign(overlay.style, { left: (stage.clientWidth - w) / 2 + 'px', top: (stage.clientHeight - h) / 2 + 'px', width: w + 'px', height: h + 'px' });
  overlay.hidden = false;
}
export function bindRegionCard(card, shot, take) {
  const button = card.querySelector('.edit-regions');
  button.textContent = shot.regions?.length ? `▣ 框选 · ${shot.regions.length}` : '▣ 框选';
  button.disabled = !take?.media_id;
  button.title = take?.media_id ? '在画面上框出只需要修改的区域' : '先导入画面，再框选';
  button.addEventListener('click', () => ctx.action(async () => open(ctx.shotById(shot.id), take)));
  const stage = card.querySelector('.media-stage'), element = stage.querySelector('video,img');
  if (!shot.regions?.length || !element) return;
  const overlay = document.createElement('div'); overlay.className = 'card-regions'; overlay.hidden = true;
  shot.regions.forEach((box, index) => overlay.append(boxElement(box, index, 'region-box')));
  stage.append(overlay);
  const place = () => placeOverlay(stage, element, overlay);
  element.addEventListener(element.tagName === 'VIDEO' ? 'loadedmetadata' : 'load', place);
  if (element.complete) place();
  new ResizeObserver(place).observe(stage);
  if (element.tagName === 'VIDEO') {
    const update = () => {
      const rel = Math.round(element.currentTime * 1000) - (take.start_ms ?? 0);
      shot.regions.forEach((box, index) => overlay.children[index].classList.toggle('inactive', !active(box, rel)));
    };
    element.addEventListener('timeupdate', update); element.addEventListener('seeked', update);
  }
}
