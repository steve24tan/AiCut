import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function backupData(sourceDir, targetDir) {
  // Take the database snapshot first. Media is immutable and never deleted, so
  // copying it afterwards includes every file referenced by this snapshot.
  await mkdir(targetDir, { recursive: true });
  const db = new DatabaseSync(join(sourceDir, 'workbench.sqlite'), { readOnly: true });
  try {
    await backup(db, join(targetDir, 'workbench.sqlite'));
    await cp(join(sourceDir, 'media'), join(targetDir, 'media'), { recursive: true, errorOnExist: true, force: false });
  } finally { db.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const source = resolve(process.env.SHOT_DATA_DIR || join(root, 'data'));
  const target = join(root, 'backups', new Date().toISOString().replaceAll(':', '-'));
  try { await backupData(source, target); console.log(`Backup complete: ${target}`); }
  catch (error) { console.error(`Backup incomplete; do not use it for restore. ${error.message}`); process.exitCode = 1; }
}
