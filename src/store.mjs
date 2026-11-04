import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
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
  const schemaVersion = db.prepare('PRAGMA user_version').get().user_version;
  if (schemaVersion > 5) { db.close(); throw new Error('数据库由更新版本创建，请升级应用。'); }
  if (schemaVersion === 4) {
    const backupPath = join(dataDir, 'schema-v4-before-v5.sqlite');
    if (!existsSync(backupPath)) db.prepare('VACUUM INTO ?').run(backupPath);
  }
  if (schemaVersion === 3) {
    const backupPath = join(dataDir, 'schema-v3-before-v4.sqlite');
    if (!existsSync(backupPath)) db.prepare('VACUUM INTO ?').run(backupPath);
  }
  if (schemaVersion === 2) {
    const backupPath = join(dataDir, 'schema-v2-before-v3.sqlite');
    if (!existsSync(backupPath)) db.prepare('VACUUM INTO ?').run(backupPath);
  }
  if (schemaVersion === 1) {
    const backupPath = join(dataDir, 'schema-v1-before-v2.sqlite');
    if (!existsSync(backupPath)) db.prepare('VACUUM INTO ?').run(backupPath);
  }
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
  `);
  if (schemaVersion < 2) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE takes ADD COLUMN start_ms INTEGER;
      ALTER TABLE takes ADD COLUMN end_ms INTEGER;
      ALTER TABLE takes ADD COLUMN duration_ms INTEGER;
      PRAGMA user_version=2;
      COMMIT;`);
  }
  if (schemaVersion < 3) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, shot_id TEXT NOT NULL REFERENCES shots(id),
        project_id TEXT NOT NULL REFERENCES projects(id), provider TEXT NOT NULL,
        status TEXT NOT NULL, source_revision INTEGER NOT NULL, snapshot TEXT NOT NULL,
        result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id,created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_job_per_shot ON jobs(shot_id) WHERE status IN ('queued','running');
      PRAGMA user_version=3; COMMIT;`);
  }
  if (schemaVersion < 4) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS library_assets (
        id TEXT PRIMARY KEY,media_id TEXT NOT NULL REFERENCES media(id),title TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',favorite INTEGER NOT NULL DEFAULT 0,
        source_url TEXT NOT NULL DEFAULT '',author TEXT NOT NULL DEFAULT '',license TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shot_refs (
        id TEXT PRIMARY KEY,shot_id TEXT NOT NULL REFERENCES shots(id),asset_id TEXT NOT NULL REFERENCES library_assets(id),
        offset_ms INTEGER NOT NULL DEFAULT 0,note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS shot_refs_shot ON shot_refs(shot_id);
      PRAGMA user_version=4; COMMIT;`);
  }
  if (schemaVersion < 5) {
    // Box coordinates are integers in 1/10000 of the displayed frame; times are segment-relative ms, end NULL = segment end.
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS shot_regions (
        id TEXT PRIMARY KEY,shot_id TEXT NOT NULL REFERENCES shots(id),position INTEGER NOT NULL,
        x INTEGER NOT NULL,y INTEGER NOT NULL,w INTEGER NOT NULL,h INTEGER NOT NULL,
        start_ms INTEGER NOT NULL DEFAULT 0,end_ms INTEGER,note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS shot_regions_shot ON shot_regions(shot_id,position);
      PRAGMA user_version=5; COMMIT;`);
  }
  function regions(shotId) {
    return db.prepare('SELECT * FROM shot_regions WHERE shot_id=? ORDER BY position,id').all(shotId);
  }
  function references(shotId) {
    return db.prepare(`SELECT r.*,a.title,a.tags,a.source_url,a.author,a.license,m.filename,m.mime,m.id AS media_id
      FROM shot_refs r JOIN library_assets a ON a.id=r.asset_id JOIN media m ON m.id=a.media_id WHERE r.shot_id=? ORDER BY r.offset_ms,r.created_at,r.id`)
      .all(shotId).map(row => ({ ...row, tags: JSON.parse(row.tags) }));
  }
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
      references: references(row.id),
      regions: regions(row.id),
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
      db.prepare('INSERT INTO takes(id,shot_id,number,prompt,notes,media_id,created_at) VALUES(?,?,?,?,?,?,?)').run(takeId, id, number, row.prompt, row.notes, media?.id ?? null, now());
      db.prepare("UPDATE shots SET active_take_id=?,revision=revision+1,updated_at=?,status='review' WHERE id=?").run(takeId, now(), id);
      return { id: takeId, number, shot: shot(id) };
    });
  }
  function rangeSource(id, revision) {
    const row = shot(id); expected(row, revision);
    const source = db.prepare(`SELECT t.*,m.mime FROM takes t JOIN media m ON m.id=t.media_id
      WHERE t.id=? AND t.shot_id=?`).get(row.active_take_id, id);
    if (!source || !source.mime.startsWith('video/')) throw new AppError(400, '请先选择一个视频版本');
    return { row, source };
  }
  function validateRange(start, end, duration) {
    if (![start, end, duration].every(Number.isSafeInteger) || start < 0 || end > duration || end - start < 100 || duration > 86400000) {
      throw new AppError(400, '时间范围无效：每段至少 0.1 秒，且不能超出视频时长（上限 24 小时）');
    }
  }
  function rangeTake(row, source, start, end, duration) {
    const takeId = randomUUID();
    const number = db.prepare('SELECT COALESCE(MAX(number),0)+1 AS next FROM takes WHERE shot_id=?').get(row.id).next;
    db.prepare(`INSERT INTO takes(id,shot_id,number,prompt,notes,media_id,created_at,start_ms,end_ms,duration_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(takeId, row.id, number, row.prompt, row.notes, source.media_id, now(), start, end, duration);
    db.prepare("UPDATE shots SET active_take_id=?,revision=revision+1,updated_at=?,status='review' WHERE id=?").run(takeId, now(), row.id);
  }
  function trim(id, payload) {
    return transaction(() => {
      const { row, source } = rangeSource(id, payload.revision);
      const duration = source.duration_ms ?? payload.duration_ms;
      validateRange(payload.start_ms, payload.end_ms, duration);
      rangeTake(row, source, payload.start_ms, payload.end_ms, duration);
      return detail(row.project_id);
    });
  }
  function split(id, payload) {
    return transaction(() => {
      const { row, source } = rangeSource(id, payload.revision);
      const duration = source.duration_ms ?? payload.duration_ms;
      const start = source.start_ms ?? 0, end = source.end_ms ?? duration;
      const cuts = payload.cuts_ms;
      if (!Array.isArray(cuts) || cuts.length < 1 || cuts.length > 99) throw new AppError(400, '请选择 2–100 段');
      const boundaries = [start, ...cuts, end];
      for (let n = 1; n < boundaries.length; n++) validateRange(boundaries[n - 1], boundaries[n], duration);
      db.prepare('UPDATE shots SET position=position+? WHERE project_id=? AND position>?').run(cuts.length, row.project_id, row.position);
      const name = row.title.slice(0, 190);
      const refs = references(row.id), boxes = regions(row.id), targets = [];
      for (let n = 0; n < boundaries.length - 1; n++) {
        let target = row;
        if (n > 0) {
          const newId = randomUUID();
          db.prepare(`INSERT INTO shots(id,project_id,title,position,prompt,notes,updated_at) VALUES(?,?,?,?,?,?,?)`)
            .run(newId, row.project_id, `${name} · ${String(n + 1).padStart(2, '0')}`, row.position + n, row.prompt, '', now());
          target = shot(newId);
        }
        rangeTake(target, source, boundaries[n], boundaries[n + 1], duration);
        targets.push({ id: target.id, start: boundaries[n], end: boundaries[n + 1] });
      }
      for (const ref of refs) {
        const absolute = start + ref.offset_ms;
        const target = targets.find(segment => absolute >= segment.start && absolute < segment.end);
        if (target) db.prepare('UPDATE shot_refs SET shot_id=?,offset_ms=? WHERE id=?').run(target.id, absolute - target.start, ref.id);
      }
      // A box applies over a time span, so it is copied into every new segment it overlaps and clipped to that segment.
      db.prepare('DELETE FROM shot_regions WHERE shot_id=?').run(row.id);
      const insertRegion = db.prepare('INSERT INTO shot_regions VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      const positions = new Map(targets.map(segment => [segment.id, 0]));
      for (const box of boxes) {
        const from = start + box.start_ms, to = box.end_ms == null ? end : start + box.end_ms;
        let placed = false;
        for (const segment of targets) {
          const clippedFrom = Math.max(from, segment.start), clippedTo = Math.min(to, segment.end);
          if (clippedTo <= clippedFrom) continue;
          const localEnd = clippedTo === segment.end && (box.end_ms == null || to === segment.end) ? null : clippedTo - segment.start;
          const position = positions.get(segment.id); positions.set(segment.id, position + 1);
          insertRegion.run(randomUUID(), segment.id, position, box.x, box.y, box.w, box.h, clippedFrom - segment.start, localEnd, box.note, box.created_at);
          placed = true;
        }
        // Out-of-range boxes stay on the first card unchanged, like references, so the user can review them.
        if (!placed) {
          const position = positions.get(row.id); positions.set(row.id, position + 1);
          insertRegion.run(box.id, row.id, position, box.x, box.y, box.w, box.h, box.start_ms, box.end_ms, box.note, box.created_at);
        }
      }
      return detail(row.project_id);
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
    db, shot, project, detail, expected, createProject, addShot, updateShot, addTake, reorder, split, trim, references, regions,
    listProjects: () => db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM shots s WHERE s.project_id=p.id) AS shot_count
      FROM projects p ORDER BY created_at,id`).all(),
    media: id => db.prepare('SELECT * FROM media WHERE id=?').get(id),
    close: () => db.close()
  };
}
