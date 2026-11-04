import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import { join, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, AppError } from './src/store.mjs';
import { openJobs } from './src/jobs.mjs';
import { createRunner } from './src/runner.mjs';
import { openLibrary, libraryManifest } from './src/library.mjs';
import { openRegions } from './src/regions.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const libraryTypes = { ...types, '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac' };
const MAX_UPLOAD = 1024 ** 3;
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError(415, '需要 JSON 请求');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new AppError(413, '文字内容过大');
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new AppError(400, 'JSON 格式不正确'); }
}
async function sendFile(req, res, path, mime, allowRange = false) {
  const info = await stat(path);
  let start = 0; let end = info.size - 1;
  const headers = { 'Content-Type': mime, 'Cache-Control': 'no-cache', 'Content-Length': info.size };
  if (allowRange) headers['Accept-Ranges'] = 'bytes';
  if (req.headers.range && allowRange) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return;
    }
    if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return;
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    headers['Content-Length'] = end - start + 1;
  }
  res.writeHead(headers['Content-Range'] ? 206 : 200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  await pipeline(createReadStream(path, { start, end }), res);
}

export async function createApp({ dataDir = process.env.SHOT_DATA_DIR || join(root, 'data'), executor } = {}) {
  dataDir = resolve(dataDir);
  const mediaDir = join(dataDir, 'media');
  await mkdir(mediaDir, { recursive: true });
  const store = openStore(dataDir);
  const jobs = openJobs(store);
  const library = openLibrary(store);
  const regions = openRegions(store);
  const runner = createRunner(jobs, dataDir, { executor });
  const server = http.createServer(async (req, res) => {
    for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);
    try {
      const port = server.address().port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(req.headers.host)) throw new AppError(403, '只允许本机访问');
      if (req.headers.origin && !hosts.some(host => req.headers.origin === `http://${host}`)) throw new AppError(403, '拒绝外部网页请求');
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-workbench'] !== '1') throw new AppError(403, '缺少本地请求标识');
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const path = url.pathname;
      if (path === '/api/extensions' && req.method === 'GET') return json(res,200,[libraryManifest]);
      if (path === '/api/library/assets' && req.method === 'GET') return json(res,200,library.list());
      if (path === '/api/cli' && req.method === 'GET') return json(res, 200, runner.providers());
      if (path === '/api/jobs' && req.method === 'GET') return json(res, 200, jobs.list(url.searchParams.get('project')));
      if (path === '/api/projects' && req.method === 'GET') return json(res, 200, store.listProjects());
      if (path === '/api/projects' && req.method === 'POST') return json(res, 201, store.createProject((await body(req)).title));
      let m;
      if ((m = /^\/api\/library\/assets\/([\w-]+)$/.exec(path)) && req.method === 'PATCH') return json(res,200,library.update(m[1],await body(req)));
      if ((m = /^\/api\/shots\/([\w-]+)\/references$/.exec(path)) && req.method === 'POST') return json(res,201,library.attach(m[1],await body(req)));
      if ((m = /^\/api\/shots\/([\w-]+)\/references\/([\w-]+)$/.exec(path)) && req.method === 'DELETE') return json(res,200,library.detach(m[1],m[2],(await body(req)).revision));
      if ((m = /^\/api\/shots\/([\w-]+)\/references\/([\w-]+)$/.exec(path)) && req.method === 'PATCH') return json(res,200,library.editReference(m[1],m[2],await body(req)));
      if ((m = /^\/api\/shots\/([\w-]+)\/regions$/.exec(path)) && req.method === 'PUT') return json(res, 200, regions.replace(m[1], await body(req)));
      if ((m = /^\/api\/shots\/([\w-]+)\/jobs$/.exec(path)) && req.method === 'POST') {
        const payload = await body(req);
        if (payload.provider !== 'manual' && !runner.providers().find(item => item.id === payload.provider)?.available) throw new AppError(400, '未找到本机 CLI，请安装并登录后重启服务，或选择外部 CLI');
        const job = jobs.enqueue(m[1], payload);
        if (job.provider !== 'manual') runner.submit(job.id);
        return json(res, 202, job);
      }
      if ((m = /^\/api\/jobs\/([\w-]+)$/.exec(path)) && req.method === 'GET') return json(res, 200, jobs.get(m[1]));
      if ((m = /^\/api\/jobs\/([\w-]+)\/(apply|cancel|claim|complete)$/.exec(path)) && req.method === 'POST') {
        const payload = await body(req), id = m[1], command = m[2];
        if (command === 'cancel') return json(res, 200, runner.cancel(id));
        if (command === 'apply') return json(res, 200, jobs.apply(id, payload.revision));
        if (jobs.get(id).provider !== 'manual') throw new AppError(409, '内置执行任务由本地服务管理，外部 CLI 请领取 manual 任务');
        return json(res, 200, command === 'claim' ? jobs.start(id) : jobs.complete(id, payload));
      }
      if ((m = /^\/api\/projects\/([\w-]+)$/.exec(path)) && req.method === 'GET') return json(res, 200, store.detail(m[1]));
      if ((m = /^\/api\/projects\/([\w-]+)\/stamp$/.exec(path)) && req.method === 'GET') {
        store.project(m[1]);
        return json(res, 200, store.db.prepare('SELECT id,title,position,revision,active_take_id FROM shots WHERE project_id=? ORDER BY position,id').all(m[1]));
      }
      if ((m = /^\/api\/shots\/([\w-]+)$/.exec(path)) && req.method === 'GET') {
        const shot = store.shot(m[1]); return json(res, 200, store.detail(shot.project_id).shots.find(row => row.id === shot.id));
      }
      if ((m = /^\/api\/projects\/([\w-]+)\/shots$/.exec(path)) && req.method === 'POST') {
        return json(res, 201, store.addShot(m[1], (await body(req)).title));
      }
      if ((m = /^\/api\/projects\/([\w-]+)\/order$/.exec(path)) && req.method === 'PUT') return json(res, 200, store.reorder(m[1], (await body(req)).ids));
      if ((m = /^\/api\/shots\/([\w-]+)$/.exec(path)) && req.method === 'PATCH') return json(res, 200, store.updateShot(m[1], await body(req)));
      if ((m = /^\/api\/shots\/([\w-]+)\/(split|trim)$/.exec(path)) && req.method === 'POST') {
        return json(res, 201, store[m[2]](m[1], await body(req)));
      }
      if ((m = /^\/api\/shots\/([\w-]+)\/snapshot$/.exec(path)) && req.method === 'POST') {
        return json(res, 201, store.addTake(m[1], (await body(req)).revision));
      }
      if (((m = /^\/api\/shots\/([\w-]+)\/takes$/.exec(path)) || path === '/api/library/import') && req.method === 'POST') {
        const isLibrary = path === '/api/library/import';
        const shotId = isLibrary ? null : m[1];
        const revision = Number(req.headers['x-shot-revision']);
        if (!isLibrary) store.expected(store.shot(shotId), revision);
        const filename = basename((url.searchParams.get('filename') || '').replaceAll('\\', '/'));
        const ext = extname(filename).toLowerCase(); const mime = (isLibrary ? libraryTypes : types)[ext];
        if (!mime || filename.length > 255) throw new AppError(415, isLibrary ? '素材库支持常见音频、GIF、图片与视频格式' : '支持 MP4、WebM、MOV、PNG、JPG、WebP');
        const length = Number(req.headers['content-length']);
        if (length > MAX_UPLOAD) throw new AppError(413, '单个素材上限 1 GB');
        const id = randomUUID(); const storedName = id + ext;
        const temp = join(mediaDir, id + '.part'); const target = join(mediaDir, storedName);
        const hash = createHash('sha256'); let bytes = 0;
        try {
          const meter = new Transform({ transform(chunk, _, callback) {
            bytes += chunk.length;
            if (bytes > MAX_UPLOAD) return callback(new AppError(413, '单个素材上限 1 GB'));
            hash.update(chunk); callback(null, chunk);
          } });
          await pipeline(req, meter, createWriteStream(temp, { flags: 'wx' }));
          if (!bytes) throw new AppError(400, '素材文件不能为空');
          await rename(temp, target);
          const media = { id, filename, stored_name: storedName, mime, bytes, sha256: hash.digest('hex') };
          const result = isLibrary ? library.add(media) : store.addTake(shotId, revision, media);
          return json(res, 201, result);
        } catch (error) {
          await rm(temp, { force: true }); await rm(target, { force: true }); throw error;
        }
      }
      if ((m = /^\/media\/([\w-]+)$/.exec(path)) && ['GET', 'HEAD'].includes(req.method)) {
        const media = store.media(m[1]);
        if (!media) throw new AppError(404, '素材不存在');
        return await sendFile(req, res, join(mediaDir, media.stored_name), media.mime, true);
      }
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/segments.js': ['segments.js', 'text/javascript; charset=utf-8'], '/jobs.js': ['jobs.js', 'text/javascript; charset=utf-8'], '/library.js': ['library.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/segments.css': ['segments.css', 'text/css; charset=utf-8'], '/jobs.css': ['jobs.css', 'text/css; charset=utf-8'], '/library.css': ['library.css', 'text/css; charset=utf-8'], '/regions.js': ['regions.js', 'text/javascript; charset=utf-8'], '/regions.css': ['regions.css', 'text/css; charset=utf-8'] };
      if (files[path] && ['GET', 'HEAD'].includes(req.method)) return await sendFile(req, res, join(root, 'public', files[path][0]), files[path][1]);
      throw new AppError(404, '找不到这个地址');
    } catch (error) {
      if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(); return; }
      if (!error.status && error.code !== 'ENOENT') console.error(error);
      json(res, error.status || (error.code === 'ENOENT' ? 404 : 500), { error: error.status ? error.message : '本地服务错误，请查看终端' });
    }
  });
  server.requestTimeout = 30 * 60 * 1000;
  return { server, store, jobs, runner, library, regions, dataDir, async close() { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await runner.close(); store.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  const port = Number(process.env.PORT || 4317);
  app.server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。请使用现有页面，或设置 PORT 后重启。` : error.message);
    app.store.close(); process.exitCode = 1;
  });
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`AiCut: http://127.0.0.1:${app.server.address().port}`);
    console.log(`Local data: ${app.dataDir}`);
    console.log('Press Ctrl+C to stop.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.close().then(() => process.exit(0)); });
}
