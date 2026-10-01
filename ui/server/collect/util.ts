import { EventEmitter } from 'node:events';
import type { Db } from '../db/index';
import type { EventKind, StreamEvent } from '../contract/enums';

// shared plumbing for the collectors: clock, logging, error vocabulary, the
// in-process event bus the sse route subscribes to, and collector health.

export const nowSec = (): number => Math.trunc(Date.now() / 1000);
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));
export const isoToTs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.trunc(t / 1000) : null;
};
export const bit = (v: boolean | null | undefined): number | null => (v === null || v === undefined ? null : v ? 1 : 0);

export function log(tag: string, msg: string): void {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`http ${status}`);
  }
}
export class SchemaError extends Error {
  constructor(readonly paths: string[]) {
    super(`schema mismatch: ${paths.join(', ') || '?'}`);
  }
}
export class TimeoutError extends Error {
  readonly code = 'TIMEOUT';
  constructor() {
    super('timeout');
  }
}

function prop(e: unknown, k: string): unknown {
  return e !== null && typeof e === 'object' ? (e as Record<string, unknown>)[k] : undefined;
}

// upstream error -> fixed vocabulary. the raw message may embed the url
// (ethers SERVER_ERROR does), so it never reaches the db or a response
export function describeError(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  if (e instanceof SchemaError) return e.message;
  if (e instanceof TimeoutError) return 'timeout';
  if (e instanceof SyntaxError) return 'bad json';
  const code = String(prop(e, 'code') ?? prop(prop(e, 'cause'), 'code') ?? '');
  const name = String(prop(e, 'name') ?? '');
  const msg = String(prop(e, 'message') ?? '');
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns failure';
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') return 'connection reset';
  if (code.startsWith('UND_ERR_') && code.includes('TIMEOUT')) return 'timeout';
  if (name === 'TimeoutError' || name === 'AbortError' || /timeout|timed out/i.test(msg)) return 'timeout';
  if (code === 'SERVER_ERROR' || code === 'NETWORK_ERROR') return 'rpc error';
  if (code === 'CALL_EXCEPTION') return 'call reverted';
  if (/fetch failed/i.test(msg)) return 'fetch failed';
  return 'error';
}

export interface FetchOpts {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export async function fetchJson(fetchImpl: typeof fetch, url: string, o: FetchOpts = {}): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: { accept: 'application/json', ...(o.headers ?? {}) },
    signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
  });
  if (!res.ok) throw new HttpError(res.status);
  return res.json();
}

export async function fetchText(fetchImpl: typeof fetch, url: string, o: FetchOpts = {}): Promise<string> {
  const res = await fetchImpl(url, {
    headers: { accept: 'text/plain', ...(o.headers ?? {}) },
    signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
  });
  if (!res.ok) throw new HttpError(res.status);
  return res.text();
}

// bare json-rpc for eth_blockNumber-class calls where an ethers provider is overkill
export async function rpcCall(fetchImpl: typeof fetch, url: string, method: string, params: unknown[] = [], timeoutMs = 5000): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new HttpError(res.status);
  const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } };
  if (body.error) {
    const err = new Error('rpc error') as Error & { code: string; rpcCode?: number };
    err.code = 'SERVER_ERROR';
    err.rpcCode = body.error.code;
    throw err;
  }
  return body.result;
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError()), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// --- event bus -------------------------------------------------------------

export interface CollectEvent {
  kind: StreamEvent;
  vault: string | null;
  ts: number;
  // events_log rowid when persisted, null for live-only frames
  id: number | null;
  payload: Record<string, unknown>;
}

export const bus = new EventEmitter();
bus.setMaxListeners(64);

export function emitLive(kind: StreamEvent, vault: string | null, payload: Record<string, unknown>, ts = nowSec()): void {
  bus.emit('event', { kind, vault, ts, id: null, payload } satisfies CollectEvent);
}

const STREAM_KIND: Record<EventKind, StreamEvent> = {
  cycle: 'cycle',
  regime: 'regime',
  standing: 'standing',
  finding: 'finding',
  tx: 'tx',
  deposit: 'tx',
  withdraw: 'tx',
  'zero-burn': 'tx',
  config: 'status',
  source: 'source',
};

// durable timeline row (events_log, sse replay) + live frame
export function appendEvent(db: Db, kind: EventKind, vault: string | null, refId: string | null, payload: Record<string, unknown>, ts = nowSec()): number {
  const r = db.run('INSERT INTO events_log (ts, vault_id, kind, ref_id, payload_json) VALUES (:ts, :vault, :kind, :ref, :payload)', {
    ts,
    vault,
    kind,
    ref: refId,
    payload: JSON.stringify(payload),
  });
  bus.emit('event', { kind: STREAM_KIND[kind], vault, ts, id: r.lastInsertRowid, payload: { ...payload, event: kind } } satisfies CollectEvent);
  return r.lastInsertRowid;
}

// --- source health ------------------------------------------------------------

export type SourceName = 'keeper' | 'monitor' | 'rpc' | 'rpc-fallback';

// one row per reachability flip; the open row (until_ts null) is the current state
export function flipSource(db: Db, source: SourceName, reachable: boolean, detail: string | null, ts = nowSec()): boolean {
  const open = db.get<{ id: number; reachable: number }>(
    'SELECT id, reachable FROM source_health WHERE source = :s AND until_ts IS NULL ORDER BY id DESC LIMIT 1',
    { s: source },
  );
  if (open && (open.reachable === 1) === reachable) return false;
  db.transaction(() => {
    if (open) db.run('UPDATE source_health SET until_ts = :ts WHERE id = :id', { ts, id: open.id });
    db.run('INSERT INTO source_health (source, since_ts, until_ts, reachable, detail) VALUES (:s, :ts, NULL, :r, :d)', {
      s: source,
      ts,
      r: reachable ? 1 : 0,
      d: detail,
    });
    appendEvent(db, 'source', null, source, { source, reachable, detail }, ts);
  });
  return true;
}

// --- collector health (for /healthz) --------------------------------------------

export interface CollectorHealth {
  lastTickAt: number | null;
  ok: boolean;
}
const health = new Map<string, CollectorHealth>();

export function tick(name: string, ok: boolean, at = nowSec()): void {
  health.set(name, { lastTickAt: at, ok });
}

export function collectorHealth(): Record<string, { lastTickAt: string | null; ok: boolean }> {
  const out: Record<string, { lastTickAt: string | null; ok: boolean }> = {};
  for (const [k, v] of health) out[k] = { lastTickAt: v.lastTickAt === null ? null : new Date(v.lastTickAt * 1000).toISOString(), ok: v.ok };
  return out;
}

export function anyTickWithin(secs: number, now = nowSec()): boolean {
  for (const v of health.values()) if (v.lastTickAt !== null && now - v.lastTickAt <= secs) return true;
  return false;
}

// a setTimeout chain that never overlaps itself and survives a throwing body
export class Loop {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;
  constructor(
    private readonly name: string,
    private readonly everyMs: number,
    private readonly body: () => Promise<void>,
  ) {}

  start(delayMs = 0): void {
    this.stopped = false;
    this.schedule(delayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get busy(): boolean {
    return this.running;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.run(), ms);
    this.timer.unref?.();
  }

  private async run(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    const started = Date.now();
    try {
      await this.body();
    } catch (e) {
      log(this.name, `tick failed: ${describeError(e)}`);
    } finally {
      this.running = false;
      this.schedule(Math.max(250, this.everyMs - (Date.now() - started)));
    }
  }
}
