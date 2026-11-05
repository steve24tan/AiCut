import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, delimiter, extname, isAbsolute, resolve, sep } from 'node:path';
import { AppError } from './store.mjs';
import { childEnvironment } from './runner.mjs';

// Link downloads (YouTube, TikTok, 抖音, B 站 …) through the user's own yt-dlp. AiCut never parses sites itself:
// yt-dlp resolves the page, picks streams and (with ffmpeg) merges MP4 or extracts MP3; the finished file is
// copied into media like an upload. Video becomes a new shot, audio a library asset; the source URL is kept.
export const downloadKinds = { video: '视频 MP4 → 新片段', audio: '音频 MP3 → 素材库' };
const fileTypes = {
  video: { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' },
  audio: { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac' }
};
const MAX_RUNNING = 3, KEEP_FINISHED = 30, TIMEOUT = 30 * 60 * 1000;
const now = () => new Date().toISOString();

export function discoverYtdlp(env = process.env) {
  const override = env.SHOT_YTDLP_BIN;
  if (override) {
    if (!isAbsolute(override) || !existsSync(override) || ['.cmd', '.bat', '.ps1'].includes(extname(override).toLowerCase())) return null;
    return /\.[mc]?js$/i.test(override) ? { command: process.execPath, prefix: [override] } : { command: override, prefix: [] };
  }
  for (const folder of (env.PATH || env.Path || '').split(delimiter).filter(Boolean)) {
    const binary = join(folder, 'yt-dlp' + (process.platform === 'win32' ? '.exe' : ''));
    if (existsSync(binary)) return { command: binary, prefix: [] };
  }
  return null;
}
// H.264 + AAC up to 1080p plays in browsers and imports into 剪映; MP3 needs ffmpeg for extraction.
export function ytdlpArgs(kind, url, folder, env = process.env) {
  const args = [
    '--no-playlist', '--no-simulate', '--newline', '--no-colors', '--no-mtime', '--restrict-filenames', '--max-filesize', '1024M',
    '--progress', '--progress-template', 'download:AICUT_PROGRESS %(progress._percent_str)s',
    '--print', 'after_move:AICUT_DONE %(.{filepath,title,uploader,webpage_url,duration,extractor_key})j',
    '-P', folder, '-o', '%(id)s.%(ext)s'
  ];
  if (kind === 'audio') args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
  else args.push('-S', 'vcodec:h264,res:1080,acodec:m4a', '-f', 'bv*+ba/b', '--merge-output-format', 'mp4');
  if (env.SHOT_YTDLP_COOKIES_BROWSER) args.push('--cookies-from-browser', env.SHOT_YTDLP_COOKIES_BROWSER);
  if (env.SHOT_FFMPEG_BIN) args.push('--ffmpeg-location', env.SHOT_FFMPEG_BIN);
  return [...args, '--', url];
}
function checkUrl(value) {
  if (typeof value !== 'string') throw new AppError(400, '请贴上视频链接');
  const text = value.trim(); let url;
  try { url = new URL(text); } catch { throw new AppError(400, '链接格式不正确'); }
  if (!['http:', 'https:'].includes(url.protocol) || text.length > 2000) throw new AppError(400, '只支持 http(s) 链接');
  return url.href;
}
const safeName = text => (text || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim().slice(0, 180);

export function openDownloads(store, library, mediaDir, dataDir, { ytdlp } = {}) {
  const jobs = new Map(), children = new Map();
  const view = ({ id, project_id, kind, url, status, progress, title, error, result, created_at, finished_at }) => ({ id, project_id, kind, url, status, progress, title, error, result, created_at, finished_at });
  function list(projectId) {
    const tool = ytdlp ?? discoverYtdlp();
    return { available: Boolean(tool), cookies_browser: process.env.SHOT_YTDLP_COOKIES_BROWSER || '', items: [...jobs.values()].filter(j => !projectId || j.project_id === projectId).reverse().map(view) };
  }
  function get(id) { const job = jobs.get(id); if (!job) throw new AppError(404, '下载任务不存在'); return view(job); }
  function start(projectId, payload) {
    store.project(projectId);
    const url = checkUrl(payload?.url), kind = payload?.kind ?? 'video';
    if (!downloadKinds[kind]) throw new AppError(400, '下载类型应为 video 或 audio');
    const tool = ytdlp ?? discoverYtdlp();
    if (!tool) throw new AppError(503, '本机找不到 yt-dlp：请安装 yt-dlp 和 ffmpeg 并加入 PATH，或设置 SHOT_YTDLP_BIN');
    if ([...jobs.values()].filter(j => j.status === 'running').length >= MAX_RUNNING) throw new AppError(429, `最多同时下载 ${MAX_RUNNING} 个，请稍后`);
    const job = { id: randomUUID(), project_id: projectId, kind, url, status: 'running', progress: 0, title: '', error: '', result: null, created_at: now(), finished_at: null };
    jobs.set(job.id, job);
    const finished = [...jobs.values()].filter(j => j.status !== 'running');
    for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.delete(old.id);
    run(job, tool).then(result => { job.result = result; job.status = 'done'; job.progress = 100; },
      error => { job.status = job.status === 'cancelled' ? 'cancelled' : 'failed'; job.error = job.status === 'cancelled' ? '已取消' : error.message; })
      .finally(() => { job.finished_at = now(); });
    return view(job);
  }
  function cancel(id) {
    const job = jobs.get(id); if (!job) throw new AppError(404, '下载任务不存在');
    if (job.status === 'running') { job.status = 'cancelled'; children.get(id)?.kill(); }
    return view(job);
  }
  async function run(job, tool) {
    const folder = join(dataDir, 'downloads', job.id);
    await mkdir(folder, { recursive: true });
    try {
      const info = await fetchFile(job, tool, folder);
      return await ingest(job, info, folder);
    } finally { await rm(folder, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}); }
  }
  function fetchFile(job, tool, folder) {
    return new Promise((done, fail) => {
      const child = spawn(tool.command, [...tool.prefix, ...ytdlpArgs(job.kind, job.url, folder)], {
        windowsHide: true, shell: false, env: { ...childEnvironment(), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe']
      });
      children.set(job.id, child);
      let info = null, errors = '', pending = '';
      const timer = setTimeout(() => { job.error = '下载超过 30 分钟'; child.kill(); }, TIMEOUT);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        const lines = (pending + chunk).split(/\r?\n/); pending = lines.pop();
        for (const line of lines) {
          const progress = /^AICUT_PROGRESS\s+([\d.]+)%/.exec(line.trim());
          if (progress) job.progress = Math.min(99, Number(progress[1]));
          else if (line.startsWith('AICUT_DONE ')) { try { info = JSON.parse(line.slice(11)); job.title = info.title || job.title; } catch { /* reported below */ } }
        }
      });
      child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
      child.on('error', error => { clearTimeout(timer); children.delete(job.id); fail(new Error(`无法启动 yt-dlp：${error.message}`)); });
      child.on('close', code => {
        clearTimeout(timer); children.delete(job.id);
        if (job.status === 'cancelled') return fail(new Error('已取消'));
        if (code !== 0 || !info) {
          const reason = errors.split(/\r?\n/).filter(line => /^ERROR:/.test(line)).pop()?.replace(/^ERROR:\s*/, '') || job.error || `yt-dlp 退出码 ${code}`;
          return fail(new Error(reason.slice(0, 500)));
        }
        done(info);
      });
    });
  }
  async function ingest(job, info, folder) {
    const path = resolve(String(info.filepath || '')), ext = extname(path).toLowerCase(), mime = fileTypes[job.kind][ext];
    if (!path.startsWith(resolve(folder) + sep)) throw new Error('yt-dlp 回报的文件不在下载目录里');
    if (!mime) throw new Error(`下载结果是 ${ext || '未知格式'}，${job.kind === 'audio' ? '转 MP3 需要 ffmpeg' : '合并 MP4 需要 ffmpeg'}`);
    const size = (await stat(path)).size;
    if (!size || size > 1024 ** 3) throw new Error('下载结果为空或超过 1 GB');
    const hash = createHash('sha256'); await pipeline(createReadStream(path), hash);
    const id = randomUUID(), stored = id + ext, title = safeName(info.title) || 'download';
    await rename(path, join(mediaDir, stored));
    const media = { id, filename: title + ext, stored_name: stored, mime, bytes: size, sha256: hash.digest('hex') };
    const source = typeof info.webpage_url === 'string' && /^https?:\/\//i.test(info.webpage_url) ? info.webpage_url.slice(0, 2000) : job.url;
    const author = typeof info.uploader === 'string' ? info.uploader.slice(0, 500) : '';
    try {
      if (job.kind === 'audio') {
        const asset = library.add(media);
        library.update(asset.id, { revision: asset.revision, title: title.slice(0, 200), source_url: source, author });
        return { asset_id: asset.id, title };
      }
      const shot = store.addShot(job.project_id, title.slice(0, 200));
      const take = store.addTake(shot.id, shot.revision, media);
      store.updateShot(shot.id, { revision: take.shot.revision, notes: `来源：${source}${author ? `\n作者：${author}` : ''}` });
      return { shot_id: shot.id, take_id: take.id, title };
    } catch (error) { if (!store.media(id)) await rm(join(mediaDir, stored), { force: true }); throw error; }
  }
  function close() { for (const [id, child] of children) { const job = jobs.get(id); if (job) job.status = 'cancelled'; child.kill(); } }
  return { list, get, start, cancel, close };
}
