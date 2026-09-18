import { EventEmitter } from 'node:events';
import type { Db } from '../db/index';
import type { UiConfig } from '../config';
import type { Backfill, Head, KeeperConfig, KeeperStatus, MonitorStatus } from '../contract/types';
import type { ConfigSource, StreamEvent } from '../contract/enums';

// the contract between the collectors (collect/*, db jobs) and everything that
// reads their output: a registry for /healthz, an in-memory `live` snapshot the
// serialiser reads first, the meta keys the same state is mirrored under so a
// second module instance (the ssr bundle) can still answer, and the one writer
// for events_log that the sse stream fans out.

export interface Collector {
  readonly name: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  // ms epoch of the last successful tick; null before the first
  lastTickAt(): number | null;
}

export interface CollectorDeps {
  db: Db;
  cfg: UiConfig;
  live: LiveState;
}

// every module under collect/ and the db jobs export `start(deps)`; index.ts
// imports them by name and skips the ones that do not exist yet
export interface CollectorModule {
  start(deps: CollectorDeps): Collector | Promise<Collector>;
}
export const COLLECTOR_MODULES = ['descriptor', 'keeper', 'monitor', 'chain', 'events'] as const;
export const JOB_MODULES = ['retention', 'rollup', 'backup'] as const;

const registry = new Map<string, Collector>();

export function registerCollector(c: Collector): Collector {
  registry.set(c.name, c);
  return c;
}

export function unregisterCollector(name: string): void {
  registry.delete(name);
}

export function collectors(): Collector[] {
  return [...registry.values()];
}

export function resetCollectors(): void {
  registry.clear();
}

export function collectorHealth(nowMs: number, windowMs = 300_000): Record<string, { lastTickAt: string | null; ok: boolean }> {
  const out: Record<string, { lastTickAt: string | null; ok: boolean }> = {};
  for (const c of registry.values()) {
    const t = c.lastTickAt();
    out[c.name] = { lastTickAt: t === null ? null : new Date(t).toISOString(), ok: t !== null && nowMs - t <= windowMs };
  }
  return out;
}

export function anyCollectorTicked(nowMs: number, windowMs = 300_000): boolean {
  return Object.values(collectorHealth(nowMs, windowMs)).some((h) => h.ok);
}

// a timer-driven collector with a never-throw tick, for collectors and jobs alike
export function intervalCollector(name: string, everyMs: number, tick: () => void | Promise<void>): Collector {
  let timer: NodeJS.Timeout | null = null;
  let last: number | null = null;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick();
      last = Date.now();
    } catch (e) {
      console.warn(`[collect:${name}] tick failed: ${(e as Error)?.message ?? e}`);
    } finally {
      running = false;
    }
  };
  return {
    name,
    start() {
      void run();
      timer = setInterval(() => void run(), everyMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    lastTickAt: () => last,
  };
}

// --- live state -------------------------------------------------------------

export interface KeeperLive {
  status: KeeperStatus | null;
  fetchedAtMs: number | null;
  reachable: boolean;
  // consecutive fetch failures; 3 = unreachable
  misses: number;
  unreachableSinceMs: number | null;
  config: KeeperConfig | null;
  configFetchedAtMs: number | null;
  configSource: ConfigSource;
  // fingerprint seen earlier in the same boot; differs from status.configFingerprint on drift
  previousFingerprint: string | null;
}

export interface MonitorLive {
  status: MonitorStatus | null;
  fetchedAtMs: number | null;
  reachable: boolean;
  misses: number;
  unreachableSinceMs: number | null;
}

export interface ChainLive {
  ok: boolean;
  head: Head | null;
  fallbackHead: Head | null;
  backfill: Backfill | null;
  lastSampleAtMs: number | null;
  detail: string | null;
}

export interface LiveState {
  keeper: KeeperLive;
  monitor: MonitorLive;
  chain: ChainLive;
}

export function emptyLive(): LiveState {
  return {
    keeper: {
      status: null,
      fetchedAtMs: null,
      reachable: false,
      misses: 0,
      unreachableSinceMs: null,
      config: null,
      configFetchedAtMs: null,
      configSource: 'none',
      previousFingerprint: null,
    },
    monitor: { status: null, fetchedAtMs: null, reachable: false, misses: 0, unreachableSinceMs: null },
    chain: { ok: false, head: null, fallbackHead: null, backfill: null, lastSampleAtMs: null, detail: null },
  };
}

export const live: LiveState = emptyLive();

export function resetLive(): void {
  Object.assign(live, emptyLive());
}

// meta keys the collectors mirror `live` under, so a reader without the
// in-memory copy (ssr bundle, tests) sees the last known state
export const META = {
  keeperStatus: 'keeper:status',
  keeperStatusAt: 'keeper:status_at',
  keeperConfig: 'keeper:config',
  keeperConfigAt: 'keeper:config_at',
  monitorStatus: 'monitor:status',
  monitorStatusAt: 'monitor:status_at',
  chainHeads: 'chain:heads',
  descriptorSha256: 'descriptor_sha256',
  lastBackupAt: 'last_backup_at',
  backfill: (vault: string) => `backfill:${vault}`,
  keeperCursor: (vault: string) => `keeper:cursor:${vault}`,
} as const;

// --- events_log --------------------------------------------------------------

export interface PublishedEvent {
  kind: StreamEvent | 'deposit' | 'withdraw' | 'zero-burn' | 'config';
  vault: string | null;
  ref?: string | null;
  payload: unknown;
  // unix seconds; defaults to now
  ts?: number;
}

// wakes the sse stream on every insert; listeners never block the writer
export const eventsWake = new EventEmitter();
eventsWake.setMaxListeners(0);

export function publishEvent(db: Db, e: PublishedEvent): number {
  const r = db.run('INSERT INTO events_log (ts, vault_id, kind, ref_id, payload_json) VALUES (:ts, :v, :k, :r, :p)', {
    ts: e.ts ?? Math.floor(Date.now() / 1000),
    v: e.vault,
    k: e.kind,
    r: e.ref ?? null,
    p: JSON.stringify(e.payload ?? {}),
  });
  eventsWake.emit('event', r.lastInsertRowid);
  return r.lastInsertRowid;
}
