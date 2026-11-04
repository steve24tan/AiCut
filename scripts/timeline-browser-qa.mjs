// Optional local QA for the audio timeline: installed Chrome over CDP, synthetic media only, no model requests.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { createHerdr, discoverHerdr } from '../src/herdr.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'shot-timeline-browser-'));
// A stand-in herdr CLI lists one idle Claude agent and records the prompts typed into it.
const promptLog = join(scratch, 'herdr-prompts.log');
Object.assign(process.env, { FAKE_HERDR_AGENTS: JSON.stringify([{ name: 'lead', pane_id: 'w1:p1', agent: 'claude', agent_status: 'idle' }]), FAKE_HERDR_LOG: promptLog });
const app = await createApp({ dataDir: join(scratch, 'data'), herdr: createHerdr(discoverHerdr({ SHOT_HERDR_BIN: fileURLToPath(new URL('../tests/fixtures/fake-herdr.mjs', import.meta.url)) })) });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Mono 16-bit WAV: a tone with a short "beat" every half second.
function wav(seconds, freq) {
  const rate = 22050, n = Math.round(seconds * rate), buffer = Buffer.alloc(44 + n * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + n * 2, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const t = i / rate, beat = (t % 0.5) < 0.06 ? 1 : 0.25; buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * t) * beat * 0.8 * 32767), 44 + i * 2); }
  return buffer;
}
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
  async function drag(from, to) {
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 6; step++) await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * step / 6, y: from.y + (to.y - from.y) * step / 6, button: 'left', buttons: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', buttons: 0, clickCount: 1 });
  }
  const clipState = () => app.audio.detail(app.store.listProjects()[0].id).tracks.flatMap(t => t.clips.map(c => ({ ...c, track: t.id })))[0];
  await mkdir(join(root, 'test-results'), { recursive: true });
  await command('Runtime.enable'); await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1512, height: 1100, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url });
  await until(`document.querySelector('#save-state')?.textContent.includes('所有修改已保存')`);
  assert.equal(await evaluate(`document.querySelector('#editor').hidden`), true, 'no project, no editor');
  await evaluate(`document.querySelector('#new-project').click(); document.querySelector('#name-input').value='时间线 QA'; document.querySelector('#name-form').requestSubmit();`);
  await until(`document.querySelector('#project-title').textContent==='时间线 QA' && ${idle}`);
  // Two shots: a still (2 s on the timeline) and a short generated WebM.
  await evaluate(`(async () => {
    const still=document.createElement('canvas'); still.width=360; still.height=640; const g=still.getContext('2d'); g.fillStyle='#2b3a4a'; g.fillRect(0,0,360,640); g.fillStyle='#fff'; g.font='40px sans-serif'; g.fillText('SHOT 1',90,320);
    const png=await new Promise(r=>still.toBlob(r,'image/png'));
    const canvas=document.createElement('canvas'); canvas.width=180; canvas.height=320; const c=canvas.getContext('2d');
    const stream=canvas.captureStream(20), chunks=[]; const recorder=new MediaRecorder(stream,{mimeType:'video/webm'});
    const done=new Promise(r=>{recorder.onstop=r}); recorder.ondataavailable=e=>chunks.push(e.data); recorder.start();
    for(let i=0;i<50;i++){c.fillStyle='#26351e';c.fillRect(0,0,180,320);c.fillStyle='#c6ed9a';c.fillRect(20,20+i*5,40,40);await new Promise(r=>setTimeout(r,50));}
    recorder.stop(); await done; stream.getTracks().forEach(t=>t.stop());
    const t=new DataTransfer(); t.items.add(new File([png],'shot-1.png',{type:'image/png'})); t.items.add(new File(chunks,'shot-2.webm',{type:'video/webm'}));
    const input=document.querySelector('#file-input'); input.files=t.files; input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await until(`document.querySelectorAll('.shot-card').length===2 && document.querySelectorAll('.shot-block').length===2 && !document.querySelector('.shot-block.estimated') && ${idle}`);
  const blocks = await evaluate(`[...document.querySelectorAll('.shot-block')].map(b=>({left:b.offsetLeft,width:b.offsetWidth}))`);
  assert.ok(blocks[1].left > blocks[0].left && blocks[1].width > 20, 'video track lays shots out in order: ' + JSON.stringify(blocks));
  assert.match(await evaluate(`document.querySelector('.empty-lane').textContent`), /BGM/);
  await evaluate(`document.querySelector('[data-add-track="bgm"]').click()`);
  await until(`document.querySelectorAll('.audio-lane').length===1 && ${idle}`);
  // Upload a 6 s beat WAV through the editor's file input.
  const beat = wav(6, 220).toString('base64');
  await evaluate(`(() => { const bytes=Uint8Array.from(atob(${JSON.stringify(beat)}),c=>c.charCodeAt(0)); document.querySelector('#editor-import').click(); const t=new DataTransfer(); t.items.add(new File([bytes],'beat-bgm.wav',{type:'audio/wav'})); const input=document.querySelector('#editor-files'); input.files=t.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await until(`document.querySelector('.audio-clip:not(.loading)') && ${idle}`);
  await until(`(() => { const c=document.querySelector('.audio-clip canvas'); if(!c||c.width<10) return false; const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; for(let i=3;i<d.length;i+=4) if(d[i]) return true; return false; })()`);
  for (let n = 0; n < 30 && !clipState()?.versions[0].duration_ms; n++) await delay(100);
  assert.ok(Math.abs(clipState().versions[0].duration_ms - 6000) < 30, 'browser reports decoded duration');
  await shoot('timeline-editor.png');
  // Move by dragging the clip body ~1 s to the right.
  const pps = await evaluate(`import('/timeline.js').then(m=>m.testHooks().pps)`);
  let box = await rect('.audio-clip');
  await drag({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, { x: box.x + box.w / 2 + pps, y: box.y + box.h / 2 });
  await until(`${idle}`); for (let n = 0; n < 20 && clipState().offset_ms === 0; n++) await delay(100);
  assert.ok(Math.abs(clipState().offset_ms - 1000) <= 1000 / pps * 2 + 5 || clipState().offset_ms === 2000, `moved to ~1 s or snapped: ${clipState().offset_ms}`);
  // Trim the right edge ~1 s shorter.
  await until(`${idle} && document.querySelector('.audio-clip')`);
  await evaluate(`document.querySelector('#editor-fit').click()`);
  await until(`(() => { const c=document.querySelector('.audio-clip').getBoundingClientRect(), s=document.querySelector('#editor-scroll').getBoundingClientRect(); return c.right < s.right - 4; })()`);
  const fitted = await evaluate(`import('/timeline.js').then(m=>m.testHooks().pps)`);
  box = await rect('.audio-clip');
  await drag({ x: box.x + box.w - 2, y: box.y + box.h / 2 }, { x: box.x + box.w - 2 - fitted, y: box.y + box.h / 2 });
  for (let n = 0; n < 20 && clipState().out_ms == null; n++) await delay(100);
  assert.ok(clipState().out_ms != null && Math.abs(clipState().out_ms - 5000) < 200, `trimmed out point ~5 s: ${clipState().out_ms}`);
  // Range select: switch tool, drag across the middle of the clip, write a note.
  await until(`${idle}`);
  await evaluate(`document.querySelector('[data-editor-mode="select"]').click()`);
  await until(`document.querySelector('#editor').classList.contains('select-mode')`); box = await rect('.audio-clip');
  await drag({ x: box.x + box.w * 0.3, y: box.y + box.h / 2 }, { x: box.x + box.w * 0.6, y: box.y + box.h / 2 });
  await until(`document.querySelectorAll('.audio-region-row').length===1 && document.querySelectorAll('.audio-clip .audio-region').length===1 && ${idle}`);
  const region = clipState().regions[0];
  assert.ok(region.end_ms - region.start_ms > 1000 && region.start_ms > 0, 'region stored in source time: ' + JSON.stringify(region));
  await evaluate(`(() => { const t=document.querySelector('.audio-region-row textarea'); t.value='这段鼓点降低，慢慢递进'; t.dispatchEvent(new Event('input',{bubbles:true})); const n=document.querySelector('.inspector-notes textarea'); n.value='整体含蓄一点'; n.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  for (let n = 0; n < 40 && (clipState().regions[0]?.note !== '这段鼓点降低，慢慢递进' || clipState().notes !== '整体含蓄一点'); n++) await delay(100);
  assert.equal(clipState().regions[0].note, '这段鼓点降低，慢慢递进'); assert.equal(clipState().notes, '整体含蓄一点');
  // An agent imports v2 through the API; the idle page picks it up and offers A/B.
  await evaluate(`document.activeElement.blur()`);
  const current = clipState();
  const v2 = await fetch(`${url}/api/audio/clips/${current.id}/versions?filename=beat-bgm-soft.wav&note=${encodeURIComponent('鼓 -9dB')}`, { method: 'POST', headers: { 'X-Workbench': '1', 'X-Clip-Revision': String(current.revision) }, body: wav(6, 330) });
  assert.equal(v2.status, 201);
  await until(`document.querySelectorAll('.inspector-versions select')[0]?.options.length===2 && ${idle}`, 80);
  assert.match(await evaluate(`document.querySelector('.audio-clip .clip-label').textContent`), /v2\/2/);
  await evaluate(`document.querySelector('.audio-region-row .region-tag').click(); [...document.querySelectorAll('.inspector-versions button')][1].click()`);
  await until(`document.querySelector('#editor-play').textContent==='❚❚'`);
  await evaluate(`document.querySelector('#editor-play').click()`);
  await until(`document.querySelector('#editor-play').textContent==='▶'`);
  // Timeline playback advances the playhead and the monitor.
  await evaluate(`document.querySelector('#editor-play').click()`);
  await delay(700);
  const head = await evaluate(`import('/timeline.js').then(m=>m.testHooks().playhead)`);
  assert.ok(head > 200, 'playhead advanced: ' + head);
  await evaluate(`document.querySelector('#editor-play').click()`);
  // Copy request lists the audio region.
  await evaluate(`Object.defineProperty(navigator,'clipboard',{value:{writeText:async t=>{window.__copied=t;}}}); document.querySelector('.inspector-actions .primary').click()`);
  await until(`typeof window.__copied==='string'`);
  const copied = await evaluate('window.__copied');
  assert.match(copied, /【音频框选 · 只改这些时间段/); assert.match(copied, /这段鼓点降低/); assert.match(copied, /整体含蓄一点/); assert.match(copied, /采用版本：v2/);
  // AI tasks: push this clip to the herdr agent, then build a two-clip mix with Shift+click.
  await until(`${idle} && document.querySelector('.task-box .target-select')?.options.length===2`);
  assert.match(await evaluate(`document.querySelector('.task-box .target-select').selectedOptions[0].textContent`), /herdr · lead（claude · 空闲）/);
  await evaluate(`(() => { const t=document.querySelector('.task-box textarea'); t.value='本地分轨处理'; document.querySelector('.task-box .primary').click(); })()`);
  await until(`document.querySelector('.task-box .task-state').textContent.includes('等 agent 领取') && ${idle}`, 80);
  const typed = (await readFile(promptLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(typed[0].target, 'lead'); assert.match(typed[0].text, /tasks read [0-9a-f-]{36}/);
  const second = await fetch(`${url}/api/audio/tracks/${clipState().track}/clips?filename=other-bgm.wav&offset_ms=6000`, { method: 'POST', headers: { 'X-Workbench': '1' }, body: wav(4, 440) });
  assert.equal(second.status, 201);
  await until(`document.querySelectorAll('.audio-clip').length===2 && ${idle}`, 80);
  await evaluate(`document.querySelector('#editor-fit').click()`); await until(`${idle}`);
  for (const index of [0, 1]) {
    const target = await evaluate(`(() => { const r=document.querySelectorAll('.audio-clip')[${index}].getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...target, button: 'left', buttons: 1, clickCount: 1, modifiers: 8 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...target, button: 'left', buttons: 0, clickCount: 1, modifiers: 8 });
    await until(`${idle}`);
  }
  await until(`document.querySelectorAll('.audio-clip.multi').length===2 && document.querySelector('.task-box.mix')`);
  await evaluate(`(() => { const box=document.querySelector('.task-box.mix'); box.querySelector('textarea').value='对齐拍子后交叉淡化'; const s=box.querySelector('.target-select'); s.value='manual'; box.querySelector('.primary').click(); })()`);
  await until(`typeof window.__copied==='string' && window.__copied.includes('[AiCut]') && ${idle}`);
  const mixTask = app.tasks.list(app.store.listProjects()[0].id)[0];
  assert.deepEqual([mixTask.kind, mixTask.target, mixTask.clip_ids.length], ['mix', 'manual', 2]);
  await shoot('timeline-mix.png');
  // Generate BGM dialog (manual), then the task list shows all three.
  await evaluate(`document.querySelector('#editor-music').click()`);
  await until(`document.querySelector('#music-dialog').open && document.querySelector('#music-target').options.length===2`);
  await evaluate(`document.querySelector('#music-prompt').value='轻快、前 8 秒含蓄，之后鼓点递进'; document.querySelector('#music-target').value='manual'; document.querySelector('#music-form').requestSubmit()`);
  await until(`!document.querySelector('#music-dialog').open && ${idle}`);
  await evaluate(`document.querySelector('#editor-tasks').click()`);
  await until(`document.querySelector('#tasks-dialog').open && document.querySelectorAll('.task-item').length===3`);
  await shoot('timeline-tasks.png');
  await evaluate(`document.querySelector('#tasks-dialog [data-close]').click()`);
  // Drop back to one selected clip for the next steps; remove the extra clip.
  await evaluate(`window.confirm=()=>true`);
  const extra = app.audio.detail(app.store.listProjects()[0].id).tracks[0].clips.find(c => c.offset_ms >= 6000);
  await fetch(`${url}/api/audio/clips/${extra.id}`, { method: 'DELETE', headers: { 'X-Workbench': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: extra.revision }) });
  await until(`document.querySelectorAll('.audio-clip').length===1 && ${idle}`, 80);
  await evaluate(`(() => { const r=document.querySelector('.audio-clip').getBoundingClientRect(); return r; })()`);
  box = await rect('.audio-clip');
  await drag({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, { x: box.x + box.w / 2, y: box.y + box.h / 2 });
  await until(`${idle} && !document.querySelector('.task-box.mix')`);
  // Move to a new voice track by dragging down.
  await until(`${idle}`);
  await evaluate(`document.querySelector('[data-editor-mode="move"]').click(); document.querySelector('[data-add-track="voice"]').click()`);
  await until(`document.querySelectorAll('.audio-lane').length===2 && ${idle}`);
  box = await rect('.audio-clip'); const laneTwo = await evaluate(`(() => { const r=document.querySelectorAll('.audio-lane')[1].getBoundingClientRect(); return r.top+r.height/2; })()`);
  await drag({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, { x: box.x + box.w / 2, y: laneTwo });
  const voiceTrack = app.audio.detail(app.store.listProjects()[0].id).tracks[1].id;
  for (let n = 0; n < 20 && clipState().track !== voiceTrack; n++) await delay(100);
  assert.equal(clipState().track, voiceTrack, 'clip moved to the voice track');
  await until(`${idle} && document.querySelectorAll('.audio-lane')[1].querySelector('.audio-clip')`);
  await shoot('timeline-inspector.png');
  // Remove the clip; media stays on disk.
  await evaluate(`window.confirm=()=>true; [...document.querySelectorAll('.inspector-actions button')][1].click()`);
  await until(`!document.querySelector('.audio-clip') && ${idle}`);
  assert.equal(clipState(), undefined);
  // Characters and dialogue: add a voice, write a line on shot 1, check save + copy text.
  await evaluate(`document.querySelector('#voices').click()`);
  await until(`document.querySelector('#voices-dialog').open && ${idle}`);
  await evaluate(`document.querySelector('#voice-name').value='Lorraine'; document.querySelector('#voice-add').requestSubmit()`);
  await until(`document.querySelectorAll('.voice-row').length===1`);
  await evaluate(`(() => { const row=document.querySelector('.voice-row'); const id=row.querySelectorAll('input')[1]; id.value='EXAVITQu4vr4xnSDxMaL'; id.dispatchEvent(new Event('change',{bubbles:true})); const n=row.querySelector('textarea'); n.value='年轻女声、台湾腔、活泼'; n.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  const projectId = app.store.listProjects()[0].id;
  for (let n = 0; n < 30 && app.store.characters(projectId)[0]?.voice_notes !== '年轻女声、台湾腔、活泼'; n++) await delay(100);
  assert.equal(app.store.characters(projectId)[0].voice_id, 'EXAVITQu4vr4xnSDxMaL');
  assert.equal(app.store.characters(projectId)[0].voice_notes, '年轻女声、台湾腔、活泼', 'two quick edits both saved');
  await shoot('voices-dialog.png');
  await evaluate(`document.querySelector('#voices-dialog [data-close]').click()`);
  await until(`!document.querySelector('#voices-dialog').open && ${idle} && document.querySelector('.shot-card .add-line')`);
  await evaluate(`document.querySelector('.shot-card .add-line').click()`);
  await until(`document.querySelector('.shot-card .line-row')`);
  await evaluate(`(() => { const row=document.querySelector('.shot-card .line-row'); const s=row.querySelector('select'); s.value=s.options[1].value; s.dispatchEvent(new Event('change',{bubbles:true})); const t=row.querySelector('.line-text'); t.value='欢迎来到 Grand Archive！'; t.dispatchEvent(new Event('input',{bubbles:true})); const d=row.querySelector('.line-delivery'); d.value='兴奋'; d.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await until(`document.querySelector('#save-state').textContent.includes('所有修改已保存')`);
  for (let n = 0; n < 30 && app.store.detail(projectId).shots[0].lines[0]?.text !== '欢迎来到 Grand Archive！'; n++) await delay(100);
  assert.deepEqual(app.store.detail(projectId).shots[0].lines.map(l => [l.character, l.text, l.delivery]), [['Lorraine', '欢迎来到 Grand Archive！', '兴奋']]);
  await evaluate(`(() => { const row=document.querySelector('.shot-card .voice-task'); row.querySelector('.target-select').value='manual'; row.querySelector('button').click(); })()`);
  await until(`document.querySelector('.shot-card .voice-task .task-state').textContent.includes('配音') && ${idle}`, 80);
  const voiceTask = app.tasks.get(app.tasks.list(projectId)[0].id);
  assert.deepEqual([voiceTask.kind, voiceTask.snapshot.shot.timeline_offset_ms, voiceTask.snapshot.lines[0].voice_id, voiceTask.snapshot.output_track.kind], ['voice', 0, 'EXAVITQu4vr4xnSDxMaL', 'voice']);
  await evaluate(`window.__copied=null; document.querySelector('.shot-card .copy-request').click()`);
  await until(`typeof window.__copied==='string'`);
  const shotCopy = await evaluate('window.__copied');
  assert.match(shotCopy, /【台词 \/ 配音】/, shotCopy);
  assert.match(shotCopy, /【台词 \/ 配音】\n1\. Lorraine（ElevenLabs · voice_id EXAVITQu4vr4xnSDxMaL · 年轻女声、台湾腔、活泼）：「欢迎来到 Grand Archive！」 语气：兴奋/);
  await evaluate(`document.querySelector('.shot-card').scrollIntoView({block:'start'})`);
  await shoot('voices-card.png');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await delay(300);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true, 'mobile page should not overflow');
  await shoot('timeline-mobile.png');
  assert.deepEqual(browserErrors, []);
  console.log('PASS: video track layout, audio track create, WAV upload + waveform + duration report, drag move, edge trim, time-range select + notes autosave, agent version pickup, A/B audition, timeline playback, copy text, herdr push (stand-in CLI), Shift multi-select mix, BGM generation dialog, task list, per-shot dubbing task, characters + dialogue, cross-track move, remove, mobile. No model requests.');
} finally {
  if (socket) socket.close();
  if (chrome && chrome.exitCode === null) { const ended = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill(); await Promise.race([ended, delay(3000)]); }
  await app.close();
  const absolute = resolve(scratch);
  if (!absolute.startsWith(resolve(tmpdir()) + sep + 'shot-timeline-browser-')) throw new Error('Refusing cleanup outside test scratch directory');
  await rm(absolute, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(error => console.error(`Test scratch cleanup incomplete: ${error.message}`));
}
