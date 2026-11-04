import { randomUUID } from 'node:crypto';
import { AppError } from './store.mjs';

export const voiceProviders = ['elevenlabs', 'other'];
const now = () => new Date().toISOString();
function text(value, limit, field, required = false) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw new AppError(400, `${field} 格式不正确、为空或过长`);
  return required ? value.trim() : value;
}
// Project characters and the voice each one should use; lines on shots point at these rows.
export function openVoices(store) {
  const db = store.db;
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function character(id) {
    const row = db.prepare('SELECT * FROM characters WHERE id=?').get(id);
    if (!row) throw new AppError(404, '角色不存在'); return row;
  }
  function check(next) {
    next.name = text(next.name, 100, '角色名称', true);
    if (!voiceProviders.includes(next.provider)) throw new AppError(400, '声音来源应为 elevenlabs 或 other');
    text(next.voice_id, 200, '声音 ID'); text(next.voice_notes, 2000, '声音描述');
    if (db.prepare('SELECT id FROM characters WHERE project_id=? AND name=? AND id<>?').get(next.project_id, next.name, next.id ?? '')) throw new AppError(409, '这个项目已有同名角色');
    return next;
  }
  function create(projectId, payload) {
    store.project(projectId);
    const row = check({ project_id: projectId, name: payload.name ?? '', provider: payload.provider ?? 'elevenlabs', voice_id: payload.voice_id ?? '', voice_notes: payload.voice_notes ?? '' });
    db.prepare('INSERT INTO characters(id,project_id,name,provider,voice_id,voice_notes,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), projectId, row.name, row.provider, row.voice_id, row.voice_notes, now());
    return store.characters(projectId);
  }
  function update(id, patch) {
    return transaction(() => {
      const row = character(id); store.expected(row, patch.revision);
      if (Object.keys(patch).some(key => !['revision', 'name', 'provider', 'voice_id', 'voice_notes'].includes(key))) throw new AppError(400, '不支持的角色字段');
      const next = check({ ...row, ...patch });
      db.prepare('UPDATE characters SET name=?,provider=?,voice_id=?,voice_notes=?,revision=revision+1 WHERE id=?').run(next.name, next.provider, next.voice_id, next.voice_notes, id);
      // Voice changes alter what a pending CLI task saw, so shots using this character get a new revision.
      db.prepare('UPDATE shots SET revision=revision+1,updated_at=? WHERE id IN (SELECT shot_id FROM shot_lines WHERE character_id=?)').run(now(), id);
      return store.characters(row.project_id);
    });
  }
  function remove(id, revision) {
    return transaction(() => {
      const row = character(id); store.expected(row, revision);
      const used = db.prepare('SELECT COUNT(*) AS n FROM shot_lines WHERE character_id=?').get(id).n;
      if (used) throw new AppError(409, `还有 ${used} 句台词使用这个角色，请先改掉再删除`);
      db.prepare('DELETE FROM characters WHERE id=?').run(id);
      return store.characters(row.project_id);
    });
  }
  return { character, create, update, remove };
}
