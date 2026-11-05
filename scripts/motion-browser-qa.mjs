// Optional local QA for micro-motion: installed Chrome with software WebGL (SwiftShader) over CDP; synthetic still only.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'shot-motion-browser-'));
const app = await createApp({ dataDir: join(scratch, 'data') });
const delay = ms => new Promise(done => setTimeout(done, ms));
let chrome, socket;
try {
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  chrome = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-sync', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${join(scratch, 'chrome')}`, 'about:blank'
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('Chrome startup timed out')), 20000); let output = '';
    chrome.on('error', error => { clearTimeout(timer); fail(error); });
    chrome.stderr.on('data', chunk => { output += chunk; const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output); if (match) { clearTimeout(timer); done(`http://127.0.0.1:${match[1]}`); } });
  });
  socket = new WebSocket((await (await fetch(endpoint + '/json')).json()).find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }); });
  let sequence = 0; const waiting = new Map(), browserErrors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const entry = waiting.get(message.id);
    if (entry) { waiting.delete(message.id); message.error ? entry.fail(new Error(JSON.stringify(message.error))) : entry.done(message.result); }
  });
  const command = (method, params = {}) => new Promise((done, fail) => {
    const id = ++sequence; const timeout = setTimeout(() => { waiting.delete(id); fail(new Error(`CDP timed out: ${method}`)); }, 30000);
    waiting.set(id, { done: result => { clearTimeout(timeout); done(result); }, fail: error => { clearTimeout(timeout); fail(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  async function until(expression, tries = 150) {
    for (let n = 0; n < tries; n++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error(`Browser condition timed out: ${expression}; toast=${await evaluate(`document.querySelector('#toast')?.textContent`)}; errors=${browserErrors.join(' | ')}`);
  }
  const idle = `!document.body.hasAttribute('aria-busy')`;
  const shoot = async name => { const shot = await command('Page.captureScreenshot', { format: 'png' }); await writeFile(join(root, 'test-results', name), Buffer.from(shot.data, 'base64')); };
  async function drag(from, to) {
    const r = await evaluate(`(() => { const r=document.querySelector('#motion-layer').getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}; })()`);
    const at = ([fx, fy]) => ({ x: r.x + r.w * fx, y: r.y + r.h * fy }), a = at(from), b = at(to);
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...a, button: 'left', buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 5; step++) await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + (b.x - a.x) * step / 5, y: a.y + (b.y - a.y) * step / 5, button: 'left', buttons: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...b, button: 'left', buttons: 0, clickCount: 1 });
  }
  await mkdir(join(root, 'test-results'), { recursive: true });
  await command('Runtime.enable'); await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1512, height: 1100, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url });
  await until(`document.querySelector('#save-state')?.textContent.includes('所有修改已保存')`);
  await evaluate(`document.querySelector('#new-project').click(); document.querySelector('#name-input').value='微动 QA'; document.querySelector('#name-form').requestSubmit();`);
  await until(`document.querySelector('#project-title').textContent==='微动 QA' && ${idle}`);
  // 540x960 still: background, a "head" circle and a striped "hand" block that should tremble.
  await evaluate(`(async () => {
    const c=document.createElement('canvas'); c.width=540; c.height=960; const g=c.getContext('2d');
    g.fillStyle='#2b3a4a'; g.fillRect(0,0,540,960); g.fillStyle='#e8d6b0'; g.beginPath(); g.arc(270,330,120,0,7); g.fill();
    for(let i=0;i<14;i++){ g.fillStyle=i%2?'#ffcc66':'#884422'; g.fillRect(330+i*10,640,10,120); }
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    const t=new DataTransfer(); t.items.add(new File([blob],'hand-still.png',{type:'image/png'}));
    const input=document.querySelector('#file-input'); input.files=t.files; input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await until(`document.querySelector('.shot-card img')?.complete && document.querySelector('.shot-card img').naturalWidth===540 && ${idle}`);
  assert.equal(await evaluate(`document.querySelector('.edit-motion').disabled`), false);
  await evaluate(`document.querySelector('.edit-motion').click()`);
  await until(`document.querySelector('#motion-dialog').open && ${idle}`);
  assert.deepEqual(await evaluate(`[document.querySelector('#motion-canvas').width, document.querySelector('#motion-canvas').height]`), [540, 960]);
  // Box the hand (x 0.6–0.88, y 0.66–0.8) with real mouse input; default effect is tremble.
  await drag([0.6, 0.66], [0.88, 0.8]);
  await until(`document.querySelectorAll('.motion-row').length===1`);
  // Exact-pixel checks on the renderer: outside identical to the source, inside moves, loop seamless.
  const check = await evaluate(`(async () => {
    const { testHooks } = await import('/motion.js'); const { renderer, draft } = testHooks(); const gl = renderer.gl;
    const img = new Image(); img.src = document.querySelector('.shot-card img').src; await img.decode();
    const c = document.createElement('canvas'); c.width = 540; c.height = 960; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const src = g.getImageData(0, 0, 540, 960).data;
    const read = t => { renderer.render(t, draft); const out = new Uint8Array(540 * 960 * 4); gl.readPixels(0, 0, 540, 960, gl.RGBA, gl.UNSIGNED_BYTE, out); return out; };
    const at = (buf, x, y) => [...buf.slice(((959 - y) * 540 + x) * 4, ((959 - y) * 540 + x) * 4 + 3)]; // GL rows are bottom-up
    const a = read(0.13), b = read(0.37), zero = read(0), one = read(1);
    let outsideDiff = 0, insideMoved = 0, seam = 0;
    for (let y = 0; y < 960; y += 3) for (let x = 0; x < 540; x += 3) {
      const inside = x >= 324 && x < 475 && y >= 634 && y < 768;
      const s = [src[(y * 540 + x) * 4], src[(y * 540 + x) * 4 + 1], src[(y * 540 + x) * 4 + 2]];
      if (!inside) { const p = at(a, x, y); if (p.some((v, i) => Math.abs(v - s[i]) > 0)) outsideDiff++; }
      else { if (at(a, x, y).some((v, i) => v !== at(b, x, y)[i])) insideMoved++; if (at(zero, x, y).some((v, i) => Math.abs(v - at(one, x, y)[i]) > 1)) seam++; }
    }
    return { outsideDiff, insideMoved, seam };
  })()`);
  assert.equal(check.outsideDiff, 0, 'pixels outside the box are exactly the original');
  assert.ok(check.insideMoved > 50, 'the boxed hand actually moves: ' + check.insideMoved);
  assert.equal(check.seam, 0, 'loop start and end frames match');
  // Flow: ripples inside the box only, still seamless.
  await evaluate(`(() => { const s=document.querySelector('#motion-list select'); s.value='flow'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  const flow = await evaluate(`(async () => {
    const { testHooks } = await import('/motion.js'); const { renderer, draft } = testHooks(); const gl = renderer.gl;
    const read = t => { renderer.render(t, draft); const out = new Uint8Array(540 * 960 * 4); gl.readPixels(0, 0, 540, 960, gl.RGBA, gl.UNSIGNED_BYTE, out); return out; };
    const a = read(0.2), b = read(0.6), zero = read(0), one = read(1); let moved = 0, seam = 0, outside = 0;
    for (let i = 0; i < a.length; i += 12) { const x = (i / 4) % 540, y = 959 - Math.floor(i / 4 / 540), inside = x >= 324 && x < 475 && y >= 634 && y < 768;
      if (inside && a[i] !== b[i]) moved++; if (Math.abs(zero[i] - one[i]) > 1) seam++; if (!inside && a[i] !== b[i]) outside++; }
    return { moved, seam, outside };
  })()`);
  assert.ok(flow.moved > 50, 'flow ripples the box: ' + flow.moved); assert.equal(flow.seam, 0, 'flow loops seamlessly'); assert.equal(flow.outside, 0, 'flow stays inside the box');
  // 2.5D parallax: upload a depth map (near circle = head, far background) through the dialog's file input; the camera unlocks.
  assert.equal(await evaluate(`document.querySelector('#motion-camera select').disabled`), true, 'camera needs a depth map');
  await evaluate(`(async () => {
    const c=document.createElement('canvas'); c.width=270; c.height=480; const g=c.getContext('2d');
    const grad=g.createLinearGradient(0,0,0,480); grad.addColorStop(0,'#000'); grad.addColorStop(1,'#666'); g.fillStyle=grad; g.fillRect(0,0,270,480);
    g.fillStyle='#fff'; g.beginPath(); g.arc(135,165,60,0,7); g.fill();
    const blob=await new Promise(r=>c.toBlob(r,'image/png')); const t=new DataTransfer(); t.items.add(new File([blob],'hand-depth.png',{type:'image/png'}));
    const input=document.querySelector('#motion-depth-input'); input.files=t.files; input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await until(`!document.querySelector('#motion-camera select').disabled && document.querySelector('#motion-camera select').value==='push' && ${idle}`);
  await evaluate(`(() => { const s=document.querySelector('#motion-camera select'); s.value='pan'; s.dispatchEvent(new Event('change',{bubbles:true})); const f=[...document.querySelectorAll('#motion-camera input')][2]; f.value='100'; f.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const camera = await evaluate(`(async () => {
    const { testHooks } = await import('/motion.js'); const { renderer, draft } = testHooks(); const gl = renderer.gl;
    const read = t => { renderer.render(t, draft); const out = new Uint8Array(540 * 960 * 4); gl.readPixels(0, 0, 540, 960, gl.RGBA, gl.UNSIGNED_BYTE, out); return out; };
    const a = read(0.25), b = read(0.75), zero = read(0), one = read(1);
    const changed = (u, v, x0, x1, y0, y1) => { let n = 0; for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const i = ((959 - y) * 540 + x) * 4; if (Math.abs(u[i] - v[i]) + Math.abs(u[i + 1] - v[i + 1]) > 6) n++; } return n; };
    // Focus 100 = the white head stays put; the far background (left edge of the head) slides.
    return { head: changed(a, b, 230, 310, 290, 370), edge: changed(a, b, 120, 170, 260, 400), seam: changed(zero, one, 0, 540, 0, 960) };
  })()`);
  assert.ok(camera.edge > 30, 'background slides against the head: ' + JSON.stringify(camera));
  assert.ok(camera.head < camera.edge / 10, 'focus layer (head) stays nearly still: ' + JSON.stringify(camera));
  assert.equal(camera.seam, 0, 'camera loop is seamless');
  await evaluate(`(() => { const s=document.querySelector('#motion-list select'); s.value='tremble'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  // Switch to sway, pick a pivot at the wrist, shorten the loop, save.
  await evaluate(`(() => { const s=document.querySelector('.motion-row select'); s.value='sway'; s.dispatchEvent(new Event('change',{bubbles:true})); [...document.querySelectorAll('#motion-list .motion-sliders button')][0].click(); })()`);
  await until(`document.querySelector('#motion-layer').classList.contains('picking')`);
  const layer = await evaluate(`(() => { const r=document.querySelector('#motion-layer').getBoundingClientRect(); return {x:r.left+r.width*0.6,y:r.top+r.height*0.73}; })()`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...layer, button: 'left', buttons: 1, clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...layer, button: 'left', buttons: 0, clickCount: 1 });
  await evaluate(`(() => { const d=document.querySelector('#motion-duration'); d.value='2'; d.dispatchEvent(new Event('change',{bubbles:true})); const r=document.querySelector('#motion-list .motion-sliders input'); r.value='7'; r.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await shoot('motion-dialog.png');
  await evaluate(`document.querySelector('#motion-save').click()`);
  const projectId = app.store.listProjects()[0].id;
  for (let n = 0; n < 30 && !app.store.detail(projectId).shots[0].motion; n++) await delay(100);
  const saved = JSON.parse(app.store.detail(projectId).shots[0].motion);
  assert.deepEqual([saved.duration_ms, saved.regions[0].effect, saved.regions[0].strength], [2000, 'sway', 7]);
  assert.deepEqual(saved.camera, { move: 'pan', strength: 4, cycles: 1, focus: 100 }); assert.equal(app.store.media(saved.depth_media_id).filename, 'hand-depth.png');
  assert.ok(Math.abs(saved.regions[0].pivot_x - 6000) < 40 && Math.abs(saved.regions[0].pivot_y - 7300) < 40, 'pivot placed where clicked: ' + JSON.stringify(saved.regions[0]));
  // Export one loop; it becomes a new video take while the still stays as the rig's source.
  await until(`${idle}`);
  await evaluate(`document.querySelector('#motion-export').click()`);
  await until(`!document.querySelector('#motion-dialog').open && ${idle} && document.querySelector('.shot-card video')`, 300);
  const takes = app.store.detail(projectId).shots[0].takes;
  assert.equal(takes.length, 2); assert.match(takes[0].mime, /^video\//); assert.match(takes[0].filename, /微动\.(mp4|webm)$/);
  await until(`document.querySelector('.shot-card video').readyState>=1`);
  const duration = await evaluate(`(async () => { const v=document.querySelector('.shot-card video'); if (v.duration===Infinity) { v.currentTime=1e9; await new Promise(r=>v.addEventListener('durationchange',r,{once:true})); } return v.duration; })()`);
  // Optional: KEEP_MOTION_FILE=path keeps the exported MP4 for inspection with ffprobe/ffmpeg.
  if (process.env.KEEP_MOTION_FILE) { const { copyFile } = await import('node:fs/promises'); await copyFile(join(scratch, 'data', 'media', app.store.media(takes[0].media_id).stored_name), process.env.KEEP_MOTION_FILE); }
  assert.ok(Math.abs(duration - 2) < 0.05, 'exported loop is 2 s: ' + duration);
  assert.match(await evaluate(`document.querySelector('.edit-motion').textContent`), /微动 · 1 · 镜头/);
  // Reopening edits the original still, not the exported video.
  await evaluate(`document.querySelector('.edit-motion').click()`);
  await until(`document.querySelector('#motion-dialog').open && document.querySelectorAll('.motion-row').length===1 && ${idle}`);
  assert.equal(await evaluate(`document.querySelector('.motion-row select').value`), 'sway');
  await until(`document.querySelector('#motion-camera select').value==='pan' && !document.querySelector('#motion-camera select').disabled`);
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await delay(300);
  const wide = await evaluate(`(() => { const d=document.querySelector('#motion-dialog'), limit=d.getBoundingClientRect().right; return [...d.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>limit+1).map(e=>e.tagName+'.'+e.className+'#'+e.id+':'+Math.round(e.getBoundingClientRect().width)).slice(0,6); })()`);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('#motion-dialog').scrollWidth <= document.querySelector('#motion-dialog').clientWidth + 1`), true, 'mobile dialog should not overflow: ' + JSON.stringify(wide));
  await shoot('motion-mobile.png');
  assert.deepEqual(browserErrors, []);
  console.log(`PASS: micro-motion WebGL render (outside pixels exact, inside moves, seamless loop), flow, depth-map upload + parallax pan (focus layer still, background slides, seamless), mouse box, effect switch, pivot pick, save, ${takes[0].filename.split('.').pop()} export as new take (~${duration.toFixed(2)} s), reopen from the still, mobile. No model requests.`);
} finally {
  if (socket) socket.close();
  if (chrome && chrome.exitCode === null) { const ended = new Promise(done => chrome.once('exit', done)); chrome.kill(); await Promise.race([ended, delay(3000)]); }
  await app.close();
  const absolute = resolve(scratch);
  if (!absolute.startsWith(resolve(tmpdir()) + sep + 'shot-motion-browser-')) throw new Error('Refusing cleanup outside test scratch directory');
  await rm(absolute, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(error => console.error(`Test scratch cleanup incomplete: ${error.message}`));
}
