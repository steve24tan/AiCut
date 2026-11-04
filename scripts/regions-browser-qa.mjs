// Optional local QA for frame regions: installed Chrome over CDP, synthetic media only, no model requests.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'shot-regions-browser-'));
const app = await createApp({ dataDir: join(scratch, 'data') });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, socket;
try {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  chrome = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-sync', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${join(scratch, 'chrome')}`, 'about:blank'
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 20000); let output = '';
    chrome.on('error', error => { clearTimeout(timer); reject(error); });
    chrome.stderr.on('data', chunk => { output += chunk; const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  socket = new WebSocket((await (await fetch(endpoint + '/json')).json()).find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const waiting = new Map(), browserErrors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const entry = waiting.get(message.id);
    if (entry) { waiting.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); }
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; const timeout = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 20000);
    waiting.set(id, { resolve: result => { clearTimeout(timeout); resolve(result); }, reject: error => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  async function until(expression) {
    for (let n = 0; n < 100; n++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error(`Browser condition timed out: ${expression}; toast=${await evaluate(`document.querySelector('#toast')?.textContent`)}; summary=${await evaluate(`document.querySelector('#region-summary')?.textContent`)}`);
  }
  const shoot = async name => { const shot = await command('Page.captureScreenshot', { format: 'png' }); await writeFile(join(root, 'test-results', name), Buffer.from(shot.data, 'base64')); };
  // Drag inside the dialog layer from/to fractions of the picture with real mouse input.
  async function drag(from, to) {
    const rect = await evaluate(`(() => { const r=document.querySelector('#region-layer').getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}; })()`);
    const at = ([fx, fy]) => ({ x: rect.x + rect.w * fx, y: rect.y + rect.h * fy });
    const a = at(from), b = at(to);
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...a, button: 'left', buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 5; step++) await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + (b.x - a.x) * step / 5, y: a.y + (b.y - a.y) * step / 5, button: 'left', buttons: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...b, button: 'left', buttons: 0, clickCount: 1 });
    return rect;
  }
  await mkdir(join(root, 'test-results'), { recursive: true });
  await command('Runtime.enable'); await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1512, height: 1100, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url });
  await until(`document.querySelector('#save-state')?.textContent.includes('所有修改已保存')`);
  await evaluate(`document.querySelector('#new-project').click(); document.querySelector('#name-input').value='框选 QA'; document.querySelector('#name-form').requestSubmit();`);
  await until(`document.querySelector('#project-title').textContent==='框选 QA' && !document.querySelector('#name-dialog').open && !document.body.hasAttribute('aria-busy')`);
  // Portrait still with a distinct "sword" block in the lower right.
  await evaluate(`(async () => {
    const canvas=document.createElement('canvas'); canvas.width=540; canvas.height=960; const g=canvas.getContext('2d');
    g.fillStyle='#2b3a4a'; g.fillRect(0,0,540,960); g.fillStyle='#e8d6b0'; g.beginPath(); g.arc(270,380,120,0,7); g.fill();
    g.fillStyle='#9aa4ad'; g.fillRect(340,700,140,40); g.fillStyle='#fff'; g.font='32px sans-serif'; g.fillText('SWORD',350,690);
    const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));
    const transfer=new DataTransfer(); transfer.items.add(new File([blob],'chibi-sword.png',{type:'image/png'}));
    const input=document.querySelector('#file-input'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await until(`document.querySelector('.shot-card img')?.complete && document.querySelector('.shot-card img').naturalWidth===540 && !document.body.hasAttribute('aria-busy')`);
  assert.equal(await evaluate(`document.querySelector('.edit-regions').disabled`), false);
  await evaluate(`document.querySelector('.edit-regions').click()`);
  await until(`document.querySelector('#region-dialog').open && document.querySelector('.region-media')?.complete && document.querySelector('#region-layer').getBoundingClientRect().width>50 && !document.body.hasAttribute('aria-busy')`);
  assert.equal(await evaluate(`document.querySelector('#region-player').hidden`), true, 'stills have no player');
  // Layer must sit exactly on the picture.
  assert.equal(await evaluate(`(() => { const a=document.querySelector('#region-layer').getBoundingClientRect(), b=document.querySelector('.region-media').getBoundingClientRect(); return [a.left-b.left,a.top-b.top,a.width-b.width,a.height-b.height].every(v=>Math.abs(v)<1); })()`), true);
  await drag([0.6, 0.7], [0.9, 0.8]);
  await drag([0.1, 0.1], [0.101, 0.101]); // too small: ignored
  assert.equal(await evaluate(`document.querySelectorAll('.region-row').length`), 1);
  assert.equal(await evaluate(`document.activeElement===document.querySelector('.region-row textarea')`), true, 'new box focuses its note');
  await evaluate(`(() => { const t=document.querySelector('.region-row textarea'); t.value='剑换成金色，其他不变'; t.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  assert.match(await evaluate(`document.querySelector('.region-meta').textContent`), /右下 · 宽 30% × 高 10%/);
  await drag([0.15, 0.2], [0.85, 0.5]);
  await evaluate(`(() => { const t=document.querySelectorAll('.region-row textarea')[1]; t.value='表情改成震惊'; t.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await shoot('regions-dialog.png');
  // Exports: capture the blobs instead of downloading.
  await evaluate(`window.__blobs=[]; const original=URL.createObjectURL; URL.createObjectURL=b=>{window.__blobs.push(b); return original(b);}; HTMLAnchorElement.prototype.click=function(){window.__names=(window.__names||[]).concat(this.download)};`);
  await evaluate(`document.querySelector('#region-export-frame').click(); document.querySelector('#region-export-mask').click();`);
  await until(`window.__blobs.length===2`);
  const exported = await evaluate(`(async () => {
    const out=[]; for (const blob of window.__blobs) { const bmp=await createImageBitmap(blob); const c=new OffscreenCanvas(bmp.width,bmp.height); const g=c.getContext('2d'); g.drawImage(bmp,0,0);
      const px=(x,y)=>[...g.getImageData(x,y,1,1).data].slice(0,3); out.push({w:bmp.width,h:bmp.height,inside:px(410,720),outside:px(20,940),edge:px(Math.round(540*0.6)+1,Math.round(960*0.75))}); }
    return {out,names:window.__names};
  })()`);
  if (/_mask\.png$/.test(exported.names[0])) { exported.out.reverse(); exported.names.reverse(); }
  assert.deepEqual(exported.out.map(item => [item.w, item.h]), [[540, 960], [540, 960]], 'exports keep source size');
  assert.deepEqual(exported.out[1].inside, [255, 255, 255]); assert.deepEqual(exported.out[1].outside, [0, 0, 0]);
  assert.ok(exported.out[0].edge[0] > exported.out[0].edge[1] * 2 && exported.out[0].edge[0] > 120, 'annotated frame has a red box edge: ' + exported.out[0].edge);
  assert.deepEqual(exported.out[0].outside, [43, 58, 74], 'annotated frame keeps original pixels outside');
  assert.match(exported.names[1], /_mask\.png$/);
  await evaluate(`document.querySelector('#region-save').click()`);
  await until(`!document.querySelector('#region-dialog').open && !document.body.hasAttribute('aria-busy')`);
  const project = app.store.listProjects()[0], saved = app.store.detail(project.id).shots[0];
  assert.equal(saved.regions.length, 2);
  const first = saved.regions[0];
  for (const [actual, expected] of [[first.x, 6000], [first.y, 7000], [first.w, 3000], [first.h, 1000]]) assert.ok(Math.abs(actual - expected) <= 30, `box ${actual} ≈ ${expected}`);
  assert.equal(first.note, '剑换成金色，其他不变');
  assert.match(await evaluate(`document.querySelector('.edit-regions').textContent`), /框选 · 2/);
  // Card overlay sits on the letterboxed picture, not the grey bars.
  // Compare with the image's own content box (clientWidth/Height exclude the stage border).
  await until(`document.querySelector('.card-regions')?.hidden===false`);
  const overlay = await evaluate(`(() => { const o=document.querySelector('.card-regions'), stage=document.querySelector('.shot-card .media-stage'), img=stage.querySelector('img'); const s=img.getBoundingClientRect(), r=o.getBoundingClientRect(); const scale=Math.min(s.width/540,s.height/960), w=540*scale, h=960*scale; return {ok:Math.abs(r.height-h)<1.5 && Math.abs(r.width-w)<1.5 && Math.abs(r.left-(s.left+(s.width-w)/2))<1.5 && Math.abs(r.top-(s.top+(s.height-h)/2))<1.5, r:[r.left,r.top,r.width,r.height], img:[s.left,s.top,s.width,s.height]}; })()`);
  assert.ok(overlay.ok, 'card overlay matches picture: ' + JSON.stringify(overlay));
  await evaluate(`Object.defineProperty(navigator,'clipboard',{value:{writeText:async t=>{window.__copied=t;}}}); document.querySelector('.copy-request').click()`);
  await until(`typeof window.__copied==='string'`);
  const copied = await evaluate('window.__copied');
  assert.match(copied, /【画面框选 · 只改框内/); assert.match(copied, /#1 右下 · 左 60(\.\d)?% 上 70(\.\d)?%/); assert.match(copied, /要求：剑换成金色/); assert.match(copied, /框外：构图、角色、背景/);
  assert.doesNotMatch(copied, /本段 0s/, 'stills have no time range text');
  await shoot('regions-card.png');
  // Video: box drawn on a paused frame starts at that segment time and dims on the card outside its span.
  await evaluate(`(async () => {
    const canvas=document.createElement('canvas'); canvas.width=320; canvas.height=180; const g=canvas.getContext('2d');
    const stream=canvas.captureStream(20), chunks=[]; const recorder=new MediaRecorder(stream,{mimeType:'video/webm'});
    const done=new Promise(r=>{recorder.onstop=r}); recorder.ondataavailable=e=>chunks.push(e.data); recorder.start();
    for(let i=0;i<50;i++){g.fillStyle='#26351e';g.fillRect(0,0,320,180);g.fillStyle='#c6ed9a';g.fillRect(20+i*5,80,30,30);await new Promise(r=>setTimeout(r,50));}
    recorder.stop(); await done; stream.getTracks().forEach(t=>t.stop());
    document.querySelector('#add-shot').click(); document.querySelector('#name-input').value='视频段'; document.querySelector('#name-form').requestSubmit();
    window.__clip=new File(chunks,'motion.webm',{type:'video/webm'});
  })()`);
  await until(`document.querySelectorAll('.shot-card').length===2 && !document.body.hasAttribute('aria-busy')`);
  await evaluate(`(() => { document.querySelectorAll('.shot-card')[1].querySelector('.import-take').click(); const t=new DataTransfer(); t.items.add(window.__clip); const input=document.querySelector('#file-input'); input.files=t.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await until(`document.querySelectorAll('.shot-card')[1].querySelector('video')?.readyState>=1 && !document.body.hasAttribute('aria-busy')`);
  await evaluate(`document.querySelectorAll('.shot-card')[1].querySelector('.edit-regions').click()`);
  await until(`document.querySelector('#region-dialog').open && document.querySelector('.region-media')?.readyState>=2 && !document.querySelector('#region-player').hidden && !document.body.hasAttribute('aria-busy')`);
  await evaluate(`document.querySelector('.region-media').currentTime=1.2`);
  await until(`!document.querySelector('.region-media').seeking && Math.abs(document.querySelector('.region-media').currentTime-1.2)<0.05`);
  await drag([0.4, 0.3], [0.7, 0.7]);
  const start = await evaluate(`Number(document.querySelector('.region-row-actions input').value)`);
  assert.ok(Math.abs(start - 1.2) < 0.06, `box start ${start}s follows the paused frame`);
  await evaluate(`(() => { const inputs=document.querySelectorAll('.region-row-actions input'); inputs[1].value='0.5'; inputs[1].dispatchEvent(new Event('input',{bubbles:true})); })()`);
  assert.equal(await evaluate(`document.querySelector('#region-save').disabled`), true, 'end before start blocks save');
  await evaluate(`(() => { const inputs=document.querySelectorAll('.region-row-actions input'); inputs[1].value=''; inputs[1].dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.region-row textarea').value='方块改成红色'; document.querySelector('.region-row textarea').dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await evaluate(`document.querySelector('.region-media').currentTime=0.2`);
  await until(`document.querySelector('#region-layer .region-box').classList.contains('inactive')`);
  await shoot('regions-video-dialog.png');
  await evaluate(`document.querySelector('#region-save').click()`);
  await until(`!document.querySelector('#region-dialog').open && !document.body.hasAttribute('aria-busy')`);
  const videoBox = app.store.detail(project.id).shots[1].regions[0];
  assert.ok(Math.abs(videoBox.start_ms - 1200) <= 60 && videoBox.end_ms === null && videoBox.note === '方块改成红色');
  await until(`document.querySelectorAll('.shot-card')[1].querySelector('.card-regions')?.hidden===false`);
  await evaluate(`(() => { const v=document.querySelectorAll('.shot-card')[1].querySelector('video'); v.currentTime=0.1; })()`);
  await until(`document.querySelectorAll('.shot-card')[1].querySelector('.card-regions .region-box').classList.contains('inactive')`);
  await evaluate(`(() => { const v=document.querySelectorAll('.shot-card')[1].querySelector('video'); v.currentTime=1.8; })()`);
  await until(`!document.querySelectorAll('.shot-card')[1].querySelector('.card-regions .region-box').classList.contains('inactive')`);
  // Clearing all boxes persists as an empty set.
  await evaluate(`document.querySelectorAll('.shot-card')[1].querySelector('.edit-regions').click()`);
  await until(`document.querySelector('#region-dialog').open && document.querySelectorAll('.region-row').length===1 && !document.body.hasAttribute('aria-busy')`);
  await evaluate(`document.querySelector('.region-row-actions button:last-child').click(); document.querySelector('#region-save').click();`);
  await until(`!document.querySelector('#region-dialog').open && !document.body.hasAttribute('aria-busy')`);
  assert.equal(app.store.detail(project.id).shots[1].regions.length, 0);
  // Mobile: the dialog must not push the page sideways.
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await evaluate(`document.querySelector('.edit-regions').click()`);
  await until(`document.querySelector('#region-dialog').open && document.querySelector('.region-media')?.complete && !document.body.hasAttribute('aria-busy')`);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('#region-dialog').scrollWidth <= document.querySelector('#region-dialog').clientWidth + 1`), true, 'mobile dialog should not overflow');
  await shoot('regions-mobile.png');
  assert.deepEqual(browserErrors, []);
  console.log('PASS: still + video framing, mouse drawing, tiny-box rejection, notes, time range validation, PNG/mask export, save/clear, card overlay letterboxing, copy text, mobile. No model requests.');
} finally {
  if (socket) socket.close();
  if (chrome && chrome.exitCode === null) { const ended = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill(); await Promise.race([ended, delay(3000)]); }
  await app.close();
  const absolute = resolve(scratch);
  if (!absolute.startsWith(resolve(tmpdir()) + sep + 'shot-regions-browser-')) throw new Error('Refusing cleanup outside test scratch directory');
  await rm(absolute, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(error => console.error(`Test scratch cleanup incomplete: ${error.message}`));
}
