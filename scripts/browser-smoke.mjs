// Optional local QA: uses the installed Chrome and Node's built-in CDP WebSocket.
// No browser download, extension or production data is needed.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'shot-browser-'));
const app = await createApp({ dataDir: join(scratch, 'data'), executor: async job => ({ revised_prompt: job.snapshot.shot.prompt + ' · CLI revised', summary: 'Synthetic task executor; no model request.' }) });
let chrome, socket;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  console.log('QA: local server ready');
  chrome = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-sync', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${join(scratch, 'chrome')}`, 'about:blank'
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 20000);
    let output = '';
    chrome.on('error', error => { clearTimeout(timer); reject(error); });
    chrome.stderr.on('data', chunk => {
      output += chunk;
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  const tabs = await (await fetch(endpoint + '/json')).json();
  console.log('QA: Chrome ready');
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const waiting = new Map(); const browserErrors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails.text);
    const entry = waiting.get(message.id);
    if (entry) { waiting.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); }
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 15000);
    waiting.set(id, { resolve: result => { clearTimeout(timeout); resolve(result); }, reject: error => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  async function until(expression) {
    for (let n = 0; n < 100; n++) { if (await evaluate(expression)) return; await delay(100); }
    const diagnostics = await evaluate(`JSON.stringify({toast:document.querySelector('#toast')?.textContent,save:document.querySelector('#save-state')?.textContent,summary:document.querySelector('#segment-summary')?.textContent,applyDisabled:document.querySelector('#apply-segments')?.disabled})`);
    throw new Error(`Browser condition timed out: ${expression}; ${diagnostics}`);
  }
  await command('Runtime.enable'); await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1512, height: 1100, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url });
  await until(`document.querySelector('#save-state')?.textContent.includes('所有修改已保存')`);
  console.log('QA: page loaded');
  await evaluate(`document.querySelector('#new-project').click(); document.querySelector('#name-input').value='创作实验 · 本地分镜'; document.querySelector('#name-form').requestSubmit();`);
  await until(`document.querySelector('#project-title').textContent==='创作实验 · 本地分镜' && !document.querySelector('#name-dialog').open`);
  const samples = [
    { title: '开场 · 建立环境', prompt: '夜晚的街道，镜头缓慢推进。暖色窗光与冷色路面形成对比。', notes: '镜头再慢一点，保留街道环境。', status: 'approved' },
    { title: '转身 · 角色反应', prompt: '角色听见声音后，缓慢转头，面部保持一致。', notes: '转头慢一点，最后停顿一秒，其他保持。', status: 'revise' },
    { title: '结尾 · 留白', prompt: '镜头停在角色的背影，远处灯光渐暗。', notes: '留两秒空白，用于后期放标题。', status: 'todo' }
  ];
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    await evaluate(`document.querySelector('#add-shot').click(); document.querySelector('#name-input').value=${JSON.stringify(sample.title)}; document.querySelector('#name-form').requestSubmit();`);
    await until(`document.querySelectorAll('.shot-card').length===${index + 1} && !document.querySelector('#name-dialog').open`);
    await evaluate(`(() => { const card=document.querySelectorAll('.shot-card')[${index}]; const fields=${JSON.stringify(sample)}; for(const key of ['prompt','notes','status']) { const input=card.querySelector('[data-field="'+key+'"]'); input.value=fields[key]; input.dispatchEvent(new Event('input',{bubbles:true})); } })()`);
    await until(`document.querySelector('#save-state').textContent.includes('所有修改已保存')`);
  }
  const dbProject = app.store.detail(app.store.listProjects()[0].id);
  console.log('QA: created three shots and autosaved');
  assert.equal(dbProject.shots[1].notes, samples[1].notes);
  // File chooser import exercises the actual page event and browser upload path.
  const pngPath = join(scratch, 'reference.png');
  await writeFile(pngPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8ioAAAAASUVORK5CYII=', 'base64'));
  await evaluate(`document.querySelectorAll('.shot-card')[1].querySelector('.import-take').click()`);
  const { root: domRoot } = await command('DOM.getDocument');
  const { nodeId } = await command('DOM.querySelector', { nodeId: domRoot.nodeId, selector: '#file-input' });
  await command('DOM.setFileInputFiles', { nodeId, files: [pngPath] });
  await until(`document.querySelectorAll('.shot-card')[1].querySelector('img')?.complete && !document.body.hasAttribute('aria-busy')`);
  assert.equal(app.store.detail(dbProject.id).shots[1].takes.length, 1);
  await evaluate(`document.querySelectorAll('.shot-card')[1].querySelector('.inspect-take').click()`);
  assert.match(await evaluate(`document.querySelector('#text-content').value`), /转头慢一点/);
  await evaluate(`document.querySelector('#text-dialog [data-close]').click()`);
  // Verify the clipboard fallback contains the current segment context without permissions.
  await evaluate(`Object.defineProperty(navigator, 'clipboard', {value:{writeText:async()=>{throw new Error('QA fallback')}}}); document.querySelectorAll('.shot-card')[1].querySelector('.copy-request').click()`);
  await until(`document.querySelector('#text-dialog').open`);
  assert.match(await evaluate(`document.querySelector('#text-content').value`), /片段：02 · 转身/);
  await evaluate(`document.querySelector('#text-dialog [data-close]').click()`);
  // Generate a tiny local WebM through the browser, then exercise import + playback.
  await evaluate(`(async () => {
    const canvas=document.createElement('canvas'); canvas.width=320; canvas.height=180;
    const ctx=canvas.getContext('2d');
    const stream=canvas.captureStream(20), chunks=[];
    const recorder=new MediaRecorder(stream,{mimeType:'video/webm'});
    const done=new Promise(resolve=>{recorder.onstop=resolve}); recorder.ondataavailable=e=>chunks.push(e.data); recorder.start();
    for(let i=0;i<60;i++){ctx.fillStyle='#26351e';ctx.fillRect(0,0,320,180);ctx.fillStyle='#c6ed9a';ctx.font='18px sans-serif';ctx.fillText('LOCAL PREVIEW / TAKE 02',30,85);ctx.fillRect(30,112,20+(i%12)*18,3);await new Promise(resolve=>setTimeout(resolve,50));}
    recorder.stop();await done;stream.getTracks().forEach(t=>t.stop());
    document.querySelectorAll('.shot-card')[1].querySelector('.import-take').click();
    const transfer=new DataTransfer();transfer.items.add(new File(chunks,'local-preview.webm',{type:'video/webm'}));
    const input=document.querySelector('#file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await until(`document.querySelectorAll('.shot-card')[1].querySelector('video')?.readyState>=2 && !document.body.hasAttribute('aria-busy')`);
  await evaluate(`(() => { const video=document.querySelectorAll('.shot-card')[1].querySelector('video'); video.muted=true; return video.play(); })()`);
  await delay(250);
  assert.ok(await evaluate(`document.querySelectorAll('.shot-card')[1].querySelector('video').currentTime>0`));
  assert.equal(app.store.detail(dbProject.id).shots[1].takes.length, 2);
  await evaluate(`document.querySelectorAll('.shot-card')[1].querySelector('.split-video').click()`);
  await until(`document.querySelector('#segment-dialog').open && !document.querySelector('#apply-segments').disabled && !document.body.hasAttribute('aria-busy')`);
  assert.equal(await evaluate(`document.querySelectorAll('.cut-row').length`), 4);
  const firstCut = await evaluate(`Number(document.querySelector('.cut-row input').value)`);
  // Add and remove a playhead cut, then customize the first boundary.
  await evaluate(`document.querySelector('#segment-video').currentTime=${firstCut / 2}`);
  await delay(150);
  await evaluate(`document.querySelector('#cut-here').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.cut-row').length`), 5);
  await evaluate(`document.querySelector('.cut-row button:last-child').click()`);
  await evaluate(`(() => { const input=document.querySelector('.cut-row input');input.value=(${firstCut}-0.05).toFixed(3);input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await mkdir(join(root, 'test-results'), { recursive: true });
  const splitScreenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(root, 'test-results', 'segmentation-dialog.png'), Buffer.from(splitScreenshot.data, 'base64'));
  await evaluate(`document.querySelector('#apply-segments').click()`);
  await until(`document.querySelectorAll('.shot-card').length===7 && !document.querySelector('#segment-dialog').open && !document.body.hasAttribute('aria-busy')`);
  let segmented = app.store.detail(dbProject.id);
  assert.equal(segmented.shots[1].takes[0].end_ms, Math.round((firstCut - 0.05) * 1000));
  assert.equal(new Set(segmented.shots.slice(1,6).map(shot=>shot.takes[0].media_id)).size,1);
  await evaluate(`(() => { const input=document.querySelectorAll('.shot-card')[2].querySelector('[data-field=notes]');input.value='只改这一小段';input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await until(`document.querySelector('#save-state').textContent.includes('所有修改已保存')`);
  assert.equal(app.store.detail(dbProject.id).shots[1].notes, samples[1].notes);
  const secondRange = segmented.shots[2].takes[0];
  await evaluate(`(() => { const video=document.querySelectorAll('.shot-card')[2].querySelector('video');video.muted=true;return video.play(); })()`);
  await delay((secondRange.end_ms - secondRange.start_ms) * 1.7);
  const playing = await evaluate(`(() => { const v=document.querySelectorAll('.shot-card')[2].querySelector('video');return {time:v.currentTime,paused:v.paused}; })()`);
  assert.ok(playing.time >= secondRange.start_ms / 1000 - 0.01 && playing.time < secondRange.end_ms / 1000 + 0.05);
  assert.equal(playing.paused, false);
  await evaluate(`(() => { const card=document.querySelectorAll('.shot-card')[2];card.querySelector('.loop-segment').checked=false;card.querySelector('video').currentTime=${secondRange.end_ms / 1000 - 0.07}; })()`);
  await delay(300);
  assert.equal(await evaluate(`document.querySelectorAll('.shot-card')[2].querySelector('video').paused`), true);
  await evaluate(`document.querySelectorAll('.shot-card')[2].querySelector('.copy-request').click()`);
  await until(`document.querySelector('#text-dialog').open`);
  assert.match(await evaluate(`document.querySelector('#text-content').value`), /原视频范围/);
  await evaluate(`document.querySelector('#text-dialog [data-close]').click();document.querySelectorAll('.shot-card')[2].querySelector('.trim-range').click()`);
  await until(`document.querySelector('#segment-dialog').open && !document.querySelector('#apply-segments').disabled && !document.body.hasAttribute('aria-busy')`);
  await evaluate(`document.querySelector('#trim-start').value=${(secondRange.start_ms + 20) / 1000};document.querySelector('#trim-start').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#apply-segments').click()`);
  await until(`!document.querySelector('#segment-dialog').open && !document.body.hasAttribute('aria-busy')`);
  segmented = app.store.detail(dbProject.id);
  assert.equal(segmented.shots[2].takes.length, 2);
  assert.equal(segmented.shots[2].takes[0].start_ms, secondRange.start_ms + 20);
  // Exercise native-dispatch UI with an injected synthetic executor; never call a model.
  const beforeCli = app.store.detail(dbProject.id).shots[2];
  await evaluate(`document.querySelectorAll('.shot-card')[2].querySelector('.job-provider').value='claude';document.querySelectorAll('.shot-card')[2].querySelector('.push-job').click()`);
  await until(`document.querySelectorAll('.shot-card')[2].querySelector('.job-state').textContent.includes('待采用') && !document.body.hasAttribute('aria-busy')`);
  assert.equal(app.store.shot(beforeCli.id).prompt, beforeCli.prompt);
  await evaluate(`document.querySelectorAll('.shot-card')[2].querySelector('.job-actions button').click()`);
  await until(`document.querySelector('#text-dialog').open`);
  assert.match(await evaluate(`document.querySelector('#text-content').value`), /CLI revised/);
  await evaluate(`document.querySelector('#text-dialog [data-close]').click();[...document.querySelectorAll('.shot-card')[2].querySelectorAll('.job-actions button')].find(b=>b.textContent==='采用结果').click()`);
  await until(`document.querySelectorAll('.shot-card')[2].querySelector('[data-field=prompt]').value.endsWith('CLI revised') && !document.body.hasAttribute('aria-busy')`);
  assert.equal(app.store.shot(beforeCli.id).active_take_id, beforeCli.active_take_id);
  // Reload through the UI and verify data retrieval independently of page memory.
  await command('Page.reload');
  await delay(600);
  await until(`document.querySelectorAll('.shot-card').length===7 && document.querySelectorAll('.shot-card')[1].querySelector('video')?.readyState>=1`);
  assert.equal(await evaluate(`document.querySelectorAll('.shot-card')[1].querySelector('[data-field=notes]').value`), samples[1].notes);
  await mkdir(join(root, 'test-results'), { recursive: true });
  await evaluate(`window.scrollTo(0,0)`);
  const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(root, 'test-results', 'browser-smoke.png'), Buffer.from(screenshot.data, 'base64'));
  await evaluate(`document.querySelectorAll('.shot-card')[2].scrollIntoView({block:'center'})`);
  const cliScreenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(root, 'test-results', 'cli-jobs.png'), Buffer.from(cliScreenshot.data, 'base64'));
  // Import from an actual external CLI subprocess while a user draft is pending.
  await evaluate(`(() => { const input=document.querySelector('.shot-card [data-field=notes]');input.value='Keep my edit while CLI imports';input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await promisify(execFile)(process.execPath, ['cli.mjs', 'import', dbProject.id, pngPath, '--title', 'CLI imported reference'], { cwd: root, env: { ...process.env, SHOT_WORKBENCH_URL: url } });
  await until(`document.querySelectorAll('.shot-card').length===8 && !document.body.hasAttribute('aria-busy')`);
  assert.equal(await evaluate(`document.querySelector('.shot-card [data-field=notes]').value`), 'Keep my edit while CLI imports');
  assert.equal(app.store.detail(dbProject.id).shots.length, 8);
  assert.deepEqual(browserErrors, []);
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'mobile page should not overflow');
  console.log('PASS: browser segmentation, synthetic CLI push/result/adopt, actual external CLI import/live refresh preserving edits, reload/mobile; no model requests or runtime exceptions.');
  console.log(`Screenshot: ${join(root, 'test-results', 'browser-smoke.png')}`);
} finally {
  if (socket) socket.close();
  if (chrome && chrome.exitCode === null) {
    const ended = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill(); await Promise.race([ended, delay(3000)]);
  }
  await app.close();
  const absolute = resolve(scratch);
  if (!absolute.startsWith(resolve(tmpdir()) + sep + 'shot-browser-')) throw new Error('Refusing cleanup outside test scratch directory');
  await rm(absolute, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(error => console.error(`Test scratch cleanup incomplete: ${error.message}`));
}
