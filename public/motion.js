import { muxMp4 } from './mp4.js';
// Micro-motion for stills: feathered boxes that tremble, shake, breathe, sway, float, blink or flow.
// A WebGL shader warps only inside the boxes (weight 0 outside, so outside pixels are the original),
// and every effect completes whole cycles per loop so the exported clip loops seamlessly.
// Optional 2.5D parallax: a depth map (white = near) shifts each pixel by its distance from the focus depth
// as a camera pushes, pans, tilts or orbits; a slight zoom keeps the shifted edges inside the frame.
const $ = selector => document.querySelector(selector);
const SCALE = 10000, MIN = 50, MAX_REGIONS = 8;
export const effects = {
  tremble: { label: '颤抖', hz: 8, hint: '手发抖、害怕' },
  shake: { label: '震动', hz: 6, hint: '爆气、受冲击' },
  breathe: { label: '呼吸', hz: 0.35, hint: '待机起伏（支点在底部）' },
  sway: { label: '摆动', hz: 0.6, hint: '头发、披风、手臂（支点=固定端）' },
  float: { label: '漂浮', hz: 0.5, hint: '道具、特效上下飘' },
  blink: { label: '眨眼', hz: 0.3, hint: '框住眼睛，定时闭合' },
  flow: { label: '流动', hz: 0.5, hint: '火焰、水、烟、旗帜（支点=流向）' }
};
export const cameraMoves = { none: '不动', push: '推近', pan: '左右摇', tilt: '上下摇', orbit: '绕圈' };
const effectIds = Object.keys(effects), moveIds = Object.keys(cameraMoves);
const defaultCamera = { move: 'none', strength: 4, cycles: 1, focus: 50 };
let ctx, draft = null, renderer = null, image = null, frame = 0, playing = true, started = 0, drawing = null, pivotFor = null, busy = false;

export function defaultPivot(effect, box) {
  const cx = Math.round(box.x + box.w / 2);
  if (effect === 'breathe') return { pivot_x: cx, pivot_y: box.y + box.h };
  if (effect === 'sway' || effect === 'flow') return { pivot_x: cx, pivot_y: box.y };
  return { pivot_x: cx, pivot_y: Math.round(box.y + box.h / 2) };
}
const VERTEX = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';
const FRAGMENT = `precision highp float;
uniform sampler2D u_image; uniform sampler2D u_depth; uniform vec2 u_size; uniform float u_time; uniform int u_count;
uniform vec4 u_box[8]; uniform vec4 u_param[8]; uniform vec2 u_pivot[8];
uniform vec4 u_cam; uniform float u_zoom;
const float TAU = 6.28318530718;
vec2 frameAt(vec2 q) { return (0.5 * u_size + (q - 0.5 * u_size) / u_zoom) / u_size; }
// Camera offset in pixels for the point q: (depth - focus) * amplitude, so the focus depth stays still.
vec2 parallax(vec2 q) {
  float k = (texture2D(u_depth, frameAt(q)).r - u_cam.w) * u_cam.y, ph = TAU * u_cam.z * u_time;
  if (u_cam.x < 1.5) return (q - 0.5 * u_size) / (0.5 * u_size.y) * k * (0.5 - 0.5 * cos(ph));
  if (u_cam.x < 2.5) return vec2(sin(ph), 0.0) * k;
  if (u_cam.x < 3.5) return vec2(0.0, sin(ph)) * k;
  return vec2(sin(ph), 0.5 * (cos(ph) - 1.0)) * k;
}
float wave(float t, float c, float seed) {
  return sin(TAU * c * t + seed) * 0.6 + sin(TAU * c * 2.0 * t + seed * 1.7) * 0.3 + sin(TAU * c * 3.0 * t + seed * 2.9) * 0.1;
}
vec2 rot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
void main() {
  vec2 p = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  vec2 shift = vec2(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= u_count) break;
    vec4 b = u_box[i]; vec4 q = u_param[i]; vec2 pv = u_pivot[i];
    float d = min(min(p.x - b.x, b.x + b.z - p.x), min(p.y - b.y, b.y + b.w - p.y));
    if (d <= 0.0) continue;
    float w = smoothstep(0.0, max(q.w * min(b.z, b.w), 1.0), d);
    float effect = q.x, k = q.y, c = q.z; vec2 s = p;
    if (effect < 0.5) s = p - vec2(wave(u_time, c, 1.3), wave(u_time, c, 4.1)) * k * 0.0004 * u_size.y;
    else if (effect < 1.5) s = pv + rot(p - pv, -wave(u_time, c, 2.2) * k * 0.004) - vec2(wave(u_time, c, 0.7), wave(u_time, c, 5.3)) * k * 0.0015 * u_size.y;
    else if (effect < 2.5) { float g = sin(TAU * c * u_time) * k * 0.006; s = pv + (p - pv) / (1.0 + vec2(g * 0.35, g)); }
    else if (effect < 3.5) s = pv + rot(p - pv, -sin(TAU * c * u_time) * k * 0.012);
    else if (effect < 4.5) s = p - vec2(0.0, sin(TAU * c * u_time) * k * 0.0015 * u_size.y);
    else if (effect < 5.5) { float ph = fract(c * u_time); float shut = ph < 0.06 ? sin(3.14159265 * ph / 0.06) : 0.0;
      s = vec2(p.x, pv.y + (p.y - pv.y) / max(1.0 - 0.95 * shut * k / 10.0, 0.05)); }
    else { vec2 dir = pv - (b.xy + 0.5 * b.zw); dir = length(dir) > 1.0 ? normalize(dir) : vec2(0.0, -1.0); vec2 n = vec2(-dir.y, dir.x);
      float along = dot(p, dir) / u_size.y, across = dot(p, n) / u_size.y; // ripples travel toward the pivot
      float ph = TAU * (along * 18.0 + 0.35 * sin(TAU * across * 6.0) - c * u_time), ph2 = TAU * (along * 41.0 - across * 9.0 - 2.0 * c * u_time);
      s = p - (n * sin(ph) * 0.0006 + dir * sin(ph2) * 0.0003) * k * u_size.y; }
    shift += w * (s - p);
  }
  vec2 q = p + shift;
  if (u_cam.y > 0.0) { vec2 target = q; for (int n = 0; n < 3; n++) q = target - parallax(q); } // invert the depth-dependent shift
  gl_FragColor = texture2D(u_image, frameAt(q));
}`;
// Renders the still with the rig at loop phase t (0..1). Exported so QA can read exact pixels.
export function createRenderer(canvas, source) {
  canvas.width = source.naturalWidth; canvas.height = source.naturalHeight;
  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false });
  if (!gl) throw new Error('浏览器不支持 WebGL，无法预览微动');
  const shader = (type, text) => { const s = gl.createShader(type); gl.shaderSource(s, text); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const program = gl.createProgram(); gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX)); gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT)); gl.linkProgram(program); gl.useProgram(program);
  const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const at = gl.getAttribLocation(program, 'p'); gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
  const texture = unit => {
    const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, value);
    return t;
  };
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  texture(0); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  const depthTexture = texture(1); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));
  const u = name => gl.getUniformLocation(program, name);
  const W = canvas.width, H = canvas.height;
  gl.viewport(0, 0, W, H); gl.uniform2f(u('u_size'), W, H); gl.uniform1i(u('u_image'), 0); gl.uniform1i(u('u_depth'), 1);
  let hasDepth = false;
  return {
    gl, width: W, height: H,
    setDepth(depth) {
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, depthTexture);
      if (depth) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, depth);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));
      hasDepth = Boolean(depth);
    },
    render(t, rig) {
      // Amplitude is 0.4% of the frame height per strength step for a full near-to-far depth difference.
      const cam = { ...defaultCamera, ...rig.camera }, on = hasDepth && cam.move !== 'none';
      const amp = on ? cam.strength * 0.004 * H : 0, reach = amp * Math.max(cam.focus, 100 - cam.focus) / 100;
      gl.uniform4f(u('u_cam'), moveIds.indexOf(cam.move), amp, cam.cycles, cam.focus / 100);
      gl.uniform1f(u('u_zoom'), on ? 1 / (1 - 2 * reach / Math.min(W, H)) : 1);
      const boxes = new Float32Array(32), params = new Float32Array(32), pivots = new Float32Array(16), seconds = rig.duration_ms / 1000;
      rig.regions.slice(0, 8).forEach((r, i) => {
        boxes.set([r.x * W / SCALE, r.y * H / SCALE, r.w * W / SCALE, r.h * H / SCALE], i * 4);
        params.set([effectIds.indexOf(r.effect), r.strength, Math.max(1, Math.round(r.speed * effects[r.effect].hz * seconds)), r.feather / 100], i * 4);
        pivots.set([r.pivot_x * W / SCALE, r.pivot_y * H / SCALE], i * 2);
      });
      gl.uniform1f(u('u_time'), t); gl.uniform1i(u('u_count'), Math.min(8, rig.regions.length));
      gl.uniform4fv(u('u_box'), boxes); gl.uniform4fv(u('u_param'), params); gl.uniform2fv(u('u_pivot'), pivots);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  };
}

// ---- dialog ---------------------------------------------------------------------------
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }
function loop(now) {
  if (!draft || !renderer) return;
  if (playing) renderer.render(((now - started) % draft.duration_ms) / draft.duration_ms, draft);
  frame = requestAnimationFrame(loop);
}
function boxNode(box, index, className) {
  const node = el('div', className); Object.assign(node.style, { left: box.x / 100 + '%', top: box.y / 100 + '%', width: box.w / 100 + '%', height: box.h / 100 + '%' });
  node.append(el('span', '', String(index + 1))); return node;
}
function renderLayer() {
  const layer = $('#motion-layer'); layer.replaceChildren();
  draft.regions.forEach((r, i) => {
    const node = boxNode(r, i, 'region-box motion-box'); node.classList.toggle('selected', draft.selected === i); layer.append(node);
    const pivot = el('div', 'motion-pivot'); pivot.style.left = r.pivot_x / 100 + '%'; pivot.style.top = r.pivot_y / 100 + '%'; pivot.title = `支点 ${i + 1}`; layer.append(pivot);
  });
  if (drawing?.box) layer.append(boxNode(drawing.box, draft.regions.length, 'region-box drawing'));
  layer.classList.toggle('picking', pivotFor != null);
}
function renderList() {
  const list = $('#motion-list'); list.replaceChildren();
  draft.regions.forEach((r, i) => {
    const row = el('div', 'motion-row'); row.classList.toggle('selected', draft.selected === i);
    const head = el('div', 'motion-row-head'); head.append(el('span', 'region-badge', String(i + 1)));
    const effect = el('select'); effect.setAttribute('aria-label', `区域 ${i + 1} 的效果`);
    for (const [id, e] of Object.entries(effects)) effect.add(new Option(`${e.label} · ${e.hint}`, id));
    effect.value = r.effect;
    effect.addEventListener('change', () => { r.effect = effect.value; Object.assign(r, defaultPivot(r.effect, r)); renderLayer(); });
    const remove = el('button', 'text-button', '删除'); remove.addEventListener('click', () => { draft.regions.splice(i, 1); draft.selected = null; renderList(); renderLayer(); summary(); });
    head.append(effect, remove);
    const sliders = el('div', 'motion-sliders');
    for (const [field, label, min, max, step] of [['strength', '强度', 1, 10, 1], ['speed', '速度', 0.25, 4, 0.25], ['feather', '羽化', 0, 50, 1]]) {
      const wrap = el('label', '', label), input = el('input'), value = el('small', '', String(r[field]));
      Object.assign(input, { type: 'range', min, max, step, value: r[field] }); input.setAttribute('aria-label', `区域 ${i + 1} ${label}`);
      input.addEventListener('input', () => { r[field] = Number(input.value); value.textContent = input.value; });
      wrap.append(input, value); sliders.append(wrap);
    }
    const pick = el('button', '', pivotFor === i ? '在画面上点一下…' : '点选支点');
    pick.addEventListener('click', () => { pivotFor = pivotFor === i ? null : i; renderList(); renderLayer(); });
    sliders.append(pick);
    row.addEventListener('pointerdown', () => { if (draft.selected !== i) { draft.selected = i; for (const other of list.children) other.classList.toggle('selected', other === row); renderLayer(); } });
    row.append(head, sliders); list.append(row);
  });
}
const cameraOn = () => Boolean(draft.depth) && draft.camera.move !== 'none';
function renderCamera() {
  const box = $('#motion-camera'); box.replaceChildren();
  const head = el('div', 'motion-row-head'); head.append(el('span', 'region-badge', '镜'));
  const move = el('select'); move.setAttribute('aria-label', '镜头运动'); move.disabled = !draft.depth;
  for (const [id, label] of Object.entries(cameraMoves)) move.add(new Option(id === 'none' ? '镜头 · 不动' : `镜头 · ${label}`, id));
  move.value = draft.camera.move;
  move.addEventListener('change', () => { draft.camera.move = move.value; summary(); });
  const pick = el('button', 'text-button', draft.depth ? '换深度图' : '上传深度图'); pick.addEventListener('click', () => $('#motion-depth-input').click());
  head.append(move, pick);
  if (draft.depth) {
    const remove = el('button', 'text-button', '移除');
    remove.addEventListener('click', () => { draft.depth = null; draft.camera.move = 'none'; renderer.setDepth(null); renderCamera(); summary(); });
    head.append(remove);
  }
  const sliders = el('div', 'motion-sliders');
  for (const [field, label, min, max, step] of [['strength', '幅度', 1, 10, 1], ['cycles', '圈数', 1, 4, 1], ['focus', '焦点', 0, 100, 5]]) {
    const wrap = el('label', '', label), input = el('input'), value = el('small', '', String(draft.camera[field]));
    Object.assign(input, { type: 'range', min, max, step, value: draft.camera[field], disabled: !draft.depth }); input.setAttribute('aria-label', `镜头${label}`);
    input.addEventListener('input', () => { draft.camera[field] = Number(input.value); value.textContent = input.value; });
    wrap.append(input, value); sliders.append(wrap);
  }
  const hint = el('p', 'motion-hint', draft.depth
    ? `深度图${draft.depth.filename ? '：' + draft.depth.filename : '已载入'}。焦点=不动的那一层（0 远、100 近），比焦点近的跟镜头走，远的反方向。`
    : '2.5D 视差：上传一张同比例的深度图（白=近、黑=远，例如 Depth Anything 生成），再选镜头运动。');
  box.append(head, sliders, hint);
}
async function loadDepth(mediaId, filename) {
  const depth = new Image(); depth.src = `/media/${mediaId}`;
  await depth.decode().catch(() => { throw new Error('深度图无法读取'); });
  if (Math.abs(depth.naturalWidth / depth.naturalHeight - image.naturalWidth / image.naturalHeight) > 0.02 * image.naturalWidth / image.naturalHeight) {
    throw new Error(`深度图比例 ${depth.naturalWidth}×${depth.naturalHeight} 跟原图 ${image.naturalWidth}×${image.naturalHeight} 不一致`);
  }
  renderer.setDepth(depth); draft.depth = { media_id: mediaId, filename };
}
async function uploadDepth(file) {
  const result = await ctx.api(`/api/shots/${draft.shotId}/depth?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
  await loadDepth(result.media_id, result.filename);
  if (draft.camera.move === 'none') draft.camera.move = 'push';
  renderCamera(); summary(); ctx.toast('深度图已载入，记得保存设置');
}
function summary() {
  const parts = [];
  if (draft.regions.length) parts.push(`${draft.regions.length} 个动作区域`);
  if (cameraOn()) parts.push(`镜头${cameraMoves[draft.camera.move]}`);
  $('#motion-summary').textContent = parts.length
    ? `${parts.join(' · ')} · 循环 ${draft.duration_ms / 1000} 秒。${cameraOn() ? '整张按深度视差移动，边缘略放大。' : '框外画面保持原图。'}`
    : '按住鼠标框出要动的地方（手、眼睛、头发、身体…），再选效果；有深度图时也可以只加镜头运动。';
  $('#motion-export').disabled = !parts.length;
}
function point(event) {
  const rect = $('#motion-layer').getBoundingClientRect(), clamp = v => Math.min(SCALE, Math.max(0, Math.round(v * SCALE)));
  return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
}
function rigPayload() {
  return JSON.stringify({
    source_take_id: draft.take.id, duration_ms: draft.duration_ms,
    regions: draft.regions.map(({ x, y, w, h, effect, strength, speed, feather, pivot_x, pivot_y }) => ({ x, y, w, h, effect, strength, speed, feather, pivot_x, pivot_y })),
    depth_media_id: draft.depth?.media_id ?? null, camera: draft.depth ? draft.camera : { ...draft.camera, move: 'none' }
  });
}
async function saveRig() {
  const shot = ctx.shotById(draft.shotId);
  const updated = await ctx.api(`/api/shots/${shot.id}`, { method: 'PATCH', body: JSON.stringify({ revision: shot.revision, motion: rigPayload() }) });
  shot.revision = updated.revision; shot.motion = updated.motion; return shot;
}
function recorderType() {
  for (const type of ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']) if (window.MediaRecorder?.isTypeSupported(type)) return type;
  return null;
}
const FPS = 30;
const fileName = ext => `${draft.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60)}-微动.${ext}`;
// Baseline H.264 never uses B-frames, which keeps the hand-written MP4 simple; pick the lowest level that fits.
async function encoderConfig(width, height) {
  if (!window.VideoEncoder || width % 2 || height % 2) return null;
  for (const codec of ['avc1.420028', 'avc1.42002a', 'avc1.420032', 'avc1.420033', 'avc1.420034']) {
    const config = { codec, width, height, bitrate: 10_000_000, framerate: FPS, avc: { format: 'avc' } };
    try { if ((await VideoEncoder.isConfigSupported(config)).supported) return config; } catch { /* try the next level */ }
  }
  return null;
}
// Offline, frame-exact export: frame i shows loop phase i/N with timestamp i/30 s, independent of machine speed.
async function encodeExact(config) {
  const canvas = $('#motion-canvas'), total = Math.round(draft.duration_ms / 1000 * FPS), chunks = [];
  let description = null, failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => { const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data); chunks.push({ data, key: chunk.type === 'key' }); if (meta?.decoderConfig?.description) description = new Uint8Array(meta.decoderConfig.description); },
    error: error => { failure = error; }
  });
  encoder.configure(config);
  for (let i = 0; i < total; i++) {
    if (failure) throw failure;
    renderer.render(i / total, draft);
    const image = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
    encoder.encode(image, { keyFrame: i % FPS === 0 }); image.close();
    if (encoder.encodeQueueSize > 4) await new Promise(resolve => encoder.addEventListener('dequeue', resolve, { once: true }));
    if (i % 5 === 0) { $('#motion-summary').textContent = `正在生成循环视频 ${i + 1} / ${total} 帧…`; await new Promise(resolve => setTimeout(resolve, 0)); }
  }
  await encoder.flush(); encoder.close();
  if (failure) throw failure;
  if (!description || chunks.length !== total) throw new Error('视频编码不完整，请重试');
  return new File([muxMp4({ width: canvas.width, height: canvas.height, fps: FPS, chunks, description })], fileName('mp4'), { type: 'video/mp4' });
}
// Fallback for browsers without WebCodecs H.264: real-time capture, length depends on machine speed.
async function recordRealtime() {
  const type = recorderType(); if (!type) throw new Error('这个浏览器不能录制视频，请用新版 Chrome / Edge');
  const canvas = $('#motion-canvas'), stream = canvas.captureStream(0), track = stream.getVideoTracks()[0], chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 12_000_000 });
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  const done = new Promise(resolve => { recorder.onstop = resolve; });
  const length = draft.duration_ms;
  await new Promise(resolve => { recorder.onstart = resolve; recorder.start(); });
  const begin = performance.now();
  await new Promise(resolve => {
    const tick = now => {
      const elapsed = now - begin;
      renderer.render(Math.min(elapsed, length - 1) / length, draft); track.requestFrame?.();
      $('#motion-summary').textContent = `正在录制循环 ${(Math.min(elapsed, length) / 1000).toFixed(1)} / ${length / 1000} 秒…`;
      if (elapsed >= length) setTimeout(() => { recorder.stop(); resolve(); }, 40); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await done; stream.getTracks().forEach(t => t.stop());
  return new File(chunks, fileName(type.startsWith('video/mp4') ? 'mp4' : 'webm'), { type: type.split(';')[0] });
}
async function record() {
  cancelAnimationFrame(frame); playing = false;
  const canvas = $('#motion-canvas'), config = await encoderConfig(canvas.width, canvas.height);
  return config ? encodeExact(config) : recordRealtime();
}
export function setupMotion(context) {
  ctx = context;
  const layer = $('#motion-layer');
  layer.addEventListener('pointerdown', event => {
    if (!draft || event.button !== 0) return;
    if (pivotFor != null) {
      const p = point(event); Object.assign(draft.regions[pivotFor], { pivot_x: p.x, pivot_y: p.y }); pivotFor = null; renderList(); renderLayer(); return;
    }
    if (draft.regions.length >= MAX_REGIONS) { ctx.toast(`最多 ${MAX_REGIONS} 个动作区域`, true); return; }
    layer.setPointerCapture(event.pointerId); drawing = { from: point(event), box: null }; event.preventDefault();
  });
  layer.addEventListener('pointermove', event => {
    if (!drawing) return;
    const to = point(event), from = drawing.from;
    drawing.box = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
    renderLayer();
  });
  const finish = () => {
    if (!drawing) return; const box = drawing.box; drawing = null;
    if (box && box.w >= MIN && box.h >= MIN) {
      draft.regions.push({ ...box, effect: 'tremble', strength: 4, speed: 1, feather: 25, ...defaultPivot('tremble', box) });
      draft.selected = draft.regions.length - 1; renderList(); summary();
    }
    renderLayer();
  };
  layer.addEventListener('pointerup', finish); layer.addEventListener('pointercancel', finish);
  $('#motion-play').addEventListener('click', () => { playing = !playing; started = performance.now(); $('#motion-play').textContent = playing ? '❚❚' : '▶'; });
  $('#motion-duration').addEventListener('change', () => {
    const value = Math.round(Number($('#motion-duration').value) * 1000);
    draft.duration_ms = Math.min(10000, Math.max(1000, Number.isFinite(value) ? value : 4000)); $('#motion-duration').value = draft.duration_ms / 1000; summary();
  });
  $('#motion-depth-input').addEventListener('change', event => {
    const file = event.target.files[0]; event.target.value = '';
    if (file && draft) ctx.action(() => uploadDepth(file));
  });
  $('#motion-save').addEventListener('click', () => ctx.action(async () => { await saveRig(); ctx.toast('微动设置已保存'); }));
  $('#motion-export').addEventListener('click', () => {
    if (busy) return; busy = true;
    ctx.action(async () => {
      try {
        const shot = await saveRig();
        const file = await record();
        const result = await ctx.api(`/api/shots/${shot.id}/takes?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Shot-Revision': String(shot.revision) }, body: file });
        const seconds = draft.duration_ms / 1000;
        $('#motion-dialog').close(); await ctx.reload(shot.project_id);
        ctx.toast(`已导出 ${seconds} 秒循环视频为 v${result.number}；原图版本保留，可随时回来调整`);
      } finally { busy = false; playing = true; }
    });
  });
  $('#motion-dialog').addEventListener('close', () => { cancelAnimationFrame(frame); renderer = null; image = null; draft = null; pivotFor = null; drawing = null; });
}
function sourceTake(shot) {
  let rig = null; try { rig = shot.motion ? JSON.parse(shot.motion) : null; } catch { rig = null; }
  const take = shot.takes.find(t => t.id === rig?.source_take_id) || shot.takes.find(t => t.id === shot.active_take_id);
  return take?.mime?.startsWith('image/') ? { take, rig: rig?.source_take_id === take.id ? rig : null } : null;
}
async function open(shot) {
  const source = sourceTake(shot); if (!source) throw new Error('微动需要一张图片版本');
  image = new Image(); image.src = `/media/${source.take.media_id}`;
  await image.decode().catch(() => { throw new Error('图片无法读取'); });
  draft = { shotId: shot.id, title: shot.title, take: source.take, duration_ms: source.rig?.duration_ms ?? 4000, regions: (source.rig?.regions ?? []).map(r => ({ ...r })), selected: null,
    depth: null, camera: { ...defaultCamera, ...source.rig?.camera } };
  const canvas = $('#motion-canvas');
  renderer = createRenderer(canvas, image);
  if (source.rig?.depth_media_id) await loadDepth(source.rig.depth_media_id, '').catch(error => { draft.camera.move = 'none'; ctx.toast(error.message, true); });
  $('#motion-heading').textContent = `微动 · ${shot.title}`; $('#motion-duration').value = draft.duration_ms / 1000;
  playing = true; started = performance.now(); $('#motion-play').textContent = '❚❚';
  renderLayer(); renderList(); renderCamera(); summary();
  $('#motion-dialog').showModal(); frame = requestAnimationFrame(loop);
}
export function bindMotionCard(card, shot) {
  const button = card.querySelector('.edit-motion'), source = sourceTake(shot);
  const count = source?.rig?.regions.length || 0, camera = source?.rig?.camera?.move && source.rig.camera.move !== 'none';
  button.textContent = ['✦ 微动', count && String(count), camera && '镜头'].filter(Boolean).join(' · ');
  button.disabled = !source;
  button.title = source ? '框出手、眼睛、头发等，让静图小幅动起来' : '微动需要一张图片版本';
  button.addEventListener('click', () => ctx.action(() => open(ctx.shotById(shot.id))));
}
export function testHooks() { return { get renderer() { return renderer; }, get draft() { return draft; } }; }
