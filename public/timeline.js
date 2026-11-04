// CapCut-style horizontal timeline: shots on a video track, audio tracks below with waveforms.
// Audio clips can be moved, trimmed, boxed by time range and A/B compared; edits go through the audio API.
import { clipTaskSection, mixTaskSection } from './tasks.js';
const $ = selector => document.querySelector(selector);
const kinds = { bgm: 'BGM', voice: '配音', sfx: '音效', other: '其他' };
const IMAGE_MS = 2000, SNAP_PX = 8, EDGE_PX = 7, MAX_AUDIO_REGIONS = 20;
let ctx, project = null, audio = null, pps = 0, fitted = false, playhead = 0, mode = 'move', selected = null, videoSound = false;
let audioCtx = null, playing = null, drag = null, loadedKey = '', pendingNotes = new Map(), lastHash = '', multi = new Set();
const buffers = new Map(), decoding = new Map(), peaks = new Map(), videoDurations = new Map(), probing = new Set();
export const clock = ms => { const s = Math.max(0, ms) / 1000; return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`; };
const secs = ms => (ms / 1000).toFixed(3).replace(/\.?0+$/, '') + 's';
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }

// ---- time model -------------------------------------------------------------------------
function shotLength(shot) {
  const take = shot.takes.find(t => t.id === shot.active_take_id);
  if (!take?.media_id) return { ms: IMAGE_MS, take, known: true };
  if (take.end_ms != null) return { ms: take.end_ms - take.start_ms, take, known: true };
  if (!take.mime.startsWith('video/')) return { ms: IMAGE_MS, take, known: true };
  if (take.duration_ms) return { ms: take.duration_ms, take, known: true };
  const probed = videoDurations.get(take.media_id);
  if (probed) return { ms: probed, take, known: true };
  probe(take.media_id);
  return { ms: IMAGE_MS, take, known: false };
}
function probe(mediaId) {
  if (probing.has(mediaId)) return; probing.add(mediaId);
  const video = document.createElement('video'); video.preload = 'metadata'; video.muted = true;
  video.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(video.duration) && video.duration > 0) { videoDurations.set(mediaId, Math.round(video.duration * 1000)); render(); }
    video.removeAttribute('src'); video.load();
  }, { once: true });
  video.src = `/media/${mediaId}`;
}
function shotLayout() {
  let at = 0;
  return (project?.shots || []).map((shot, index) => { const info = shotLength(shot); const item = { shot, index, start: at, ...info }; at += info.ms; return item; });
}
function activeVersion(clip) { return clip.versions.find(v => v.id === clip.active_version_id) || clip.versions[0]; }
function sourceLength(version) { return buffers.get(version?.media_id)?.duration * 1000 || version?.duration_ms || null; }
function clipWindow(clip, version = activeVersion(clip)) {
  const total = sourceLength(version);
  const end = clip.out_ms ?? total ?? clip.in_ms + 10000;
  return { in: clip.in_ms, out: total ? Math.min(end, Math.max(total, clip.in_ms + 100)) : end, known: total != null };
}
function clipLength(clip) { const w = clipWindow(clip); return Math.max(100, w.out - w.in); }
function totalLength() {
  const shots = shotLayout(); let end = shots.length ? shots.at(-1).start + shots.at(-1).ms : 0;
  for (const track of audio?.tracks || []) for (const clip of track.clips) end = Math.max(end, clip.offset_ms + clipLength(clip));
  return Math.max(end, 5000);
}
const x = ms => ms / 1000 * pps;
const msAt = px => Math.round(px / pps * 1000);

// ---- audio decoding ---------------------------------------------------------------------
function context() { audioCtx ??= new AudioContext(); return audioCtx; }
function decode(version) {
  const id = version.media_id;
  if (buffers.has(id) || decoding.has(id)) return decoding.get(id);
  const job = fetch(`/media/${id}`).then(res => { if (!res.ok) throw new Error('音频读取失败'); return res.arrayBuffer(); })
    .then(data => context().decodeAudioData(data))
    .then(buffer => {
      buffers.set(id, buffer); peaks.set(id, summarize(buffer)); decoding.delete(id);
      if (version.duration_ms == null) ctx.api(`/api/audio/versions/${version.id}`, { method: 'PATCH', body: JSON.stringify({ duration_ms: Math.round(buffer.duration * 1000) }) }).catch(() => {});
      render();
    })
    .catch(() => { decoding.delete(id); buffers.set(id, null); render(); });
  decoding.set(id, job); return job;
}
// 200 min/max pairs per second is enough detail for any zoom we allow.
function summarize(buffer) {
  const rate = 200, count = Math.max(1, Math.ceil(buffer.duration * rate)), size = buffer.length / count;
  const channels = [...Array(buffer.numberOfChannels).keys()].map(n => buffer.getChannelData(n));
  const result = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let max = 0; const from = Math.floor(i * size), to = Math.min(buffer.length, Math.floor((i + 1) * size));
    for (const data of channels) for (let j = from; j < to; j += 4) { const v = Math.abs(data[j]); if (v > max) max = v; }
    result[i] = max;
  }
  return { rate, data: result };
}
function drawWave(canvas, version, window, width, height, color) {
  const summary = peaks.get(version?.media_id); if (!summary) return;
  canvas.width = Math.max(1, Math.min(8000, Math.round(width))); canvas.height = height;
  const g = canvas.getContext('2d'); g.fillStyle = color;
  const span = window.out - window.in, mid = height / 2;
  for (let px = 0; px < canvas.width; px++) {
    const from = Math.floor((window.in + span * px / canvas.width) / 1000 * summary.rate), to = Math.max(from + 1, Math.floor((window.in + span * (px + 1) / canvas.width) / 1000 * summary.rate));
    let max = 0; for (let i = from; i < to && i < summary.data.length; i++) if (summary.data[i] > max) max = summary.data[i];
    const h = Math.max(1, max * (height - 4)); g.fillRect(px, mid - h / 2, 1, h);
  }
}

// ---- playback ---------------------------------------------------------------------------
function play(from = playhead) {
  stop(false);
  const ac = context(); ac.resume();
  const startAt = ac.currentTime + 0.05, sources = [];
  for (const track of audio?.tracks || []) {
    if (track.muted) continue;
    const gain = ac.createGain(); gain.gain.value = Math.pow(10, track.gain_db / 20); gain.connect(ac.destination);
    for (const clip of track.clips) {
      const version = activeVersion(clip), buffer = buffers.get(version?.media_id); if (!buffer) continue;
      const w = clipWindow(clip), length = w.out - w.in, into = from - clip.offset_ms;
      if (into >= length) continue;
      const source = ac.createBufferSource(); source.buffer = buffer; source.connect(gain);
      source.start(startAt + Math.max(0, -into) / 1000, (w.in + Math.max(0, into)) / 1000, (length - Math.max(0, into)) / 1000);
      sources.push(source);
    }
  }
  playing = { from, startAt, sources, end: totalLength() };
  $('#editor-play').textContent = '❚❚';
  const tick = () => {
    if (!playing) return;
    playhead = playing.from + Math.max(0, (ac.currentTime - playing.startAt) * 1000);
    if (playhead >= playing.end) { playhead = playing.end; stop(); return; }
    updatePlayhead(); syncMonitor(true); playing.frame = requestAnimationFrame(tick);
  };
  playing.frame = requestAnimationFrame(tick);
}
function stop(updateButton = true) {
  if (!playing) return;
  cancelAnimationFrame(playing.frame);
  for (const source of playing.sources) { try { source.stop(); } catch { /* already ended */ } }
  playing.solo?.(); playing = null;
  $('#editor-monitor video').pause();
  if (updateButton) { $('#editor-play').textContent = '▶'; updatePlayhead(); syncMonitor(false); }
}
// A/B audition: plays one version over the selected range (or the clip window) on its own.
function audition(clip, version, range) {
  stop(); const buffer = buffers.get(version.media_id);
  if (!buffer) { ctx.toast('这个版本还在载入，请稍候', true); decode(version); return; }
  const ac = context(); ac.resume();
  const w = range || clipWindow(clip, version), source = ac.createBufferSource(); source.buffer = buffer; source.connect(ac.destination);
  source.start(ac.currentTime + 0.02, w.in / 1000, Math.max(0.1, (Math.min(w.out, buffer.duration * 1000) - w.in) / 1000));
  playing = { sources: [source], frame: 0 };
  source.onended = () => { if (playing?.sources[0] === source) stop(); };
  $('#editor-play').textContent = '❚❚';
}
function syncMonitor(running) {
  const item = shotLayout().find(s => playhead >= s.start && playhead < s.start + s.ms) || null;
  const video = $('#editor-monitor video'), image = $('#editor-monitor img'), empty = $('#editor-monitor .monitor-empty');
  const take = item?.take, isVideo = take?.mime?.startsWith('video/');
  empty.hidden = Boolean(take?.media_id); empty.textContent = item ? `${String(item.index + 1).padStart(2, '0')} · ${item.shot.title}\n（还没有画面）` : '时间线末尾';
  image.hidden = !(take?.media_id && !isVideo); video.hidden = !isVideo;
  if (take?.media_id && !isVideo && image.dataset.media !== take.media_id) { image.src = `/media/${take.media_id}`; image.dataset.media = take.media_id; }
  if (!isVideo) { video.pause(); return; }
  if (video.dataset.media !== take.media_id) { video.src = `/media/${take.media_id}`; video.dataset.media = take.media_id; }
  video.muted = !videoSound;
  const target = (take.start_ms ?? 0) / 1000 + (playhead - item.start) / 1000;
  if (Math.abs(video.currentTime - target) > (running ? 0.25 : 0.03)) video.currentTime = target;
  if (running && video.paused) video.play().catch(() => {}); else if (!running && !video.paused) video.pause();
}

// ---- rendering --------------------------------------------------------------------------
function updatePlayhead() {
  const line = $('#editor-playhead'); if (line) line.style.left = x(playhead) + 'px';
  $('#editor-time').textContent = `${clock(playhead)} / ${clock(totalLength())}`;
}
function drawRuler(width) {
  const canvas = $('#editor-ruler'); canvas.width = Math.max(1, Math.min(32000, Math.round(width))); canvas.height = 22;
  const g = canvas.getContext('2d'), step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120].find(s => s * pps >= 70) || 300;
  g.fillStyle = '#8e998f'; g.strokeStyle = '#3a4236'; g.font = '10px sans-serif';
  for (let t = 0; t * pps < canvas.width; t += step) {
    const px = Math.round(t * pps) + 0.5; g.beginPath(); g.moveTo(px, 12); g.lineTo(px, 22); g.stroke();
    g.fillText(clock(t * 1000).replace(/\.00$/, ''), px + 3, 10);
  }
}
function snapPoints(skipClip) {
  const points = [0, playhead];
  for (const item of shotLayout()) points.push(item.start, item.start + item.ms);
  for (const track of audio?.tracks || []) for (const clip of track.clips) if (clip.id !== skipClip) points.push(clip.offset_ms, clip.offset_ms + clipLength(clip));
  return points;
}
function snap(ms, skipClip) {
  let best = ms, distance = SNAP_PX / pps * 1000;
  for (const point of snapPoints(skipClip)) if (Math.abs(point - ms) < distance) { best = point; distance = Math.abs(point - ms); }
  return best;
}
export function renderEditor(next) {
  if (next !== undefined) project = next;
  const id = project?.id || '';
  if (id !== loadedKey) { loadedKey = id; audio = null; selected = null; multi.clear(); playhead = 0; fitted = false; stop(); if (id) refreshAudio(); }
  render();
}
function render() {
  const panel = $('#editor'); if (!panel) return;
  panel.hidden = !project;
  if (!project || !audio || drag) return;
  const lanes = $('#editor-lanes'), heads = $('#editor-heads'), scroller = $('#editor-scroll');
  if (!fitted && scroller.clientWidth) { pps = Math.min(200, Math.max(8, (scroller.clientWidth - 40) / (totalLength() / 1000))); fitted = true; }
  if (!pps) pps = 40;
  const width = x(totalLength()) + 160;
  $('#editor-canvas').style.width = width + 'px'; drawRuler(width);
  heads.replaceChildren(); lanes.replaceChildren();
  // Video track
  const videoHead = el('div', 'track-head video-head'); const name = el('strong', '', '视频');
  const sound = el('button', 'text-button', videoSound ? '原声 · 开' : '原声 · 关'); sound.title = '预览时是否播放视频自带声音';
  sound.addEventListener('click', () => { videoSound = !videoSound; sound.textContent = videoSound ? '原声 · 开' : '原声 · 关'; $('#editor-monitor video').muted = !videoSound; });
  videoHead.append(name, sound); heads.append(videoHead);
  const videoLane = el('div', 'lane video-lane');
  for (const item of shotLayout()) {
    const block = el('button', 'shot-block'); block.style.left = x(item.start) + 'px'; block.style.width = Math.max(4, x(item.ms) - 2) + 'px';
    block.classList.toggle('estimated', !item.known); block.title = `${item.shot.title} · ${secs(item.ms)}${item.known ? '' : '（读取时长中）'}`;
    block.append(el('span', '', `${String(item.index + 1).padStart(2, '0')} ${item.shot.title}`));
    if (item.shot.regions?.length) block.append(el('small', 'shot-block-regions', `▣${item.shot.regions.length}`));
    block.addEventListener('click', () => { playhead = item.start; updatePlayhead(); syncMonitor(false); ctx.focusShot(item.shot.id); });
    videoLane.append(block);
  }
  lanes.append(videoLane);
  // Audio tracks
  for (const track of audio.tracks) {
    const head = el('div', 'track-head'); head.dataset.track = track.id;
    const title = el('input', 'track-title'); title.value = track.title; title.maxLength = 200; title.setAttribute('aria-label', '音轨名称');
    title.addEventListener('change', () => patchTrack(track, { title: title.value }));
    const meta = el('div', 'track-meta');
    const kind = el('small', 'track-kind', kinds[track.kind]);
    const mute = el('button', 'text-button', track.muted ? '静音中' : '静音'); mute.classList.toggle('on', track.muted);
    mute.addEventListener('click', () => patchTrack(track, { muted: !track.muted }));
    const gain = el('input', 'track-gain'); gain.type = 'number'; gain.step = '1'; gain.min = '-60'; gain.max = '12'; gain.value = track.gain_db; gain.title = '音量 dB'; gain.setAttribute('aria-label', `${track.title} 音量 dB`);
    gain.addEventListener('change', () => patchTrack(track, { gain_db: Number(gain.value) }));
    const remove = el('button', 'text-button track-delete', '×'); remove.title = '删除音轨'; remove.setAttribute('aria-label', `删除音轨 ${track.title}`);
    remove.addEventListener('click', () => {
      if (track.clips.length && !confirm(`删除音轨「${track.title}」和上面 ${track.clips.length} 个片段？原文件保留在本地素材库。`)) return;
      mutate(`/api/audio/tracks/${track.id}`, 'DELETE', { revision: track.revision });
    });
    meta.append(kind, mute, gain, el('span', 'track-unit', 'dB'), remove); head.append(title, meta); heads.append(head);
    const lane = el('div', 'lane audio-lane'); lane.dataset.track = track.id; lane.classList.toggle('muted', track.muted);
    bindLaneDrop(lane, track);
    for (const clip of track.clips) lane.append(clipElement(clip, track));
    lanes.append(lane);
  }
  if (!audio.tracks.length) { const hint = el('div', 'lane empty-lane', '点上方「＋ BGM」「＋ 配音」「＋ 音效」建立音轨，再把音频拖进来。'); lanes.append(hint); heads.append(el('div', 'track-head')); }
  const line = el('div', 'playhead'); line.id = 'editor-playhead'; lanes.append(line);
  updatePlayhead(); renderInspector();
  if (!playing) syncMonitor(false);
}
function clipElement(clip, track) {
  const version = activeVersion(clip); if (version && !buffers.has(version.media_id)) decode(version);
  const w = clipWindow(clip), length = Math.max(100, w.out - w.in);
  const node = el('div', 'audio-clip'); node.dataset.clip = clip.id; node.dataset.kind = track.kind;
  node.style.left = x(clip.offset_ms) + 'px'; node.style.width = Math.max(6, x(length)) + 'px';
  node.classList.toggle('selected', selected === clip.id); node.classList.toggle('multi', multi.has(clip.id)); node.classList.toggle('loading', !w.known);
  const label = el('span', 'clip-label', `${clip.title}${clip.versions.length > 1 ? ` · v${version.number}/${clip.versions.length}` : ''}`);
  const canvas = el('canvas', 'clip-wave'); node.append(canvas, label);
  if (buffers.get(version?.media_id) === null) node.append(el('small', 'clip-error', '无法解码'));
  drawWave(canvas, version, w, x(length), 46, track.kind === 'voice' ? '#9fd4ff' : track.kind === 'sfx' ? '#ffd28a' : '#c6ed9a');
  clip.regions.forEach((region, index) => {
    const from = Math.max(region.start_ms, w.in), to = Math.min(region.end_ms, w.out); if (to <= from) return;
    const band = el('div', 'audio-region'); band.style.left = x(from - w.in) + 'px'; band.style.width = Math.max(2, x(to - from)) + 'px';
    band.append(el('span', '', String(index + 1))); band.title = region.note || '未填写要求'; node.append(band);
  });
  if (clip.notes.trim()) node.append(el('small', 'clip-note-flag', '✎'));
  node.addEventListener('pointerdown', event => startDrag(event, clip, track, node));
  return node;
}
function bindLaneDrop(lane, track) {
  lane.addEventListener('dragover', event => {
    const types = event.dataTransfer.types;
    if (types.includes('application/x-shot-asset') || types.includes('Files')) { event.preventDefault(); lane.classList.add('drop'); }
  });
  lane.addEventListener('dragleave', () => lane.classList.remove('drop'));
  lane.addEventListener('drop', event => {
    lane.classList.remove('drop');
    const offset = Math.max(0, snap(msAt(event.clientX - lane.getBoundingClientRect().left)));
    const asset = event.dataTransfer.getData('application/x-shot-asset');
    if (asset) { event.preventDefault(); ctx.action(async () => { const result = await ctx.api(`/api/audio/tracks/${track.id}/clips`, { method: 'POST', body: JSON.stringify({ asset_id: asset, offset_ms: offset }) }); apply(result); selected = result.clip_id; render(); }); return; }
    if (event.dataTransfer.files.length) { event.preventDefault(); upload(track, [...event.dataTransfer.files], offset); }
  });
}
function upload(track, files, offset) {
  ctx.action(async () => {
    let at = offset, count = 0;
    for (const file of files) {
      if (file.size > 1024 ** 3) throw new Error(`${file.name} 超过 1 GB 上限`);
      ctx.toast(`正在导入音频 ${count + 1}/${files.length}：${file.name}`);
      const result = await ctx.api(`/api/audio/tracks/${track.id}/clips?filename=${encodeURIComponent(file.name)}&offset_ms=${at}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      apply(result); selected = result.clip_id; count++;
      const clip = findClip(result.clip_id)?.clip; if (clip) { await decode(activeVersion(clip)); at = clip.offset_ms + clipLength(clip); }
    }
    render(); ctx.toast(`已放上 ${count} 段音频；原文件保留在本地`);
  });
}

// ---- dragging: move / trim / range select -----------------------------------------------
function startDrag(event, clip, track, node) {
  if (event.button !== 0 || ctx.busy()) return;
  event.preventDefault();
  // Shift+click builds a multi-selection for mixing instead of dragging.
  if (event.shiftKey) {
    if (selected && !multi.size) multi.add(selected);
    if (multi.has(clip.id)) multi.delete(clip.id); else multi.add(clip.id);
    selected = clip.id; flushNotes(); render(); return;
  }
  multi.clear(); node.setPointerCapture(event.pointerId);
  const rect = node.getBoundingClientRect(), local = event.clientX - rect.left, w = clipWindow(clip);
  const edge = mode === 'move' ? (local < EDGE_PX ? 'left' : rect.width - local < EDGE_PX ? 'right' : null) : null;
  selected = clip.id; flushNotes();
  drag = { clip, track, node, mode, edge, startX: event.clientX, startY: event.clientY, offset: clip.offset_ms, in: w.in, out: w.out, total: sourceLength(activeVersion(clip)), moved: false, targetTrack: track.id };
  if (mode === 'select') {
    drag.anchor = w.in + msAt(local); drag.band = el('div', 'audio-region drawing'); node.append(drag.band);
  }
  for (const other of document.querySelectorAll('.audio-clip.selected')) other.classList.remove('selected');
  node.classList.add('selected');
  const move = e => dragMove(e), up = e => { node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', up); node.removeEventListener('pointercancel', up); dragEnd(e); };
  node.addEventListener('pointermove', move); node.addEventListener('pointerup', up); node.addEventListener('pointercancel', up);
}
function dragMove(event) {
  const d = drag; if (!d) return;
  const dx = msAt(event.clientX - d.startX);
  if (Math.abs(event.clientX - d.startX) > 2 || Math.abs(event.clientY - d.startY) > 2) d.moved = true;
  if (d.mode === 'select') {
    const rect = d.node.getBoundingClientRect(), pos = Math.min(d.out, Math.max(d.in, d.in + msAt(event.clientX - rect.left)));
    d.from = Math.min(d.anchor, pos); d.to = Math.max(d.anchor, pos);
    d.band.style.left = x(d.from - d.in) + 'px'; d.band.style.width = x(d.to - d.from) + 'px'; return;
  }
  if (d.edge === 'left') {
    let nextIn = Math.min(d.out - 100, Math.max(0, d.in + dx)); let offset = d.offset + (nextIn - d.in);
    const snapped = snap(offset, d.clip.id); nextIn += snapped - offset; offset = snapped;
    if (offset < 0) { nextIn -= offset; offset = 0; }
    nextIn = Math.min(d.out - 100, Math.max(0, nextIn)); offset = d.offset + (nextIn - d.in);
    d.next = { offset_ms: offset, in_ms: nextIn };
    d.node.style.left = x(offset) + 'px'; d.node.style.width = x(d.out - nextIn) + 'px';
  } else if (d.edge === 'right') {
    let out = d.out + dx; out = snap(d.offset + (out - d.in), d.clip.id) - d.offset + d.in;
    out = Math.max(d.in + 100, d.total ? Math.min(d.total, out) : out);
    d.next = { out_ms: d.total && out >= d.total ? null : out };
    d.node.style.width = x(out - d.in) + 'px';
  } else {
    const offset = Math.max(0, snap(d.offset + dx, d.clip.id)); d.next = { offset_ms: offset };
    d.node.style.left = x(offset) + 'px';
    const lane = document.elementsFromPoint(event.clientX, event.clientY).find(node => node.classList?.contains('audio-lane'));
    for (const other of document.querySelectorAll('.audio-lane.drop')) other.classList.remove('drop');
    if (lane) { d.targetTrack = lane.dataset.track; if (lane.dataset.track !== d.track.id) lane.classList.add('drop'); }
  }
}
function dragEnd() {
  const d = drag; drag = null; if (!d) return;
  for (const other of document.querySelectorAll('.audio-lane.drop')) other.classList.remove('drop');
  if (d.mode === 'select') {
    if (!d.moved || d.to - d.from < 100) { render(); return; }
    if (d.clip.regions.length >= MAX_AUDIO_REGIONS) { ctx.toast(`每段音频最多 ${MAX_AUDIO_REGIONS} 个框选`, true); render(); return; }
    const regions = [...d.clip.regions.map(({ start_ms, end_ms, note }) => ({ start_ms, end_ms, note })), { start_ms: d.from, end_ms: d.to, note: '' }];
    mutate(`/api/audio/clips/${d.clip.id}/regions`, 'PUT', { revision: d.clip.revision, regions }, () => { const notes = document.querySelectorAll('.audio-region-row textarea'); notes[notes.length - 1]?.focus(); });
    return;
  }
  if (!d.moved || !d.next) { if (!d.moved) { const rect = d.node.getBoundingClientRect(); playhead = d.clip.offset_ms + msAt(d.startX - rect.left); } render(); return; }
  const patch = { revision: d.clip.revision, ...d.next };
  if (!d.edge && d.targetTrack && d.targetTrack !== d.track.id) patch.track_id = d.targetTrack;
  mutate(`/api/audio/clips/${d.clip.id}`, 'PATCH', patch);
}

// ---- inspector --------------------------------------------------------------------------
function findClip(id) {
  for (const track of audio?.tracks || []) { const clip = track.clips.find(c => c.id === id); if (clip) return { clip, track }; }
  return null;
}
function renderInspector() {
  const box = $('#editor-inspector'); box.replaceChildren();
  const group = [...multi].map(findClip).filter(Boolean).map(found => found.clip);
  if (group.length >= 2) { box.append(mixTaskSection(group, audio.tracks)); return; }
  const found = selected && findClip(selected);
  if (!found) { box.append(el('p', 'inspector-empty', mode === 'select' ? '框选模式：在音频波形上拖出一段时间，写下这段要怎么改。' : '点选一段音频查看版本、修改要求和框选；拖动可移动，拖左右边缘可裁剪。')); return; }
  const { clip, track } = found, version = activeVersion(clip), w = clipWindow(clip);
  const head = el('div', 'inspector-head');
  const title = el('input', 'inspector-title'); title.value = clip.title; title.maxLength = 200; title.setAttribute('aria-label', '音频片段名称');
  title.addEventListener('change', () => mutate(`/api/audio/clips/${clip.id}`, 'PATCH', { revision: clip.revision, title: title.value }));
  head.append(title, el('small', '', `${kinds[track.kind]} · ${track.title} · 时间线 ${secs(clip.offset_ms)} 起 · 用源文件 ${secs(w.in)} → ${secs(w.out)}`));
  // Versions + A/B
  const versions = el('div', 'inspector-versions');
  const options = select => { for (const v of clip.versions) select.add(new Option(`v${v.number} · ${v.filename}${v.note ? ' · ' + v.note : ''}`, v.id)); };
  const a = el('select'); options(a); a.value = clip.active_version_id; a.setAttribute('aria-label', '采用版本');
  a.addEventListener('change', () => mutate(`/api/audio/clips/${clip.id}`, 'PATCH', { revision: clip.revision, active_version_id: a.value }));
  const b = el('select'); options(b); b.value = clip.versions.find(v => v.id !== clip.active_version_id)?.id || clip.active_version_id; b.setAttribute('aria-label', '对比版本');
  const range = () => { const region = clip.regions[Number($('#editor-inspector').dataset.region ?? -1)]; return region ? { in: region.start_ms, out: region.end_ms } : null; };
  const playA = el('button', '', '▶ 试听采用版'); playA.addEventListener('click', () => audition(clip, clip.versions.find(v => v.id === a.value), range()));
  const playB = el('button', '', '▶ 试听对比版'); playB.addEventListener('click', () => audition(clip, clip.versions.find(v => v.id === b.value), range()));
  const labelA = el('label', '', '采用版本'); labelA.append(a); const labelB = el('label', '', 'A/B 对比'); labelB.append(b);
  versions.append(labelA, playA, labelB, playB);
  if (clip.versions.length < 2) versions.append(el('small', 'muted', '只有一个版本。AI 处理后的新版会出现在这里，可以 A/B 对比。'));
  // Trim
  const trim = el('div', 'inspector-trim');
  for (const [field, text] of [['in_ms', '入点（秒）'], ['out_ms', '出点（秒）']]) {
    const label = el('label', '', text), input = el('input'); input.type = 'number'; input.step = '0.001'; input.min = '0';
    input.value = clip[field] == null ? '' : clip[field] / 1000; if (field === 'out_ms') input.placeholder = '到结尾';
    input.addEventListener('change', () => mutate(`/api/audio/clips/${clip.id}`, 'PATCH', { revision: clip.revision, [field]: input.value.trim() === '' ? (field === 'out_ms' ? null : 0) : Math.round(Number(input.value) * 1000) }));
    label.append(input); trim.append(label);
  }
  const offsetLabel = el('label', '', '时间线位置（秒）'), offset = el('input'); offset.type = 'number'; offset.step = '0.001'; offset.min = '0'; offset.value = clip.offset_ms / 1000;
  offset.addEventListener('change', () => mutate(`/api/audio/clips/${clip.id}`, 'PATCH', { revision: clip.revision, offset_ms: Math.max(0, Math.round(Number(offset.value) * 1000)) }));
  offsetLabel.append(offset); trim.append(offsetLabel);
  // Notes
  const notesLabel = el('label', 'inspector-notes', '整段修改要求'), notes = el('textarea'); notes.rows = 2; notes.maxLength = 50000;
  notes.placeholder = '例如：整体含蓄一点，鼓点降低，开头 8 秒慢慢递进。'; notes.value = pendingNotes.get(clip.id)?.notes ?? clip.notes;
  notes.addEventListener('input', () => queueNotes(clip, { notes: notes.value }));
  notesLabel.append(notes);
  // Regions
  const regions = el('div', 'inspector-regions');
  regions.append(el('strong', '', clip.regions.length ? `音频框选 · ${clip.regions.length}` : '音频框选'));
  if (!clip.regions.length) regions.append(el('small', 'muted', '切到「▭ 框选」，在波形上拖出一段时间。'));
  clip.regions.forEach((region, index) => {
    const row = el('div', 'audio-region-row');
    const tag = el('button', 'region-tag', `${index + 1}`); tag.title = '选中这段：试听只播这段';
    tag.addEventListener('click', () => { box.dataset.region = String(index); for (const r of regions.querySelectorAll('.audio-region-row')) r.classList.toggle('active', r === row); });
    const when = el('small', '', `${secs(region.start_ms)} → ${secs(region.end_ms)}`);
    const note = el('textarea'); note.rows = 1; note.maxLength = 5000; note.placeholder = '这段要怎么改？例如：鼓点降低、渐强进副歌'; note.setAttribute('aria-label', `音频框选 ${index + 1} 的要求`);
    note.value = pendingNotes.get(clip.id)?.regions?.[index]?.note ?? region.note;
    note.addEventListener('input', () => {
      const current = pendingNotes.get(clip.id)?.regions ?? clip.regions.map(({ start_ms, end_ms, note }) => ({ start_ms, end_ms, note }));
      current[index] = { ...current[index], note: note.value }; queueNotes(clip, { regions: current });
    });
    const remove = el('button', 'text-button', '删除');
    remove.addEventListener('click', () => mutate(`/api/audio/clips/${clip.id}/regions`, 'PUT', { revision: clip.revision, regions: clip.regions.filter((_, n) => n !== index).map(({ start_ms, end_ms, note }) => ({ start_ms, end_ms, note })) }));
    row.append(tag, when, note, remove); regions.append(row);
  });
  if (Number(box.dataset.region) >= clip.regions.length) delete box.dataset.region;
  // Actions
  const actions = el('div', 'inspector-actions');
  const copy = el('button', 'primary', '复制这段音频的修改请求 ↗'); copy.addEventListener('click', () => ctx.copy(audioRequestText(clip, track)));
  const remove = el('button', '', '从时间线移除'); remove.addEventListener('click', () => { if (confirm(`移除「${clip.title}」？原文件保留在本地素材库。`)) mutate(`/api/audio/clips/${clip.id}`, 'DELETE', { revision: clip.revision }, () => { selected = null; }); });
  actions.append(copy, remove);
  box.append(head, versions, trim, notesLabel, regions, clipTaskSection(clip), actions);
}
export function audioRequestText(clip, track) {
  const version = activeVersion(clip), w = clipWindow(clip);
  const regions = clip.regions.length ? `\n\n【音频框选 · 只改这些时间段（源文件时间）】\n${clip.regions.map((r, i) => `#${i + 1} ${secs(r.start_ms)} → ${secs(r.end_ms)}：${r.note || '未填写'}`).join('\n')}\n框选以外的部分保持不变。` : '';
  return `项目：${project.title}\n音轨：${track.title}（${kinds[track.kind]}）\n音频片段：${clip.title}\n采用版本：v${version.number} · ${version.filename}${sourceLength(version) ? `（时长 ${secs(sourceLength(version))}）` : ''}\n本地文件：${location.origin}/media/${version.media_id}\n时间线位置：${secs(clip.offset_ms)} 起；使用源文件 ${secs(w.in)} → ${secs(w.out)}\n\n【整段修改要求】\n${clip.notes || '（未填写）'}${regions}\n\n请处理这段音频，输出新的音频文件，作为这个片段的新版本导回（旧版本保留，用于 A/B 对比）。`;
}
function queueNotes(clip, patch) {
  const entry = pendingNotes.get(clip.id) || { clip };
  Object.assign(entry, patch); clearTimeout(entry.timer);
  entry.timer = setTimeout(() => flushNotes(clip.id), 650); pendingNotes.set(clip.id, entry);
}
function flushNotes(only) {
  for (const [id, entry] of [...pendingNotes]) {
    if (only && id !== only) continue;
    clearTimeout(entry.timer); pendingNotes.delete(id);
    const current = findClip(id)?.clip; if (!current) continue;
    const save = async () => {
      if (entry.notes !== undefined) apply(await ctx.api(`/api/audio/clips/${id}`, { method: 'PATCH', body: JSON.stringify({ revision: findClip(id).clip.revision, notes: entry.notes }) }));
      if (entry.regions) apply(await ctx.api(`/api/audio/clips/${id}/regions`, { method: 'PUT', body: JSON.stringify({ revision: findClip(id).clip.revision, regions: entry.regions }) }));
    };
    save().catch(error => ctx.toast(error.message, true));
  }
}

// ---- server sync ------------------------------------------------------------------------
function apply(result) { audio = { project_id: result.project_id, tracks: result.tracks }; lastHash = JSON.stringify(audio); }
function mutate(path, method, payload, after) {
  flushNotes();
  ctx.action(async () => { apply(await ctx.api(path, { method, body: JSON.stringify(payload) })); after?.(); if (playing?.from != null) play(playhead); render(); after && requestAnimationFrame(after); });
}
function patchTrack(track, patch) { mutate(`/api/audio/tracks/${track.id}`, 'PATCH', { revision: track.revision, ...patch }); }
async function refreshAudio() {
  const id = project?.id; if (!id) return;
  const result = await ctx.api(`/api/projects/${id}/audio`);
  if (project?.id !== id) return;
  const hash = JSON.stringify({ project_id: result.project_id, tracks: result.tracks });
  if (hash === lastHash && audio) return;
  apply(result); render();
}
function editing() { return Boolean(drag || pendingNotes.size || document.activeElement?.closest?.('#editor-inspector, .track-head') && document.activeElement.matches('input,textarea')); }
export function setupEditor(context) {
  ctx = context;
  $('#editor-play').addEventListener('click', () => { if (playing) stop(); else play(playhead >= totalLength() - 10 ? 0 : playhead); });
  $('#editor-start').addEventListener('click', () => { stop(); playhead = 0; updatePlayhead(); syncMonitor(false); });
  for (const [id, factor] of [['editor-zoom-in', 1.5], ['editor-zoom-out', 1 / 1.5]]) $('#' + id).addEventListener('click', () => { pps = Math.min(400, Math.max(4, pps * factor)); render(); });
  $('#editor-fit').addEventListener('click', () => { fitted = false; render(); });
  // Timeline manifest for 剪映: the page knows each shot's probed length, the server adds file paths.
  $('#editor-export').addEventListener('click', () => ctx.action(async () => {
    const layout = shotLayout();
    if (!layout.length) throw new Error('还没有片段可以导出');
    if (layout.some(item => !item.known)) throw new Error('还在读取视频长度，请稍候再导出');
    const manifest = await ctx.api(`/api/projects/${project.id}/timeline-export`, { method: 'POST', body: JSON.stringify({ shot_durations: Object.fromEntries(layout.map(item => [item.shot.id, Math.round(item.ms)])) }) });
    const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${project.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)}.aicut-timeline.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ctx.toast('已导出时间线清单。运行 python scripts/export_jianying.py 清单.json --drafts "剪映草稿文件夹" 生成剪映草稿');
  }));
  for (const button of document.querySelectorAll('[data-editor-mode]')) button.addEventListener('click', () => {
    mode = button.dataset.editorMode; for (const other of document.querySelectorAll('[data-editor-mode]')) other.classList.toggle('selected', other === button);
    $('#editor').classList.toggle('select-mode', mode === 'select'); renderInspector();
  });
  for (const button of document.querySelectorAll('[data-add-track]')) button.addEventListener('click', () => {
    const kind = button.dataset.addTrack, count = (audio?.tracks || []).filter(t => t.kind === kind).length + 1;
    ctx.action(async () => { apply(await ctx.api(`/api/projects/${project.id}/audio/tracks`, { method: 'POST', body: JSON.stringify({ title: `${kinds[kind]} ${count}`, kind }) })); render(); });
  });
  $('#editor-import').addEventListener('click', () => {
    const found = selected && findClip(selected), track = found?.track || audio?.tracks[0];
    if (!track) { ctx.toast('先建立一条音轨', true); return; }
    $('#editor-files').dataset.track = track.id; $('#editor-files').click();
  });
  $('#editor-files').addEventListener('change', event => {
    const files = [...event.target.files]; event.target.value = ''; const track = audio?.tracks.find(t => t.id === event.target.dataset.track);
    if (files.length && track) upload(track, files, Math.round(playhead));
  });
  $('#editor-ruler').addEventListener('pointerdown', event => {
    const seek = e => { playhead = Math.max(0, Math.min(totalLength(), msAt(e.clientX - $('#editor-ruler').getBoundingClientRect().left))); if (playing) play(playhead); else { updatePlayhead(); syncMonitor(false); } };
    seek(event); const ruler = $('#editor-ruler'); ruler.setPointerCapture(event.pointerId);
    const move = e => seek(e), up = () => { ruler.removeEventListener('pointermove', move); ruler.removeEventListener('pointerup', up); };
    ruler.addEventListener('pointermove', move); ruler.addEventListener('pointerup', up);
  });
  $('#editor-scroll').addEventListener('wheel', event => {
    if (!event.ctrlKey) return; event.preventDefault();
    pps = Math.min(400, Math.max(4, pps * (event.deltaY < 0 ? 1.15 : 1 / 1.15))); render();
  }, { passive: false });
  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || !project || event.target.matches?.('input,textarea,select,button') || document.querySelector('dialog[open]')) return;
    event.preventDefault(); $('#editor-play').click();
  });
  let resizeWidth = 0;
  new ResizeObserver(() => { const w = $('#editor-scroll').clientWidth; if (Math.abs(w - resizeWidth) > 40) { resizeWidth = w; render(); } }).observe($('#editor-scroll'));
  // Pick up versions imported by an agent through cli.mjs while the page is idle.
  setInterval(() => { if (project && !document.hidden && !ctx.busy() && !editing() && !document.querySelector('dialog[open]')) refreshAudio().catch(() => {}); }, 2000);
}
export function audioState() { return audio; }
export function currentPlayhead() { return playhead; }
export function shotStart(id) { return shotLayout().find(item => item.shot.id === id)?.start ?? null; }
export function editorBusy() { return Boolean(drag || pendingNotes.size); }
export function testHooks() { return { get audio() { return audio; }, get pps() { return pps; }, get playhead() { return playhead; }, flushNotes }; }
