// Per-shot dialogue lines and the project's character → voice map.
import { voiceTaskControls } from './tasks.js';
const $ = selector => document.querySelector(selector);
const providers = { elevenlabs: 'ElevenLabs', other: '其他' };
let ctx, changed = false;
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }
const characterOf = id => ctx.getProject()?.characters?.find(c => c.id === id);
export function linesText(shot) {
  if (!shot.lines?.length) return '';
  return '\n\n【台词 / 配音】\n' + shot.lines.map((line, index) => {
    const who = characterOf(line.character_id);
    const voice = who ? `（${providers[who.provider]}${who.voice_id ? ' · voice_id ' + who.voice_id : ''}${who.voice_notes ? ' · ' + who.voice_notes : ''}）` : '（未指定角色）';
    return `${index + 1}. ${who?.name || '旁白/未指定'}${voice}：「${line.text}」${line.delivery ? ` 语气：${line.delivery}` : ''}`;
  }).join('\n');
}
export function bindLinesCard(card, shot) {
  const box = el('section', 'shot-lines');
  const head = el('div', 'lines-head'); head.append(el('strong', '', '台词'), el('span', '', '角色 · 台词 · 语气'));
  const list = el('div', 'lines-list');
  const add = el('button', 'text-button add-line', '＋ 台词');
  const collect = () => [...list.children].map(row => ({ character_id: row.querySelector('select').value || null, text: row.querySelector('.line-text').value, delivery: row.querySelector('.line-delivery').value }));
  const save = () => ctx.markEdit(shot, 'lines', collect());
  function row(line = { character_id: null, text: '', delivery: '' }) {
    const item = el('div', 'line-row');
    const who = el('select'); who.setAttribute('aria-label', '角色');
    who.add(new Option('旁白/未指定', ''));
    for (const c of ctx.getProject()?.characters || []) who.add(new Option(c.name, c.id));
    who.value = line.character_id || '';
    const text = el('input', 'line-text'); text.maxLength = 2000; text.value = line.text; text.placeholder = '台词'; text.setAttribute('aria-label', '台词');
    const delivery = el('input', 'line-delivery'); delivery.maxLength = 500; delivery.value = line.delivery; delivery.placeholder = '语气：惊讶、小声…'; delivery.setAttribute('aria-label', '语气');
    const remove = el('button', 'text-button', '×'); remove.title = '删除这句台词'; remove.setAttribute('aria-label', '删除这句台词');
    remove.addEventListener('click', () => { item.remove(); save(); });
    who.addEventListener('change', save); text.addEventListener('input', save); delivery.addEventListener('input', save);
    item.append(who, text, delivery, remove); return item;
  }
  for (const line of shot.lines || []) list.append(row(line));
  add.addEventListener('click', () => { if (list.children.length >= 50) { ctx.toast('每段最多 50 句台词', true); return; } const item = row(); list.append(item); item.querySelector('.line-text').focus(); save(); });
  box.append(head, list, add, voiceTaskControls(shot));
  card.querySelector('.card-body').after(box);
}
function renderCharacters(list) {
  const container = $('#voices-list'); container.replaceChildren();
  if (!list.length) container.append(el('p', 'voices-empty', '还没有角色。先加角色，再在每段的「台词」里选择谁说话。'));
  for (const c of list) {
    const item = el('div', 'voice-row');
    const name = el('input'); name.value = c.name; name.maxLength = 100; name.setAttribute('aria-label', '角色名称');
    const provider = el('select'); for (const [id, label] of Object.entries(providers)) provider.add(new Option(label, id)); provider.value = c.provider; provider.setAttribute('aria-label', '声音来源');
    const voice = el('input'); voice.value = c.voice_id; voice.maxLength = 200; voice.placeholder = 'voice_id（ElevenLabs 声音 ID，可留空）'; voice.setAttribute('aria-label', '声音 ID');
    const notes = el('textarea'); notes.rows = 2; notes.value = c.voice_notes; notes.maxLength = 2000; notes.placeholder = '声音描述：年轻女声、台湾腔、活泼，语速偏快'; notes.setAttribute('aria-label', '声音描述');
    // Read the revision when the queued request runs, so quick successive edits do not collide.
    const latest = () => characterOf(c.id)?.revision ?? c.revision;
    const remove = el('button', 'text-button', '删除'); remove.addEventListener('click', () => request(`/api/characters/${c.id}`, 'DELETE', () => ({ revision: latest() })));
    const patch = () => request(`/api/characters/${c.id}`, 'PATCH', () => ({ revision: latest(), name: name.value, provider: provider.value, voice_id: voice.value, voice_notes: notes.value }));
    for (const input of [name, provider, voice, notes]) input.addEventListener('change', patch);
    const top = el('div', 'voice-row-top'); top.append(name, provider, voice, remove);
    item.append(top, notes); container.append(item);
  }
}
let queue = Promise.resolve();
function request(path, method, payload) {
  queue = queue.then(async () => {
    try {
      const list = await ctx.api(path, { method, body: JSON.stringify(typeof payload === 'function' ? payload() : payload) });
      changed = true; ctx.getProject().characters = list;
      // Keep the inputs the user is typing in; only redraw when the set of characters changed.
      if (method !== 'PATCH') renderCharacters(list);
    } catch (error) { ctx.toast(error.message, true); }
  });
  return queue;
}
export function setupVoices(context) {
  ctx = context;
  $('#voices').addEventListener('click', () => ctx.action(async () => {
    const project = ctx.getProject(); if (!project) return;
    project.characters = await ctx.api(`/api/projects/${project.id}/characters`);
    changed = false; renderCharacters(project.characters); $('#voices-dialog').showModal();
  }));
  $('#voice-add').addEventListener('submit', event => {
    event.preventDefault(); const name = $('#voice-name').value.trim(); if (!name) return;
    request(`/api/projects/${ctx.getProject().id}/characters`, 'POST', { name }).then(() => { $('#voice-name').value = ''; });
  });
  $('#voices-dialog').addEventListener('close', () => { if (changed) ctx.action(() => ctx.reload(ctx.getProject().id)); });
}
