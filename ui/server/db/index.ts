import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../config';

// one writer, one process: node:sqlite DatabaseSync at DB_PATH, WAL,
// synchronous=NORMAL. schema.sql is frozen at v1; MIGRATIONS is forward-only
// (nullable columns only) and versioned through meta.schema_version, which is
// never lowered, so a rolled-back image still opens a newer file.

export const SCHEMA_VERSION = 1;

export const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  // { version: 2, sql: 'ALTER TABLE cycles ADD COLUMN foo INT;' },
];

export type Params = SQLInputValue[] | Record<string, SQLInputValue>;
export type Row = Record<string, unknown>;
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

let schemaSql: string | null = null;

// import.meta.url in dev and in the container; cwd when bundled by vite for ssr
export function loadSchema(): string {
  if (schemaSql) return schemaSql;
  const candidates = [
    fileURLToPath(new URL('./schema.sql', import.meta.url)),
    resolve(process.cwd(), 'server/db/schema.sql'),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('schema.sql not found beside db/index.ts or under server/db');
  schemaSql = readFileSync(found, 'utf8');
  return schemaSql;
}

function assertWritableDir(path: string): void {
  const dir = dirname(resolve(path));
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch {
    const uid = typeof process.getuid === 'function' ? process.getuid() : '?';
    throw new Error(`DB_PATH directory not writable (uid ${uid}): ${dir}`);
  }
}

export class Db {
  readonly path: string;
  readonly raw: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();
  private depth = 0;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') assertWritableDir(path);
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec(loadSchema());
    this.migrate();
  }

  private migrate(): void {
    const current = Number(this.metaGet('schema_version') ?? 0);
    let version = current;
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.transaction(() => {
        this.raw.exec(m.sql);
        this.metaSet('schema_version', String(m.version));
      });
      version = m.version;
    }
    const target = Math.max(SCHEMA_VERSION, version);
    if (current < target) this.metaSet('schema_version', String(target));
  }

  get schemaVersion(): number {
    return Number(this.metaGet('schema_version') ?? 0);
  }

  // cached prepared statement; positional `?` or named `:k` / `$k` / `@k` bound as bare `k`
  prepare(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  get<T extends Row = Row>(sql: string, params?: Params): T | undefined {
    const s = this.prepare(sql);
    const row = params === undefined ? s.get() : Array.isArray(params) ? s.get(...params) : s.get(params);
    return row as T | undefined;
  }

  all<T extends Row = Row>(sql: string, params?: Params): T[] {
    const s = this.prepare(sql);
    const rows = params === undefined ? s.all() : Array.isArray(params) ? s.all(...params) : s.all(params);
    return rows as T[];
  }

  run(sql: string, params?: Params): RunResult {
    const s = this.prepare(sql);
    const r = params === undefined ? s.run() : Array.isArray(params) ? s.run(...params) : s.run(params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  // multi-statement sql, no params, no caching
  exec(sql: string): void {
    this.raw.exec(sql);
  }

  // BEGIN IMMEDIATE .. COMMIT, rolled back on throw; nested calls join the outer one
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  metaGet(k: string): string | null {
    const row = this.get<{ v: string | null }>('SELECT v FROM meta WHERE k = :k', { k });
    return row?.v ?? null;
  }

  // null deletes the key
  metaSet(k: string, v: string | null): void {
    if (v === null) this.run('DELETE FROM meta WHERE k = :k', { k });
    else this.run('INSERT INTO meta (k, v) VALUES (:k, :v) ON CONFLICT (k) DO UPDATE SET v = excluded.v', { k, v });
  }

  metaGetJson<T>(k: string): T | null {
    const v = this.metaGet(k);
    if (v === null) return null;
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }

  metaSetJson(k: string, v: unknown): void {
    this.metaSet(k, v === null || v === undefined ? null : JSON.stringify(v));
  }

  close(): void {
    this.stmts.clear();
    this.raw.close();
  }
}

export function openDb(path: string): Db {
  return new Db(path);
}

let current: Db | null = null;

// the process db at DB_PATH, opened on first use
export function getDb(): Db {
  if (!current) current = openDb(getConfig().DB_PATH);
  return current;
}

// tests only: swap the process db (pass null to force a reopen)
export function setDb(d: Db | null): void {
  current = d;
}

export function closeDb(): void {
  current?.close();
  current = null;
}

// facade over getDb() so routes can `import { db }` without opening at import time
export const db = {
  get: <T extends Row = Row>(sql: string, params?: Params) => getDb().get<T>(sql, params),
  all: <T extends Row = Row>(sql: string, params?: Params) => getDb().all<T>(sql, params),
  run: (sql: string, params?: Params) => getDb().run(sql, params),
  exec: (sql: string) => getDb().exec(sql),
  prepare: (sql: string) => getDb().prepare(sql),
  transaction: <T>(fn: () => T) => getDb().transaction(fn),
  metaGet: (k: string) => getDb().metaGet(k),
  metaSet: (k: string, v: string | null) => getDb().metaSet(k, v),
  metaGetJson: <T>(k: string) => getDb().metaGetJson<T>(k),
  metaSetJson: (k: string, v: unknown) => getDb().metaSetJson(k, v),
};
