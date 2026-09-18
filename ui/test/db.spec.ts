import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, SCHEMA_VERSION, closeDb, db, getDb, loadSchema, openDb, setDb } from '../server/db/index';
import { loadConfig, setConfig } from '../server/config';

const TABLES = [
  'vaults',
  'keeper_runs',
  'keeper_status',
  'cycles_raw',
  'cycles',
  'episodes',
  'keeper_lines',
  'regimes',
  'txs',
  'chain_events',
  'samples',
  'samples_1h',
  'findings',
  'source_health',
  'events_log',
  'meta',
];

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'gamma-ui-db-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  closeDb();
  setConfig(null);
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o700);
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe('db', () => {
  it('applies schema.sql and stamps schema_version', () => {
    const d = openDb(':memory:');
    const names = d.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);
    expect(d.schemaVersion).toBe(SCHEMA_VERSION);
    expect(loadSchema()).toMatch(/CREATE TABLE IF NOT EXISTS meta/);
    d.close();
  });

  it('opens an existing file idempotently and never lowers schema_version', () => {
    const path = join(tmp(), 'gamma.db');
    const a = openDb(path);
    a.metaSet('schema_version', String(SCHEMA_VERSION + 5));
    a.close();
    const b = openDb(path);
    expect(b.schemaVersion).toBe(SCHEMA_VERSION + 5);
    expect(b.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    b.close();
  });

  it('binds positional and bare named params', () => {
    const d = openDb(':memory:');
    d.run('INSERT INTO meta (k, v) VALUES (?, ?)', ['a', '1']);
    d.run('INSERT INTO meta (k, v) VALUES (:k, :v)', { k: 'b', v: '2' });
    expect(d.get<{ v: string }>('SELECT v FROM meta WHERE k = ?', ['a'])?.v).toBe('1');
    expect(d.get<{ v: string }>('SELECT v FROM meta WHERE k = :k', { k: 'b' })?.v).toBe('2');
    expect(d.all('SELECT k FROM meta ORDER BY k')).toHaveLength(3); // + schema_version
    d.close();
  });

  it('meta get/set/json roundtrip, null deletes', () => {
    const d = openDb(':memory:');
    expect(d.metaGet('x')).toBeNull();
    d.metaSet('x', 'y');
    expect(d.metaGet('x')).toBe('y');
    d.metaSet('x', 'z');
    expect(d.metaGet('x')).toBe('z');
    d.metaSet('x', null);
    expect(d.metaGet('x')).toBeNull();
    d.metaSetJson('cursor:0xabc', { bootAt: '2026-09-18T00:00:00.000Z', seq: 42 });
    expect(d.metaGetJson<{ seq: number }>('cursor:0xabc')?.seq).toBe(42);
    d.metaSet('bad', '{not json');
    expect(d.metaGetJson('bad')).toBeNull();
    d.close();
  });

  it('rolls a transaction back on throw and joins nested ones', () => {
    const d = openDb(':memory:');
    expect(() =>
      d.transaction(() => {
        d.metaSet('t', '1');
        d.transaction(() => d.metaSet('u', '2'));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(d.metaGet('t')).toBeNull();
    expect(d.metaGet('u')).toBeNull();
    const out = d.transaction(() => {
      d.metaSet('t', '1');
      return 7;
    });
    expect(out).toBe(7);
    expect(d.metaGet('t')).toBe('1');
    d.close();
  });

  it('allows one open episode per vault', () => {
    const d = openDb(':memory:');
    const ins = 'INSERT INTO episodes (vault_id, code, since_ts, until_ts) VALUES (:v, :c, :s, :u)';
    d.run(ins, { v: '0xa', c: 'hold', s: 1, u: 10 });
    d.run(ins, { v: '0xa', c: 'arming', s: 10, u: null });
    expect(() => d.run(ins, { v: '0xa', c: 'cooldown', s: 20, u: null })).toThrow(/UNIQUE/);
    d.run(ins, { v: '0xb', c: 'hold', s: 20, u: null });
    expect(d.all('SELECT id FROM episodes WHERE until_ts IS NULL')).toHaveLength(2);
    d.close();
  });

  it('fails fast when the DB_PATH directory is not writable', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root writes anywhere
    const ro = tmp();
    chmodSync(ro, 0o500);
    expect(() => openDb(join(ro, 'sub', 'gamma.db'))).toThrow(/^DB_PATH directory not writable \(uid \d+\)/);
    expect(existsSync(join(ro, 'sub'))).toBe(false);
  });

  it('creates the directory when missing', () => {
    const base = tmp();
    const d = openDb(join(base, 'deep', 'er', 'gamma.db'));
    expect(existsSync(join(base, 'deep', 'er', 'gamma.db'))).toBe(true);
    d.close();
  });

  it('facade opens the process db lazily at DB_PATH', () => {
    const path = join(tmp(), 'gamma.db');
    setConfig(loadConfig({ RPC_URL: 'https://rpc.example.test', DB_PATH: path }));
    setDb(null);
    db.metaSet('via', 'facade');
    expect(getDb()).toBeInstanceOf(Db);
    expect(getDb().path).toBe(path);
    expect(db.metaGet('via')).toBe('facade');
  });
});
