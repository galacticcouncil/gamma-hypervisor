import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './index';
import { log, nowSec, tick } from '../collect/util';

// nightly `VACUUM INTO <dir>/gamma-<yyyymmdd>.db` (plain sql, safe under wal,
// no sqlite3 binary), keep the newest 14. restore = stop, copy over DB_PATH, start.

export const BACKUP_KEEP = 14;
const NAME_RE = /^gamma-(\d{8})\.db$/;

export function backupName(now = nowSec()): string {
  return `gamma-${new Date(now * 1000).toISOString().slice(0, 10).replace(/-/g, '')}.db`;
}

export interface BackupResult {
  file: string;
  bytes: number;
  pruned: string[];
}

export function runBackup(db: Db, dir: string, keep = BACKUP_KEEP, now = nowSec()): BackupResult {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, backupName(now));
  const tmp = `${file}.tmp`;
  if (existsSync(tmp)) rmSync(tmp, { force: true });
  // VACUUM INTO refuses an existing target, so build beside it and swap
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  if (existsSync(file)) rmSync(file, { force: true });
  renameSync(tmp, file);
  const pruned = pruneBackups(dir, keep);
  db.metaSet('last_backup_at', String(now));
  return { file, bytes: statSync(file).size, pruned };
}

export function pruneBackups(dir: string, keep = BACKUP_KEEP): string[] {
  const files = readdirSync(dir)
    .filter((f) => NAME_RE.test(f))
    .sort();
  const excess = files.slice(0, Math.max(0, files.length - keep));
  for (const f of excess) rmSync(join(dir, f), { force: true });
  return excess;
}

// ms until the next 03:30 utc
export function msUntilNextBackup(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 3, 30, 0, 0);
  return next > nowMs ? next - nowMs : next + 86_400_000 - nowMs;
}

export function scheduleBackup(db: Db, dir: string, keep = BACKUP_KEEP): () => void {
  let timer: NodeJS.Timeout | null = null;
  const arm = (): void => {
    timer = setTimeout(() => {
      try {
        const r = runBackup(db, dir, keep);
        tick('backup', true);
        log('db/backup', `wrote ${r.bytes} bytes${r.pruned.length ? `, pruned ${r.pruned.length}` : ''}`);
      } catch (e) {
        tick('backup', false);
        log('db/backup', `failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      arm();
    }, msUntilNextBackup());
    timer.unref?.();
  };
  arm();
  return () => {
    if (timer) clearTimeout(timer);
  };
}
