import { randomUUID } from 'node:crypto';
import { AppError } from './store.mjs';

export const REGION_SCALE = 10000, MAX_REGIONS = 20, MIN_SIZE = 50;
const now = () => new Date().toISOString();
const percent = value => Math.round(value / 10) / 10;
export function placement(box) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const col = cx < REGION_SCALE / 3 ? 0 : cx > REGION_SCALE * 2 / 3 ? 2 : 1;
  const row = cy < REGION_SCALE / 3 ? 0 : cy > REGION_SCALE * 2 / 3 ? 2 : 1;
  return [['左上', '正上方', '右上'], ['左侧', '画面中央', '右侧'], ['左下', '正下方', '右下']][row][col];
}
// Snapshot form for CLI tasks: readable percentages, segment-relative times, numbered like the UI.
export function describeRegions(rows) {
  return rows.map((box, index) => ({
    number: index + 1, placement: placement(box),
    box_percent: { left: percent(box.x), top: percent(box.y), width: percent(box.w), height: percent(box.h) },
    start_ms: box.start_ms, end_ms: box.end_ms, note: box.note
  }));
}
export function openRegions(store) {
  const db = store.db;
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function check(item, length) {
    if (!item || typeof item !== 'object') throw new AppError(400, '框选格式不正确');
    const { x, y, w, h } = item, start = item.start_ms ?? 0, end = item.end_ms ?? null, note = item.note ?? '';
    if (![x, y, w, h].every(Number.isSafeInteger) || x < 0 || y < 0 || w < MIN_SIZE || h < MIN_SIZE || x + w > REGION_SCALE || y + h > REGION_SCALE) {
      throw new AppError(400, '框选位置无效：框需在画面内，宽高至少 0.5%');
    }
    if (!Number.isSafeInteger(start) || start < 0 || start > 86400000 || (end !== null && (!Number.isSafeInteger(end) || end - start < 100 || end > 86400000))) {
      throw new AppError(400, '框选时间无效：结束须比开始晚至少 0.1 秒，或留空表示到段尾');
    }
    if (length != null && (start >= length || (end !== null && end > length))) throw new AppError(400, '框选时间超出当前段，请调整');
    if (typeof note !== 'string' || note.length > 5000) throw new AppError(400, '框选说明格式不正确或过长');
    return { x, y, w, h, start_ms: start, end_ms: end, note };
  }
  // The client always sends the complete box list; the shot revision guards against overwriting another tab.
  function replace(shotId, payload) {
    return transaction(() => {
      const shot = store.shot(shotId); store.expected(shot, payload.revision);
      if (!Array.isArray(payload.regions) || payload.regions.length > MAX_REGIONS) throw new AppError(400, `每段最多 ${MAX_REGIONS} 个框`);
      const take = shot.active_take_id ? db.prepare('SELECT t.*,m.mime FROM takes t LEFT JOIN media m ON m.id=t.media_id WHERE t.id=?').get(shot.active_take_id) : null;
      if (payload.regions.length && !take?.media_id) throw new AppError(400, '请先导入画面，再框选要修改的区域');
      const length = take?.end_ms != null ? take.end_ms - take.start_ms : null;
      const rows = payload.regions.map(item => check(item, length));
      db.prepare('DELETE FROM shot_regions WHERE shot_id=?').run(shotId);
      const insert = db.prepare('INSERT INTO shot_regions VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      rows.forEach((row, index) => insert.run(randomUUID(), shotId, index, row.x, row.y, row.w, row.h, row.start_ms, row.end_ms, row.note, now()));
      db.prepare('UPDATE shots SET revision=revision+1,updated_at=? WHERE id=?').run(now(), shotId);
      return store.detail(shot.project_id);
    });
  }
  return { replace };
}
