// Optional local QA for library episode folders and the resizable preview monitor: installed Chrome over CDP, synthetic media only, no model requests.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'shot-library-groups-browser-'));
const app = await createApp({ dataDir: join(scratch, 'data') });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, socket;
try {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  chrome = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--autoplay-policy=no-user-gesture-required',
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
  async function until(expression, tries = 100) {
    for (let n = 0; n < tries; n++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error(`Browser condition timed out: ${expression}; toast=${await evaluate(`document.querySelector('#toast')?.textContent`)}; errors=${browserErrors.join(' | ')}`);
  }
  const idle = `!document.body.hasAttribute('aria-busy')`;
  const shoot = async name => { const shot = await command('Page.captureScreenshot', { format: 'png' }); await writeFile(join(root, 'test-results', name), Buffer.from(shot.data, 'base64')); };
  const rect = async selector => evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}; })()`);
  await mkdir(join(root, 'test-results'), { recursive: true });
  await command('Runtime.enable'); await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1512, height: 1100, deviceScaleFactor: 1, mobile: false });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8ioAAAAASUVORK5CYII=', 'base64');
  await fetch(url + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench': '1' }, body: JSON.stringify({ title: 'QA' }) });
  for (const name of ['ep02 v1.png', 'ep02 v2.png', 'ep03 v1.png', 'ep02 v10.png', 'ep02 v12.png', 'ep02 v11.png', 'meme.png'])
    assert.equal((await fetch(`${url}/api/library/import?filename=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Workbench': '1' }, body: png })).ok, true);
  await command('Page.navigate', { url });
  await until(`document.querySelector('#save-state')?.textContent.includes('所有修改已保存')`);
  await evaluate(`document.querySelector('#toggle-library').click()`);
  await until(`document.querySelectorAll('.library-asset').length===7`);
  const groups = await evaluate(`[...document.querySelectorAll('.library-group')].map(g=>({label:g.querySelector('summary span').textContent,open:g.open,items:[...g.querySelectorAll('.library-asset strong')].map(s=>s.textContent)}))`);
  assert.deepEqual(groups.map(g => g.label), ['EP03', 'EP02', '其他'], 'newest episode first, unsorted last');
  assert.deepEqual(groups[1].items, ['ep02 v12.png', 'ep02 v11.png', 'ep02 v10.png', 'ep02 v2.png', 'ep02 v1.png'], 'versions descending, numeric');
  assert.deepEqual(groups.map(g => g.open), [true, false, true], 'older episodes folded by default');
  // Folding is remembered across a refresh.
  await evaluate(`document.querySelector('.library-group[data-group="ep2"] summary').click()`);
  await command('Page.reload'); await delay(800); await until(`document.querySelector('#save-state')?.textContent.includes('所有修改已保存')`); await until(`document.querySelectorAll('.library-group').length===3`);
  assert.equal(await evaluate(`document.querySelector('.library-group[data-group="ep2"]').open`), true);
  // Search opens every match.
  await evaluate(`(()=>{const s=document.querySelector('#library-search');s.value='v1';s.dispatchEvent(new Event('input'));})()`);
  assert.equal(await evaluate(`[...document.querySelectorAll('.library-group')].every(g=>g.open)`), true);
  // Image viewer.
  await evaluate(`document.querySelector('.library-asset img').click()`);
  assert.equal(await evaluate(`document.querySelector('#viewer-dialog').open && !!document.querySelector('#viewer-stage img')`), true);
  await shoot('library-viewer.png'); await evaluate(`document.querySelector('#viewer-dialog').close()`);
  // Preview monitor: ⤢ enlarges, drag handle resizes, width persists, ⤡ restores.
  await evaluate(`document.querySelector('#toggle-library').click()`);
  await until(`!document.querySelector('#editor').hidden`);
  const small = (await rect('#editor-monitor')).w;
  await evaluate(`document.querySelector('#monitor-bigger').click()`);
  const big = (await rect('#editor-monitor')).w;
  assert.ok(big > small * 2, `bigger: ${small} -> ${big}`);
  assert.ok((await rect('#editor-monitor')).h >= big * 0.56 - 2, 'height follows 16:9');
  const handle = await rect('#monitor-resize'), from = { x: handle.x + handle.w / 2, y: handle.y + 40 }, to = { x: from.x - 150, y: from.y };
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 6; step++) await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * step / 6, y: from.y, button: 'left', buttons: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', buttons: 0, clickCount: 1 });
  const dragged = (await rect('#editor-monitor')).w;
  assert.ok(Math.abs(dragged - (big - 150)) < 12, `drag resize: ${big} -> ${dragged}`);
  await shoot('monitor-enlarged.png');
  await command('Page.reload'); await delay(800); await until(`document.querySelector('#save-state')?.textContent.includes('所有修改已保存')`); await until(`!document.querySelector('#editor').hidden`);
  assert.ok(Math.abs((await rect('#editor-monitor')).w - dragged) < 3, 'width remembered');
  await evaluate(`document.querySelector('#monitor-bigger').click()`);
  assert.ok((await rect('#editor-monitor')).w < 210, 'restore');
  assert.deepEqual(browserErrors, []);
  console.log('PASS: library grouped by episode (newest first), versions descending, fold state remembered, search opens matches, image viewer; preview monitor enlarge / drag resize / persist / restore. No model requests.');
} finally {
  if (socket) socket.close();
  if (chrome && chrome.exitCode === null) { const ended = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill(); await Promise.race([ended, delay(3000)]); }
  await app.close();
  const absolute = resolve(scratch);
  if (!absolute.startsWith(resolve(tmpdir()) + sep + 'shot-library-groups-browser-')) throw new Error('Refusing cleanup outside test scratch directory');
  await rm(absolute, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(error => console.error(`Test scratch cleanup incomplete: ${error.message}`));
}
