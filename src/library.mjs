import { randomUUID } from 'node:crypto';
import { AppError } from './store.mjs';

export const libraryManifest = {
  id: 'asset-library', name: '素材库', version: '0.1.0', builtin: true,
  capabilities: ['local-import', 'audio-image-video-preview', 'tags', 'favorites', 'shot-references'],
  rendered_mix: false
};
const now = () => new Date().toISOString();
function text(value, limit, field) {
  if (typeof value !== 'string' || value.length > limit) throw new AppError(400, `${field} 格式不正确或过长`); return value;
}
export function openLibrary(store) {
  const db = store.db;
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function asset(id) {
    const row = db.prepare(`SELECT a.*,m.filename,m.mime,m.bytes FROM library_assets a JOIN media m ON m.id=a.media_id WHERE a.id=?`).get(id);
    if (!row) throw new AppError(404, '素材不存在'); return { ...row, tags: JSON.parse(row.tags), favorite: Boolean(row.favorite) };
  }
  function add(media) {
    return transaction(() => {
      const id = randomUUID();
      db.prepare('INSERT INTO media VALUES(?,?,?,?,?,?)').run(media.id, media.filename, media.stored_name, media.mime, media.bytes, media.sha256);
      db.prepare('INSERT INTO library_assets(id,media_id,title,created_at) VALUES(?,?,?,?)').run(id, media.id, media.filename.slice(0,200), now());
      return asset(id);
    });
  }
  function update(id, patch) {
    return transaction(() => {
      const old = asset(id); store.expected(old, patch.revision);
      if (Object.keys(patch).some(key => !['revision','title','tags','favorite','source_url','author','license'].includes(key))) throw new AppError(400,'不支持的素材字段');
      const next = { ...old, ...patch }; next.title = text(next.title,200,'名称').trim();
      if (!next.title || typeof next.favorite !== 'boolean' || !Array.isArray(next.tags) || next.tags.length > 30 || next.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 80)) throw new AppError(400,'名称、标签或收藏格式不正确');
      for (const key of ['source_url','author','license']) text(next[key],key === 'source_url' ? 2000 : 500,key);
      if (next.source_url && !/^https?:\/\//i.test(next.source_url)) throw new AppError(400,'来源链接应为 http(s)');
      const normalizedTags = [...new Set(next.tags.map(tag=>tag.trim()))];
      const contextChanged = next.title !== old.title || JSON.stringify(normalizedTags) !== JSON.stringify(old.tags) || ['source_url','author','license'].some(key=>next[key]!==old[key]);
      db.prepare('UPDATE library_assets SET title=?,tags=?,favorite=?,source_url=?,author=?,license=?,revision=revision+1 WHERE id=?')
        .run(next.title,JSON.stringify(normalizedTags),Number(next.favorite),next.source_url,next.author,next.license,id);
      if (contextChanged) db.prepare('UPDATE shots SET revision=revision+1,updated_at=? WHERE id IN (SELECT shot_id FROM shot_refs WHERE asset_id=?)').run(now(),id);
      return asset(id);
    });
  }
  function attach(shotId, payload) {
    return transaction(() => {
      const shot = store.shot(shotId); store.expected(shot,payload.revision); asset(payload.asset_id);
      const offset = payload.offset_ms ?? 0, note = payload.note ?? '';
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 86400000) throw new AppError(400,'参考位置必须是 0–24 小时内的整数毫秒');
      text(note,5000,'参考说明');
      const take = db.prepare('SELECT * FROM takes WHERE id=?').get(shot.active_take_id);
      if (take?.end_ms != null && offset >= take.end_ms - take.start_ms) throw new AppError(400,'参考位置超出当前段，请缩短偏移或调整范围');
      const id = randomUUID();
      db.prepare('INSERT INTO shot_refs VALUES(?,?,?,?,?,?)').run(id,shotId,payload.asset_id,offset,note,now());
      db.prepare('UPDATE shots SET revision=revision+1,updated_at=? WHERE id=?').run(now(),shotId);
      return store.detail(shot.project_id);
    });
  }
  function detach(shotId, refId, revision) {
    return transaction(() => {
      const shot = store.shot(shotId); store.expected(shot,revision);
      if (!db.prepare('DELETE FROM shot_refs WHERE id=? AND shot_id=?').run(refId,shotId).changes) throw new AppError(404,'该段没有这个参考');
      db.prepare('UPDATE shots SET revision=revision+1,updated_at=? WHERE id=?').run(now(),shotId);
      return store.detail(shot.project_id);
    });
  }
  function editReference(shotId, refId, payload) {
    return transaction(() => {
      const shot = store.shot(shotId); store.expected(shot,payload.revision);
      const offset = payload.offset_ms, note = payload.note;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 86400000) throw new AppError(400,'参考位置无效');
      text(note,5000,'参考说明');
      const take = db.prepare('SELECT * FROM takes WHERE id=?').get(shot.active_take_id);
      if (take?.end_ms != null && offset >= take.end_ms - take.start_ms) throw new AppError(400,'参考位置超出当前段');
      if (!db.prepare('UPDATE shot_refs SET offset_ms=?,note=? WHERE id=? AND shot_id=?').run(offset,note,refId,shotId).changes) throw new AppError(404,'参考不存在');
      db.prepare('UPDATE shots SET revision=revision+1,updated_at=? WHERE id=?').run(now(),shotId);
      return store.detail(shot.project_id);
    });
  }
  return { asset, add, update, attach, detach, editReference,
    list: () => db.prepare('SELECT id FROM library_assets ORDER BY favorite DESC,created_at DESC,id').all().map(row => asset(row.id))
  };
}
