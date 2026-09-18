import { MonitorStatus, type MonitorStatus as MonitorStatusT, type MonitorFiring, type MonitorSnapshot } from '../contract/types';
import type { Db } from '../db/index';
import { appendEvent, describeError, fetchJson, flipSource, isoToTs, Loop, nowSec, SchemaError, tick } from './util';

// monitor collector: poll /status, turn firing + pools[].firing into findings rows with
// the monitor's own onset, close what stopped firing, cache the gauges. when
// the monitor goes silent its findings are flagged stale, never blanked.

export interface MonitorCollectorOpts {
  db: Db;
  baseUrl: string | null;
  pollMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  missesToUnreachable?: number;
}

export interface MonitorVaultCache {
  snapshot: MonitorSnapshot | null;
  thresholds: Record<string, unknown>;
  firing: MonitorFiring[];
  label: string;
}

export interface MonitorCollectorState {
  configured: boolean;
  reachable: boolean;
  consecutiveFailures: number;
  lastOkAt: number | null;
  unreachableSince: number | null;
  detail: string | null;
  // monitor's own flag (lastCycleAt older than 3× its interval)
  stale: boolean;
  // findings are stale: the monitor itself says so, or we have not heard from it for 2 polls
  findingsStale: boolean;
  status: MonitorStatusT | null;
  statusAt: number | null;
  vaults: Record<string, MonitorVaultCache>;
}

type FindingRow = {
  id: number;
  vault_id: string | null;
  key: string;
  severity: string;
}

// gas is one signer, so the monitor's gas family is a global finding whichever pool reported it
const GLOBAL_KEY_RE = /^gas(-|$)/;

export class MonitorCollector {
  private readonly db: Db;
  private readonly baseUrl: string | null;
  private readonly pollMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly misses: number;
  private loop: Loop | null = null;

  private reachable = false;
  private everPolled = false;
  private failures = 0;
  private lastOkAt: number | null = null;
  private unreachableSince: number | null = null;
  private detail: string | null = null;
  private status: MonitorStatusT | null = null;
  private statusAt: number | null = null;
  private readonly vaults = new Map<string, MonitorVaultCache>();

  constructor(o: MonitorCollectorOpts) {
    this.db = o.db;
    this.baseUrl = o.baseUrl ? o.baseUrl.replace(/\/+$/, '') : null;
    this.pollMs = o.pollMs ?? 60_000;
    this.fetchImpl = o.fetch ?? fetch;
    this.now = o.now ?? nowSec;
    this.timeoutMs = o.timeoutMs ?? 5000;
    this.misses = o.missesToUnreachable ?? 3;
  }

  get configured(): boolean {
    return this.baseUrl !== null;
  }

  start(): void {
    if (!this.baseUrl) return;
    this.loop = new Loop('collect/monitor', this.pollMs, () => this.pollOnce());
    this.loop.start();
  }

  stop(): void {
    this.loop?.stop();
  }

  state(): MonitorCollectorState {
    const vaults: Record<string, MonitorVaultCache> = {};
    for (const [k, v] of this.vaults) vaults[k] = v;
    const now = this.now();
    const silent = this.lastOkAt === null || now - this.lastOkAt > 2 * (this.pollMs / 1000);
    return {
      configured: this.configured,
      reachable: this.reachable,
      consecutiveFailures: this.failures,
      lastOkAt: this.lastOkAt,
      unreachableSince: this.unreachableSince,
      detail: this.detail,
      stale: this.status?.stale ?? false,
      findingsStale: this.configured && (silent || (this.status?.stale ?? false)),
      status: this.status,
      statusAt: this.statusAt,
      vaults,
    };
  }

  vault(id: string): MonitorVaultCache | null {
    return this.vaults.get(id) ?? null;
  }

  async pollOnce(): Promise<void> {
    if (!this.baseUrl) return;
    let body: unknown;
    try {
      body = await fetchJson(this.fetchImpl, `${this.baseUrl}/status`, { timeoutMs: this.timeoutMs });
    } catch (e) {
      this.miss(describeError(e));
      return;
    }
    const p = MonitorStatus.safeParse(body);
    if (!p.success) {
      this.miss(describeError(new SchemaError(p.error.issues.slice(0, 5).map((i) => i.path.join('.')))));
      return;
    }
    const at = this.now();
    this.hit(at);
    this.ingest(p.data, at);
    tick('monitor', true, at);
  }

  ingest(st: MonitorStatusT, at: number): void {
    this.status = st;
    this.statusAt = at;
    this.db.transaction(() => {
      const seenGlobal = new Set<string>();
      for (const f of st.firing) {
        if (seenGlobal.has(f.key)) continue;
        seenGlobal.add(f.key);
        this.upsertFinding(null, f, at);
      }
      for (const pool of st.pools) {
        this.vaults.set(pool.id, { snapshot: pool.snapshot, thresholds: pool.thresholds, firing: pool.firing, label: pool.label });
        const localKeys = new Set<string>();
        for (const f of pool.firing) {
          const global = GLOBAL_KEY_RE.test(f.key);
          if (global) {
            if (seenGlobal.has(f.key)) continue;
            seenGlobal.add(f.key);
          } else localKeys.add(f.key);
          this.upsertFinding(global ? null : pool.id, f, at);
        }
        this.clearMissing(pool.id, localKeys, at);
      }
      this.clearMissing(null, seenGlobal, at);
    });
  }

  private upsertFinding(vault: string | null, f: MonitorFiring, at: number): void {
    const open = this.db.get<FindingRow>(
      `SELECT id, vault_id, key, severity FROM findings WHERE source = 'monitor' AND key = :key AND cleared_ts IS NULL AND ${vault === null ? 'vault_id IS NULL' : 'vault_id = :v'}`,
      vault === null ? { key: f.key } : { key: f.key, v: vault },
    );
    const onset = isoToTs(f.onsetAt) ?? at;
    if (open) {
      this.db.run('UPDATE findings SET severity = :sev, title = :title, detail = :detail, last_seen_ts = :at, onset_ts = MIN(onset_ts, :onset) WHERE id = :id', {
        sev: f.severity,
        title: f.title,
        detail: f.detail,
        at,
        onset,
        id: open.id,
      });
      if (open.severity !== f.severity) appendEvent(this.db, 'finding', vault, String(open.id), { key: f.key, event: 'severity', from: open.severity, to: f.severity }, at);
      return;
    }
    const r = this.db.run(
      `INSERT INTO findings (vault_id, source, key, severity, title, detail, onset_ts, last_seen_ts, cleared_ts)
       VALUES (:v, 'monitor', :key, :sev, :title, :detail, :onset, :at, NULL)`,
      { v: vault, key: f.key, sev: f.severity, title: f.title, detail: f.detail, onset, at },
    );
    appendEvent(this.db, 'finding', vault, String(r.lastInsertRowid), { key: f.key, event: 'onset', severity: f.severity, title: f.title, onsetTs: onset }, at);
  }

  private clearMissing(vault: string | null, stillFiring: Set<string>, at: number): void {
    const open = this.db.all<FindingRow>(
      `SELECT id, vault_id, key, severity FROM findings WHERE source = 'monitor' AND cleared_ts IS NULL AND ${vault === null ? 'vault_id IS NULL' : 'vault_id = :v'}`,
      vault === null ? undefined : { v: vault },
    );
    for (const row of open) {
      if (stillFiring.has(row.key)) continue;
      this.db.run('UPDATE findings SET cleared_ts = :at WHERE id = :id', { at, id: row.id });
      appendEvent(this.db, 'finding', vault, String(row.id), { key: row.key, event: 'cleared', severity: row.severity }, at);
    }
  }

  private hit(at: number): void {
    this.failures = 0;
    this.lastOkAt = at;
    this.detail = null;
    this.everPolled = true;
    if (!this.reachable) {
      this.reachable = true;
      this.unreachableSince = null;
      flipSource(this.db, 'monitor', true, null, at);
    }
  }

  private miss(detail: string): void {
    const at = this.now();
    this.failures++;
    this.detail = detail;
    tick('monitor', false, at);
    if (this.failures >= this.misses && (this.reachable || !this.everPolled)) {
      this.reachable = false;
      this.everPolled = true;
      this.unreachableSince = this.unreachableSince ?? at;
      flipSource(this.db, 'monitor', false, detail, at);
    }
  }
}
