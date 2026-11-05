// Optional local QA for link downloads: installed Chrome over CDP with a fake yt-dlp (tests/fixtures/fake-ytdlp.mjs); no network.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'shot-downloads-browser-'));
const app = await createApp({ dataDir: join(scratch, 'data'), ytdlp: { command: process.execPath, prefix: [join(root, 'tests', 'fixtures', 'fake-ytdlp.mjs')] } });
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
  await mkdir(join(root, 'test-results'), { recursive: true });
  await command('Runtime.enable'); await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1512, height: 1100, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url });
  await until(`document.querySelector('#save-state')?.textContent.includes('所有修改已保存')`);
  assert.equal(await evaluate(`document.querySelector('#downloads').disabled`), true, 'needs a project');
  await evaluate(`document.querySelector('#new-project').click(); document.querySelector('#name-input').value='下载 QA'; document.querySelector('#name-form').requestSubmit();`);
  await until(`document.querySelector('#project-title').textContent==='下载 QA' && ${idle} && !document.querySelector('#downloads').disabled`);
  await evaluate(`document.querySelector('#downloads').click()`);
  await until(`document.querySelector('#downloads-dialog').open && document.querySelector('#downloads-list').textContent.includes('还没有下载')`);
  assert.equal(await evaluate(`document.querySelector('#downloads-tool').hidden`), true, 'tool found, no install hint');
  const submit = async (link, kind) => evaluate(`(() => { document.querySelector('#downloads-url').value=${JSON.stringify(link)}; document.querySelector('#downloads-kind').value='${kind}'; document.querySelector('#downloads-form').requestSubmit(); })()`);
  // A failing link shows yt-dlp's own reason; a cancelled slow one stops; a good one becomes a shot.
  await submit('https://www.youtube.com/watch?v=fail', 'video');
  await until(`document.querySelector('.download-item.failed')?.textContent.includes('Video unavailable') && ${idle}`);
  await submit('https://example.com/slow', 'audio');
  await until(`[...document.querySelectorAll('.download-item.running button')].length===1 && ${idle}`);
  await shoot('downloads-dialog.png');
  await evaluate(`document.querySelector('.download-item.running button').click()`);
  await until(`document.querySelector('.download-item.cancelled') && ${idle}`);
  await submit('https://www.youtube.com/watch?v=abc', 'video');
  await evaluate(`document.querySelector('#downloads-dialog').close()`);
  await until(`document.querySelectorAll('.shot-card').length===1 && document.querySelector('.shot-card video') && ${idle}`, 200);
  await until(`document.querySelector('#toast').textContent.includes('下载完成') && document.querySelector('#toast').textContent.includes('新片段')`);
  const projectId = app.store.listProjects()[0].id, shot = app.store.detail(projectId).shots[0];
  assert.equal(shot.notes, '来源：https://www.youtube.com/watch?v=abc\n作者：Some Channel');
  await submit('https://www.tiktok.com/@a/video/1', 'audio');
  for (let n = 0; n < 100 && !app.library.list().length; n++) await delay(50);
  assert.equal(app.library.list()[0].source_url, 'https://www.tiktok.com/@a/video/1');
  assert.equal(app.store.detail(projectId).shots.length, 1, 'audio adds no shot');
  await evaluate(`document.querySelector('#downloads').click()`);
  await until(`document.querySelectorAll('.download-item').length===4 && document.querySelectorAll('.download-item.done').length===2`);
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await delay(300);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('#downloads-dialog').scrollWidth <= document.querySelector('#downloads-dialog').clientWidth + 1`), true, 'mobile dialog should not overflow');
  await shoot('downloads-mobile.png');
  assert.deepEqual(browserErrors, []);
  console.log('PASS: link downloads dialog (fake yt-dlp): disabled without project, failure reason shown, cancel, video → new shot with source notes and auto refresh, audio → library with source URL, list of 4, mobile. No network.');
} finally {
  if (socket) socket.close();
  if (chrome && chrome.exitCode === null) { const ended = new Promise(done => chrome.once('exit', done)); chrome.kill(); await Promise.race([ended, delay(3000)]); }
  await app.close();
  const absolute = resolve(scratch);
  if (!absolute.startsWith(resolve(tmpdir()) + sep + 'shot-downloads-browser-')) throw new Error('Refusing cleanup outside test scratch directory');
  await rm(absolute, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(error => console.error(`Test scratch cleanup incomplete: ${error.message}`));
}
