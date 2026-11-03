import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const statuses = ['todo', 'revise', 'review', 'approved'];
const now = () => new Date().toISOString();
function string(value, field, max = 50000) {
  if (typeof value !== 'string' || value.length > max) throw new AppError(400, `${field} 格式不正确或过长`);
  return value;
}
function title(value) {
  const result = string(value, '名称', 200).trim();
  if (!result) throw new AppError(400, '名称不能为空');
  return result;
}

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'workbench.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shots (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL, position INTEGER NOT NULL, prompt TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo',
      active_take_id TEXT, revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS takes (
      id TEXT PRIMARY KEY, shot_id TEXT NOT NULL REFERENCES shots(id), number INTEGER NOT NULL,
      prompt TEXT NOT NULL, notes TEXT NOT NULL, media_id TEXT,
      created_at TEXT NOT NULL, UNIQUE(shot_id, number)
    );
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE,
      mime TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shots_project ON shots(project_id,position);
    CREATE INDEX IF NOT EXISTS takes_shot ON takes(shot_id,number);
    PRAGMA user_version=1;
  `);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function project(id) {
    const row = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!row) throw new AppError(404, '项目不存在');
    return row;
  }
  function shot(id) {
    const row = db.prepare('SELECT * FROM shots WHERE id=?').get(id);
    if (!row) throw new AppError(404, '片段不存在');
    return row;
  }
  function expected(row, revision) {
    if (!Number.isInteger(revision)) throw new AppError(400, '缺少片段版本号');
    if (row.revision !== revision) throw new AppError(409, '这个片段已在其他页面更新。请先复制未保存内容，再刷新页面。');
  }
  function detail(id) {
    const result = project(id);
    result.shots = db.prepare('SELECT * FROM shots WHERE project_id=? ORDER BY position,id').all(id).map(row => ({
      ...row,
      takes: db.prepare(`SELECT t.*, m.filename, m.mime, m.bytes FROM takes t
        LEFT JOIN media m ON m.id=t.media_id WHERE t.shot_id=? ORDER BY t.number DESC`).all(row.id)
    }));
    return result;
  }
  function createProject(name) {
    const row = { id: randomUUID(), title: title(name), created_at: now() };
    db.prepare('INSERT INTO projects VALUES(?,?,?)').run(row.id, row.title, row.created_at);
    return row;
  }
  function addShot(projectId, name) {
    project(projectId);
    const id = randomUUID();
    const pos = db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS next FROM shots WHERE project_id=?').get(projectId).next;
    db.prepare('INSERT INTO shots(id,project_id,title,position,updated_at) VALUES(?,?,?,?,?)').run(id, projectId, title(name), pos, now());
    return shot(id);
  }
  function updateShot(id, patch) {
    const row = shot(id); expected(row, patch.revision);
    const fields = ['title', 'prompt', 'notes', 'status', 'active_take_id'];
    if (Object.keys(patch).some(key => ![...fields, 'revision'].includes(key))) throw new AppError(400, '不支持的修改字段');
    const next = { ...row, ...patch };
    next.title = title(next.title);
    string(next.prompt, 'Prompt'); string(next.notes, '备注');
    if (!statuses.includes(next.status)) throw new AppError(400, '状态不正确');
    if (next.active_take_id !== null && !db.prepare('SELECT id FROM takes WHERE id=? AND shot_id=?').get(next.active_take_id, id)) {
      throw new AppError(400, '采用版不属于这个片段');
    }
    db.prepare(`UPDATE shots SET title=?,prompt=?,notes=?,status=?,active_take_id=?,revision=revision+1,updated_at=? WHERE id=?`)
      .run(next.title, next.prompt, next.notes, next.status, next.active_take_id, now(), id);
    return shot(id);
  }
  function addTake(id, revision, media = null) {
    return transaction(() => {
      const row = shot(id); expected(row, revision);
      const number = db.prepare('SELECT COALESCE(MAX(number),0)+1 AS next FROM takes WHERE shot_id=?').get(id).next;
      const takeId = randomUUID();
      if (media) db.prepare('INSERT INTO media VALUES(?,?,?,?,?,?)')
        .run(media.id, media.filename, media.stored_name, media.mime, media.bytes, media.sha256);
      db.prepare('INSERT INTO takes VALUES(?,?,?,?,?,?,?)').run(takeId, id, number, row.prompt, row.notes, media?.id ?? null, now());
      db.prepare("UPDATE shots SET active_take_id=?,revision=revision+1,updated_at=?,status='review' WHERE id=?").run(takeId, now(), id);
      return { id: takeId, number, shot: shot(id) };
    });
  }
  function reorder(projectId, ids) {
    const current = detail(projectId).shots.map(row => row.id);
    if (!Array.isArray(ids) || ids.length !== current.length || new Set(ids).size !== ids.length || ids.some(id => !current.includes(id))) {
      throw new AppError(409, '片段列表已变化，请刷新后重排');
    }
    transaction(() => {
      const update = db.prepare('UPDATE shots SET position=? WHERE id=?');
      ids.forEach((id, index) => update.run(index, id));
    });
    return detail(projectId);
  }
  return {
    db, shot, project, detail, expected, createProject, addShot, updateShot, addTake, reorder,
    listProjects: () => db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM shots s WHERE s.project_id=p.id) AS shot_count
      FROM projects p ORDER BY created_at,id`).all(),
    media: id => db.prepare('SELECT * FROM media WHERE id=?').get(id),
    close: () => db.close()
  };
}
