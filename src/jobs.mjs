import { randomUUID } from 'node:crypto';
import { AppError } from './store.mjs';

export const resultSchema = {
  type: 'object', additionalProperties: false,
  properties: { revised_prompt: { type: 'string' }, summary: { type: 'string' } },
  required: ['revised_prompt', 'summary']
};
export function validateResult(result) {
  if (!result || typeof result.revised_prompt !== 'string' || !result.revised_prompt.trim() || result.revised_prompt.length > 50000 || typeof result.summary !== 'string' || result.summary.length > 10000) {
    throw new AppError(400, 'CLI 结果需要 revised_prompt（1–50000 字符）与 summary（最多 10000 字符）');
  }
  return { revised_prompt: result.revised_prompt, summary: result.summary };
}
export function openJobs(store) {
  const db = store.db, now = () => new Date().toISOString();
  const unpack = row => row && ({ ...row, snapshot: JSON.parse(row.snapshot), result: row.result ? JSON.parse(row.result) : null });
  function get(id) {
    const job = unpack(db.prepare('SELECT * FROM jobs WHERE id=?').get(id));
    if (!job) throw new AppError(404, '任务不存在'); return job;
  }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function enqueue(shotId, payload) {
    return transaction(() => {
      const shot = store.shot(shotId); store.expected(shot, payload.revision);
      if (!['claude', 'codex', 'manual'].includes(payload.provider)) throw new AppError(400, '请选择 Claude Code、Codex 或外部 CLI');
      if (db.prepare("SELECT id FROM jobs WHERE shot_id=? AND status IN ('queued','running')").get(shotId)) throw new AppError(409, '这个片段已有待处理任务，请等待或取消');
      const project = store.detail(shot.project_id);
      const take = project.shots.find(row => row.id === shotId).takes.find(t => t.id === shot.active_take_id);
      const snapshot = { project: { id: project.id, title: project.title }, shot: { id: shot.id, title: shot.title, number: shot.position + 1, prompt: shot.prompt, notes: shot.notes, revision: shot.revision }, take: take ?? null, references: store.references(shotId) };
      const id = randomUUID(), time = now();
      db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, shotId, shot.project_id, payload.provider, 'queued', shot.revision, JSON.stringify(snapshot), null, null, time, time);
      return get(id);
    });
  }
  function start(id) {
    if (!db.prepare("UPDATE jobs SET status='running',updated_at=? WHERE id=? AND status='queued'").run(now(), id).changes) throw new AppError(409, '任务已被领取或已结束');
    return get(id);
  }
  function complete(id, result) {
    const checked = validateResult(result);
    if (!db.prepare("UPDATE jobs SET status='completed',result=?,error=NULL,updated_at=? WHERE id=? AND status='running'").run(JSON.stringify(checked), now(), id).changes) throw new AppError(409, '任务未运行或已取消，不能写入结果');
    return get(id);
  }
  function fail(id, error) {
    db.prepare("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='running'").run(String(error).slice(0, 5000), now(), id);
  }
  function cancel(id) {
    const job = get(id);
    if (!['queued', 'running'].includes(job.status)) throw new AppError(409, '任务已经结束');
    db.prepare("UPDATE jobs SET status='cancelled',updated_at=? WHERE id=?").run(now(), id); return get(id);
  }
  function apply(id, revision) {
    return transaction(() => {
      const job = get(id), shot = store.shot(job.shot_id);
      if (job.status !== 'completed') throw new AppError(409, '只有已完成的任务可以采用');
      store.expected(shot, revision);
      if (shot.revision !== job.source_revision) throw new AppError(409, '推送后这个片段已修改，请复制结果手动合并，避免覆盖新内容');
      // Keep a text snapshot of the draft before replacing it. It does not alter the active media.
      const number = db.prepare('SELECT COALESCE(MAX(number),0)+1 AS n FROM takes WHERE shot_id=?').get(shot.id).n;
      db.prepare('INSERT INTO takes(id,shot_id,number,prompt,notes,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), shot.id, number, shot.prompt, shot.notes, now());
      store.updateShot(shot.id, { revision, prompt: job.result.revised_prompt, status: 'review' });
      db.prepare("UPDATE jobs SET status='applied',updated_at=? WHERE id=?").run(now(), id);
      return get(id);
    });
  }
  function recover() {
    db.prepare("UPDATE jobs SET status='interrupted',error='服务已重启，请手动重新推送；未自动重试',updated_at=? WHERE status='running' OR (status='queued' AND provider<>'manual')").run(now());
  }
  return { get, enqueue, start, complete, fail, cancel, apply, recover,
    list: projectId => {
      if (projectId) store.project(projectId);
      return db.prepare(`SELECT * FROM jobs ${projectId ? 'WHERE project_id=?' : ''} ORDER BY created_at DESC,id DESC LIMIT 200`).all(...(projectId ? [projectId] : [])).map(unpack).map(({ snapshot, result, ...job }) => ({ ...job, has_result: Boolean(result) }));
    }
  };
}
