// Link downloads: paste a YouTube / TikTok / 抖音 / B 站 URL, the local server runs yt-dlp and adds the result
// as a new shot (MP4) or a library asset (MP3). The list polls while the dialog is open or anything is running.
import { refreshLibrary } from './library.js';
const $ = selector => document.querySelector(selector);
const labels = { running: '下载中', done: '完成', failed: '失败', cancelled: '已取消' };
const kinds = { video: '视频 → 新片段', audio: '音频 → 素材库' };
let ctx, items = [], seen = new Map(), timer = null;
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }
function render() {
  const list = $('#downloads-list'); list.replaceChildren();
  if (!items.length) { list.append(el('small', '', '还没有下载。')); return; }
  for (const item of items) {
    const row = el('div', `download-item ${item.status}`), head = el('div', 'download-head');
    head.append(el('strong', '', item.title || item.url), el('small', '', `${kinds[item.kind]} · ${labels[item.status]}${item.status === 'running' ? ` ${Math.round(item.progress)}%` : ''}`));
    if (item.status === 'running') {
      const stop = el('button', 'text-button', '取消');
      stop.addEventListener('click', () => ctx.action(async () => { await ctx.api(`/api/downloads/${item.id}/cancel`, { method: 'POST', body: '{}' }); await refresh(); }));
      head.append(stop);
    }
    row.append(head);
    if (item.status === 'running') { const bar = el('div', 'download-bar'), fill = el('span'); fill.style.width = `${item.progress}%`; bar.append(fill); row.append(bar); }
    row.append(el('small', '', item.error ? `${item.error} · ${item.url}` : item.url));
    list.append(row);
  }
}
async function refresh() {
  const project = ctx.getProject(); if (!project) return;
  const data = await ctx.api(`/api/downloads?project=${project.id}`);
  if (ctx.getProject()?.id !== project.id) return;
  items = data.items;
  const tool = $('#downloads-tool');
  tool.hidden = data.available;
  tool.textContent = '本机找不到 yt-dlp。请在这台电脑安装 yt-dlp 和 ffmpeg（例如 winget install yt-dlp.yt-dlp Gyan.FFmpeg），重启 AiCut 后再试；也可以用 SHOT_YTDLP_BIN 指定 yt-dlp.exe 的完整路径。';
  let reloadShots = false, reloadLibrary = false;
  for (const item of items) {
    const before = seen.get(item.id);
    if (before === 'running' && item.status !== 'running') {
      if (item.status === 'done') { ctx.toast(`下载完成：${item.title}${item.kind === 'audio' ? '，已存入素材库' : '，已加为新片段'}`); if (item.kind === 'audio') reloadLibrary = true; else reloadShots = true; }
      else if (item.status === 'failed') ctx.toast(`下载失败：${item.error}`, true);
    }
    seen.set(item.id, item.status);
  }
  render();
  if (reloadShots) await ctx.reload(project.id);
  if (reloadLibrary) await refreshLibrary().catch(() => {});
  schedule();
}
function schedule() {
  clearTimeout(timer); timer = null;
  if ($('#downloads-dialog').open || items.some(item => item.status === 'running')) timer = setTimeout(() => refresh().catch(() => schedule()), 1000);
}
export function setupDownloads(context) {
  ctx = context;
  $('#downloads').addEventListener('click', () => { $('#downloads-dialog').showModal(); $('#downloads-url').focus(); refresh().catch(error => ctx.toast(error.message, true)); });
  $('#downloads-form').addEventListener('submit', event => {
    event.preventDefault();
    ctx.action(async () => {
      const item = await ctx.api(`/api/projects/${ctx.getProject().id}/downloads`, { method: 'POST', body: JSON.stringify({ url: $('#downloads-url').value.trim(), kind: $('#downloads-kind').value }) });
      seen.set(item.id, 'running'); $('#downloads-url').value = '';
      ctx.toast('已开始下载，可以关掉这个窗口继续工作');
      await refresh();
    });
  });
}
