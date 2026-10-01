import { z } from 'zod';
import { CycleRecord, KeeperConfig, KeeperStatus, type KeeperStatus as KeeperStatusT, type KeeperConfig as KeeperConfigT } from '../contract/types';
import { sameStanding, standingOf, type StandingKey } from '@keeper/record';
import type { Db } from '../db/index';
import { appendEvent, bit, describeError, emitLive, fetchJson, fetchText, flipSource, HttpError, isoToTs, log, Loop, nowSec, SchemaError, sleep, tick } from './util';

// keeper collector: sse on /events (manual parse, json payloads) + /status
// poll + /cycles?since=seq catch-up. cursor per vault is (bootAt, seq) in meta;
// seq restarts at 1 on every keeper boot, so a bootAt change resets every
// cursor to 0, reopens the stream without Last-Event-ID and fires the
// state-lost hook. KEEPER_URL never reaches a row or a log line.

export interface KeeperCursor {
  bootAt: string;
  seq: number;
}

export interface StateLost {
  prevBootAt: string | null;
  bootAt: string;
  at: number;
}

export interface KeeperCollectorOpts {
  db: Db;
  // KEEPER_URL; null = not configured
  baseUrl: string | null;
  pollMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  onStateLost?: (info: StateLost) => void;
  // pull /vaults/:id/log on every poll (default true)
  logLines?: boolean;
  timeoutMs?: number;
  // consecutive misses before the source flips to unreachable (plan: 3)
  missesToUnreachable?: number;
}

export interface KeeperCollectorState {
  configured: boolean;
  reachable: boolean;
  consecutiveFailures: number;
  lastOkAt: number | null;
  unreachableSince: number | null;
  detail: string | null;
  bootAt: string | null;
  status: KeeperStatusT | null;
  statusAt: number | null;
  config: KeeperConfigT | null;
  configAt: number | null;
  sse: { connected: boolean; lastFrameAt: number | null; reconnects: number };
  cursors: Record<string, KeeperCursor>;
}

export interface SseFrame {
  id: string | null;
  event: string | null;
  data: string;
}

// incremental text/event-stream parser: frames end on a blank line, `data:`
// lines join with \n, comments (`: ping`) and `retry:` are dropped
export class SseParser {
  private buf = '';

  push(chunk: string): SseFrame[] {
    this.buf += chunk.replace(/\r\n?/g, '\n');
    const out: SseFrame[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const f = parseBlock(block);
      if (f) out.push(f);
    }
    return out;
  }

  // whatever is left when the stream closes without a trailing blank line
  flush(): SseFrame[] {
    const rest = this.buf;
    this.buf = '';
    const f = rest.trim() ? parseBlock(rest) : null;
    return f ? [f] : [];
  }
}

function parseBlock(block: string): SseFrame | null {
  let id: string | null = null;
  let event: string | null = null;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const c = line.indexOf(':');
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? '' : line.slice(c + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  return { id, event, data: data.join('\n') };
}

export function parseSse(text: string): SseFrame[] {
  const p = new SseParser();
  return [...p.push(text), ...p.flush()];
}

// `<bootAt>:<seq>` — bootAt is iso and contains ':' itself, so split on the last one
export function splitEventId(id: string): { bootAt: string; seq: number } | null {
  const c = id.lastIndexOf(':');
  if (c <= 0) return null;
  const seq = Number(id.slice(c + 1));
  if (!Number.isInteger(seq) || seq < 0) return null;
  return { bootAt: id.slice(0, c), seq };
}

// the log ring is a sliding window over one stream: the previous ring's tail
// reappears contiguously somewhere in the new ring; everything after it is new
export function newLines(prev: string[], next: string[]): string[] {
  if (prev.length === 0) return next;
  const last = prev[prev.length - 1];
  for (let p = next.length - 1; p >= 0; p--) {
    if (next[p] !== last) continue;
    const m = Math.min(p + 1, prev.length);
    let ok = true;
    for (let k = 1; k <= m; k++) {
      if (next[p - k + 1] !== prev[prev.length - k]) {
        ok = false;
        break;
      }
    }
    if (ok) return next.slice(p + 1);
  }
  return next;
}

// `[2026-09-18T03:07:12.345Z] msg` -> ts + msg; bare lines keep the receive time
const TS_PREFIX_RE = /^\[(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\]\s?/;
export function splitLineTs(line: string, fallbackTs: number): { ts: number; line: string } {
  const m = TS_PREFIX_RE.exec(line);
  if (!m) return { ts: fallbackTs, line };
  return { ts: isoToTs(m[1]) ?? fallbackTs, line: line.slice(m[0].length) };
}

// --- cycles projection -----------------------------------------------------------

export const HEARTBEAT_SECS = 300;

type CycleRow = {
  vault_id: string;
  boot_at: string;
  seq: number;
  block: number;
  block_ts: number;
  evaluated_at: number | null;
  outcome_code: string;
  stage: string;
  winner: string;
  spot_tick: number | null;
  base_lower: number | null;
  base_upper: number | null;
  limit_lower: number | null;
  limit_upper: number | null;
  drift_ticks: number | null;
  armed_mask: number;
  dwell_reb_secs: number;
  dwell_ref_secs: number;
  dwell_fold_secs: number;
  cooldown_remaining_secs: number | null;
  gate_ok: number | null;
  gate_failed_at: string | null;
  gate_via: string | null;
  twap_tick: number | null;
  twap_dev: number | null;
  oracle_tick: number | null;
  oracle_dev: number | null;
  oracle_age: number | null;
  regime: string | null;
  compound_result: string | null;
  tx_hash: string | null;
  error: string | null;
  source: string;
}

export function armedMask(rec: CycleRecord): number {
  return (rec.dwell.rebalance.armed ? 1 : 0) | (rec.dwell.refresh.armed ? 2 : 0) | (rec.dwell.fold.armed ? 4 : 0);
}

export function compoundResult(rec: CycleRecord): string | null {
  const c = rec.compound;
  if (!c) return null;
  if (c.landed) return 'landed';
  if (c.submitted) return 'submitted';
  return c.allowed ? 'allowed' : 'skipped';
}

export function cycleRow(rec: CycleRecord): CycleRow {
  const cd = rec.cooldown;
  return {
    vault_id: rec.vault.id,
    boot_at: rec.bootAt,
    seq: rec.seq,
    block: rec.block,
    block_ts: rec.blockTs,
    evaluated_at: isoToTs(rec.evaluatedAt),
    outcome_code: rec.outcome.code,
    stage: rec.outcome.stage,
    winner: rec.winner ?? 'hold',
    spot_tick: rec.reads?.spotTick ?? null,
    base_lower: rec.reads?.base[0] ?? null,
    base_upper: rec.reads?.base[1] ?? null,
    limit_lower: rec.reads?.limit?.[0] ?? null,
    limit_upper: rec.reads?.limit?.[1] ?? null,
    drift_ticks: rec.triggers?.rebalance.drift ?? null,
    armed_mask: armedMask(rec),
    dwell_reb_secs: rec.dwell.rebalance.heldSecs,
    dwell_ref_secs: rec.dwell.refresh.heldSecs,
    dwell_fold_secs: rec.dwell.fold.heldSecs,
    cooldown_remaining_secs:
      cd && cd.elapsedSecs !== null && cd.minIntervalSecs !== null ? Math.max(0, cd.minIntervalSecs - cd.elapsedSecs) : null,
    gate_ok: rec.gate ? bit(rec.gate.ok) : null,
    gate_failed_at: rec.gate?.failedAt ?? null,
    gate_via: rec.gate?.via ?? null,
    twap_tick: rec.gate?.twap?.tick ?? null,
    twap_dev: rec.gate?.twap?.devTicks ?? null,
    oracle_tick: rec.gate?.oracle?.tick ?? null,
    oracle_dev: rec.gate?.oracle?.devTicks ?? null,
    oracle_age: rec.gate?.oracle?.ageSecs ?? null,
    regime: rec.regime?.regime ?? null,
    compound_result: compoundResult(rec),
    tx_hash: rec.tx?.hash ?? rec.compound?.submitted ?? null,
    error: rec.outcome.code === 'error' ? rec.outcome.detail : null,
    source: rec.source,
  };
}

// numbers vary per block inside an error text; compare its shape only
const shapeOf = (s: string | null): string | null => (s === null ? null : s.replace(/0x[0-9a-fA-F]+|\d+/g, '#'));

export function isTransition(prev: CycleRow | null, cur: CycleRow): boolean {
  if (!prev) return true;
  return (
    prev.outcome_code !== cur.outcome_code ||
    prev.winner !== cur.winner ||
    prev.armed_mask !== cur.armed_mask ||
    prev.gate_ok !== cur.gate_ok ||
    prev.gate_failed_at !== cur.gate_failed_at ||
    prev.regime !== cur.regime ||
    prev.compound_result !== cur.compound_result ||
    prev.tx_hash !== cur.tx_hash ||
    shapeOf(prev.error) !== shapeOf(cur.error)
  );
}

const INSERT_CYCLE = `INSERT INTO cycles (vault_id, boot_at, seq, block, block_ts, evaluated_at, outcome_code, stage, winner, spot_tick,
  base_lower, base_upper, limit_lower, limit_upper, drift_ticks, armed_mask, dwell_reb_secs, dwell_ref_secs, dwell_fold_secs,
  cooldown_remaining_secs, gate_ok, gate_failed_at, gate_via, twap_tick, twap_dev, oracle_tick, oracle_dev, oracle_age, regime,
  compound_result, tx_hash, error, source, is_transition, record_json)
VALUES (:vault_id, :boot_at, :seq, :block, :block_ts, :evaluated_at, :outcome_code, :stage, :winner, :spot_tick,
  :base_lower, :base_upper, :limit_lower, :limit_upper, :drift_ticks, :armed_mask, :dwell_reb_secs, :dwell_ref_secs, :dwell_fold_secs,
  :cooldown_remaining_secs, :gate_ok, :gate_failed_at, :gate_via, :twap_tick, :twap_dev, :oracle_tick, :oracle_dev, :oracle_age, :regime,
  :compound_result, :tx_hash, :error, :source, :is_transition, :record_json)`;

// tolerant reading of the keeper's /cycles body: items | records | cycles | bare array
const CyclesBody = z.union([
  z.array(z.unknown()),
  z.object({ items: z.array(z.unknown()) }).transform((o) => o.items),
  z.object({ records: z.array(z.unknown()) }).transform((o) => o.records),
  z.object({ cycles: z.array(z.unknown()) }).transform((o) => o.cycles),
]);

type EpisodeRow = {
  id: number;
  code: string;
  subcode: string | null;
  since_ts: number;
}

export interface IngestResult {
  inserted: boolean;
  stored: boolean;
  transition: boolean;
  reason: 'ok' | 'duplicate' | 'old-boot' | 'invalid';
}

export class KeeperCollector {
  private readonly db: Db;
  private readonly baseUrl: string | null;
  private readonly pollMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly onStateLost: ((i: StateLost) => void) | null;
  private readonly logLines: boolean;
  private readonly timeoutMs: number;
  private readonly misses: number;

  private poll: Loop | null = null;
  private sseAbort: AbortController | null = null;
  private sseStopped = true;
  private sseTask: Promise<void> | null = null;

  private bootAt: string | null;
  private status: KeeperStatusT | null = null;
  private statusAt: number | null = null;
  private config: KeeperConfigT | null;
  private configAt: number | null;
  private fingerprint: string | null;
  private reachable = false;
  private everPolled = false;
  private failures = 0;
  private lastOkAt: number | null = null;
  private unreachableSince: number | null = null;
  private detail: string | null = null;
  private sseConnected = false;
  private sseLastFrameAt: number | null = null;
  private sseReconnects = 0;

  private readonly cursors = new Map<string, KeeperCursor>();
  private readonly lastRow = new Map<string, CycleRow>();
  private readonly lastStoredTs = new Map<string, number>();
  private readonly lastRegime = new Map<string, string>();
  private readonly lastLines = new Map<string, string[]>();
  private readonly seenVaults = new Set<string>();

  constructor(o: KeeperCollectorOpts) {
    this.db = o.db;
    this.baseUrl = o.baseUrl ? o.baseUrl.replace(/\/+$/, '') : null;
    this.pollMs = o.pollMs ?? 5000;
    this.fetchImpl = o.fetch ?? fetch;
    this.now = o.now ?? nowSec;
    this.onStateLost = o.onStateLost ?? null;
    this.logLines = o.logLines ?? true;
    this.timeoutMs = o.timeoutMs ?? 4000;
    this.misses = o.missesToUnreachable ?? 3;

    this.bootAt = this.db.metaGet('keeper:boot_at');
    this.config = this.db.metaGetJson<KeeperConfigT>('keeper:config');
    this.configAt = Number(this.db.metaGet('keeper:config_at') ?? '') || null;
    this.fingerprint = this.db.metaGet('keeper:fingerprint');
    for (const row of this.db.all<{ k: string; v: string }>("SELECT k, v FROM meta WHERE k LIKE 'keeper:cursor:%'")) {
      try {
        const c = JSON.parse(row.v) as KeeperCursor;
        const vault = row.k.slice('keeper:cursor:'.length);
        this.cursors.set(vault, c);
        this.seenVaults.add(vault);
      } catch {
        // a broken cursor just means a full re-read of the ring
      }
    }
    for (const vault of this.seenVaults) this.warmVault(vault);
  }

  // last projected row per vault so the transition rule survives a ui restart
  private warmVault(vault: string): void {
    if (this.lastRow.has(vault)) return;
    const raw = this.db.get<{ record_json: string }>('SELECT record_json FROM cycles_raw WHERE vault_id = :v ORDER BY id DESC LIMIT 1', { v: vault });
    const stored = this.db.get<{ block_ts: number; record_json: string }>('SELECT block_ts, record_json FROM cycles WHERE vault_id = :v ORDER BY id DESC LIMIT 1', {
      v: vault,
    });
    const src = raw?.record_json ?? stored?.record_json;
    if (src) {
      const p = CycleRecord.safeParse(JSON.parse(src));
      if (p.success) {
        this.lastRow.set(vault, cycleRow(p.data));
        if (p.data.regime) this.lastRegime.set(vault, p.data.regime.regime);
      }
    }
    if (stored) this.lastStoredTs.set(vault, stored.block_ts);
  }

  get configured(): boolean {
    return this.baseUrl !== null;
  }

  start(): void {
    if (!this.baseUrl) return;
    this.poll = new Loop('collect/keeper', this.pollMs, () => this.pollOnce());
    this.poll.start();
    this.sseStopped = false;
    this.sseTask = this.sseLoop();
  }

  async stop(): Promise<void> {
    this.poll?.stop();
    this.sseStopped = true;
    this.sseAbort?.abort();
    await this.sseTask?.catch(() => undefined);
  }

  state(): KeeperCollectorState {
    const cursors: Record<string, KeeperCursor> = {};
    for (const [k, v] of this.cursors) cursors[k] = { ...v };
    return {
      configured: this.configured,
      reachable: this.reachable,
      consecutiveFailures: this.failures,
      lastOkAt: this.lastOkAt,
      unreachableSince: this.unreachableSince,
      detail: this.detail,
      bootAt: this.bootAt,
      status: this.status,
      statusAt: this.statusAt,
      config: this.config,
      configAt: this.configAt,
      sse: { connected: this.sseConnected, lastFrameAt: this.sseLastFrameAt, reconnects: this.sseReconnects },
      cursors,
    };
  }

  cursor(vault: string): KeeperCursor | null {
    return this.cursors.get(vault) ?? null;
  }

  // `Last-Event-ID` for a reconnect: the lowest seq any vault still needs, or null after a boot reset
  lastEventId(): string | null {
    if (!this.bootAt) return null;
    let min: number | null = null;
    for (const c of this.cursors.values()) {
      if (c.bootAt !== this.bootAt) continue;
      min = min === null ? c.seq : Math.min(min, c.seq);
    }
    return min === null || min === 0 ? null : `${this.bootAt}:${min}`;
  }

  // --- /status -----------------------------------------------------------------

  async pollOnce(): Promise<void> {
    if (!this.baseUrl) return;
    let body: unknown;
    try {
      body = await fetchJson(this.fetchImpl, `${this.baseUrl}/status`, { timeoutMs: this.timeoutMs });
    } catch (e) {
      this.miss(describeError(e));
      return;
    }
    const parsed = KeeperStatus.safeParse(body);
    if (!parsed.success) {
      this.miss(describeError(new SchemaError(parsed.error.issues.slice(0, 5).map((i) => i.path.join('.')))));
      return;
    }
    const at = this.now();
    this.hit(at);
    const st = parsed.data;
    this.ingestStatus(st, at);
    for (const v of st.vaults) {
      const cur = this.cursors.get(v.id) ?? { bootAt: st.keeper.bootAt, seq: 0 };
      if (v.last && v.last.bootAt === st.keeper.bootAt && v.last.seq > cur.seq) {
        const caught = await this.catchUp(v.id).catch(() => false);
        // no /cycles (older listener) or it failed: the status' own record keeps the column alive
        if (!caught) this.ingestRecord(v.last, at, 'status');
      }
      if (this.logLines) await this.pullLog(v.id, at).catch(() => undefined);
    }
    if (this.config === null || this.fingerprint !== st.keeper.configFingerprint) await this.pullConfig(st.keeper.configFingerprint).catch(() => undefined);
    tick('keeper', true, at);
  }

  ingestStatus(st: KeeperStatusT, at: number): void {
    this.status = st;
    this.statusAt = at;
    const k = st.keeper;
    this.handleBoot(k.bootAt, at);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO keeper_runs (boot_at, version, signer, dry_run, config_fingerprint, last_seen_at)
         VALUES (:boot_at, :version, :signer, :dry_run, :fp, :seen)
         ON CONFLICT (boot_at) DO UPDATE SET version = excluded.version, signer = excluded.signer, dry_run = excluded.dry_run,
           config_fingerprint = excluded.config_fingerprint, last_seen_at = excluded.last_seen_at`,
        { boot_at: k.bootAt, version: k.version, signer: k.signer.toLowerCase(), dry_run: k.mode === 'DRY_RUN' ? 1 : 0, fp: k.configFingerprint, seen: at },
      );
      this.db.run(
        `INSERT OR REPLACE INTO keeper_status (ts, reachable, busy, busy_since, head, head_at, skipped, mode, hook_errors, slow_responses)
         VALUES (:ts, 1, :busy, :busy_since, :head, :head_at, :skipped, :mode, :hook_errors, :slow)`,
        {
          ts: at,
          busy: bit(k.busy),
          busy_since: isoToTs(k.busySinceAt),
          head: k.head?.number ?? null,
          head_at: k.head ? isoToTs(k.head.at) : null,
          skipped: k.skippedWhileBusy,
          mode: k.mode,
          hook_errors: k.hookErrors,
          slow: k.listener.slowResponses,
        },
      );
      this.db.metaSet('keeper:signer', k.signer.toLowerCase());
      this.db.metaSet('keeper:rpc_host', k.rpcHost);
      if (this.fingerprint !== null && this.fingerprint !== k.configFingerprint) {
        appendEvent(this.db, 'config', null, k.configFingerprint, { event: 'fingerprint-changed', from: this.fingerprint, to: k.configFingerprint, bootAt: k.bootAt }, at);
      }
      this.fingerprint = k.configFingerprint;
      this.db.metaSet('keeper:fingerprint', k.configFingerprint);
      for (const v of st.vaults) {
        this.seenVaults.add(v.id);
        if (!this.cursors.has(v.id)) this.setCursor(v.id, { bootAt: k.bootAt, seq: 0 });
        this.warmVault(v.id);
      }
    });
    emitLive('status', null, { bootAt: k.bootAt, head: k.head, busy: k.busy, mode: k.mode }, at);
  }

  // bootAt change = the keeper restarted: seq restarts at 1, in-memory dwell /
  // regime are gone. every cursor drops to 0 and the stream reopens plain
  private handleBoot(bootAt: string, at: number): void {
    if (this.bootAt === bootAt) return;
    const prev = this.bootAt;
    this.bootAt = bootAt;
    this.db.transaction(() => {
      this.db.metaSet('keeper:boot_at', bootAt);
      for (const vault of new Set([...this.cursors.keys(), ...this.seenVaults])) this.setCursor(vault, { bootAt, seq: 0 });
      if (prev !== null) appendEvent(this.db, 'source', null, 'keeper', { source: 'keeper', event: 'restart', prevBootAt: prev, bootAt }, at);
    });
    if (prev !== null) {
      log('collect/keeper', `keeper restarted: bootAt ${prev} -> ${bootAt}; cursors reset`);
      this.sseAbort?.abort();
      try {
        this.onStateLost?.({ prevBootAt: prev, bootAt, at });
      } catch {
        // a hook must never break the collector
      }
    }
  }

  private setCursor(vault: string, c: KeeperCursor): void {
    this.cursors.set(vault, c);
    this.db.metaSetJson(`keeper:cursor:${vault}`, c);
  }

  private hit(at: number): void {
    this.failures = 0;
    this.lastOkAt = at;
    this.detail = null;
    if (!this.reachable) {
      this.reachable = true;
      this.unreachableSince = null;
      flipSource(this.db, 'keeper', true, null, at);
    }
    this.everPolled = true;
  }

  private miss(detail: string): void {
    const at = this.now();
    this.failures++;
    this.detail = detail;
    tick('keeper', false, at);
    if (this.failures >= this.misses && (this.reachable || !this.everPolled)) {
      this.reachable = false;
      this.everPolled = true;
      this.unreachableSince = this.unreachableSince ?? at;
      this.db.run(
        'INSERT OR REPLACE INTO keeper_status (ts, reachable, busy, busy_since, head, head_at, skipped, mode, hook_errors, slow_responses) VALUES (:ts, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)',
        { ts: at },
      );
      flipSource(this.db, 'keeper', false, detail, at);
    }
  }

  // --- /config ---------------------------------------------------------------------

  async pullConfig(fingerprint: string | null): Promise<void> {
    if (!this.baseUrl) return;
    const body = await fetchJson(this.fetchImpl, `${this.baseUrl}/config`, { timeoutMs: this.timeoutMs });
    const p = KeeperConfig.safeParse(body);
    if (!p.success) throw new SchemaError(p.error.issues.slice(0, 5).map((i) => i.path.join('.')));
    this.ingestConfig(p.data, this.now(), fingerprint);
  }

  ingestConfig(cfg: KeeperConfigT, at: number, fingerprint: string | null = cfg.fingerprint): void {
    this.config = cfg;
    this.configAt = at;
    this.db.transaction(() => {
      this.db.metaSetJson('keeper:config', cfg);
      this.db.metaSet('keeper:config_at', String(at));
      if (this.bootAt) {
        this.db.run('UPDATE keeper_runs SET public_config_json = :j, config_fingerprint = COALESCE(:fp, config_fingerprint) WHERE boot_at = :b', {
          j: JSON.stringify(cfg),
          fp: fingerprint,
          b: this.bootAt,
        });
      }
    });
  }

  // --- /vaults/:id/cycles catch-up --------------------------------------------------

  // pull seq > cursor for one vault until the ring is drained; false when the endpoint is unusable
  async catchUp(vault: string, limit = 500): Promise<boolean> {
    if (!this.baseUrl) return false;
    const at = this.now();
    for (let pages = 0; pages < 20; pages++) {
      const cur = this.cursors.get(vault) ?? { bootAt: this.bootAt ?? '', seq: 0 };
      let body: unknown;
      try {
        body = await fetchJson(this.fetchImpl, `${this.baseUrl}/vaults/${encodeURIComponent(vault)}/cycles?since=${cur.seq}&limit=${limit}`, {
          timeoutMs: this.timeoutMs,
        });
      } catch (e) {
        if (e instanceof HttpError && (e.status === 404 || e.status === 405)) return false;
        throw e;
      }
      const list = CyclesBody.safeParse(body);
      if (!list.success) return false;
      let n = 0;
      for (const item of list.data) {
        const p = CycleRecord.safeParse(item);
        if (!p.success) continue;
        if (p.data.vault.id !== vault) continue;
        this.ingestRecord(p.data, at, 'catch-up');
        n++;
      }
      if (n < limit) return true;
    }
    return true;
  }

  // --- /vaults/:id/log -----------------------------------------------------------------

  async pullLog(vault: string, at: number, n = 300): Promise<number> {
    if (!this.baseUrl) return 0;
    const text = await fetchText(this.fetchImpl, `${this.baseUrl}/vaults/${encodeURIComponent(vault)}/log?n=${n}`, { timeoutMs: this.timeoutMs });
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    return this.ingestLines(vault, lines, at);
  }

  ingestLines(vault: string, ring: string[], at: number): number {
    const fresh = newLines(this.lastLines.get(vault) ?? [], ring);
    this.lastLines.set(vault, ring);
    if (fresh.length === 0) return 0;
    this.db.transaction(() => {
      for (const raw of fresh) {
        const { ts, line } = splitLineTs(raw, at);
        this.db.run('INSERT INTO keeper_lines (vault_id, ts, line) VALUES (:v, :ts, :line)', { v: vault, ts, line });
      }
    });
    return fresh.length;
  }

  // --- records -----------------------------------------------------------------------------

  ingestRecord(rec: CycleRecord, receivedAt: number, via: 'sse' | 'catch-up' | 'status' = 'sse'): IngestResult {
    const vault = rec.vault.id;
    if (this.bootAt === null) this.handleBoot(rec.bootAt, receivedAt);
    else if (rec.bootAt !== this.bootAt) {
      // a record from a newer boot than /status has shown yet: adopt it; an older one is history
      if (Date.parse(rec.bootAt) > Date.parse(this.bootAt)) this.handleBoot(rec.bootAt, receivedAt);
      else return { inserted: false, stored: false, transition: false, reason: 'old-boot' };
    }
    this.seenVaults.add(vault);
    this.warmVault(vault);
    let cur = this.cursors.get(vault);
    if (!cur || cur.bootAt !== rec.bootAt) cur = { bootAt: rec.bootAt, seq: 0 };
    if (rec.seq <= cur.seq) return { inserted: false, stored: false, transition: false, reason: 'duplicate' };

    let stored = false;
    let transition = false;
    let inserted = false;
    this.db.transaction(() => {
      const raw = this.db.run(
        'INSERT OR IGNORE INTO cycles_raw (vault_id, boot_at, seq, block, block_ts, received_at, record_json) VALUES (:v, :b, :seq, :block, :bts, :at, :json)',
        { v: vault, b: rec.bootAt, seq: rec.seq, block: rec.block, bts: rec.blockTs, at: receivedAt, json: JSON.stringify(rec) },
      );
      this.setCursor(vault, { bootAt: rec.bootAt, seq: rec.seq });
      if (raw.changes === 0) return;
      inserted = true;

      const row = cycleRow(rec);
      const prev = this.lastRow.get(vault) ?? null;
      transition = isTransition(prev, row);
      const lastTs = this.lastStoredTs.get(vault);
      const heartbeat = lastTs === undefined || rec.blockTs - lastTs >= HEARTBEAT_SECS;
      if (transition || heartbeat) {
        const r = this.db.run(INSERT_CYCLE, { ...row, is_transition: transition ? 1 : 0, record_json: JSON.stringify(rec) });
        this.lastStoredTs.set(vault, rec.blockTs);
        stored = true;
        appendEvent(
          this.db,
          'cycle',
          vault,
          String(r.lastInsertRowid),
          { seq: rec.seq, block: rec.block, blockTs: rec.blockTs, outcome: rec.outcome, winner: rec.winner, isTransition: transition },
          receivedAt,
        );
      }
      this.lastRow.set(vault, row);

      this.applyEpisode(vault, rec, receivedAt);

      if (rec.regime) {
        const from = this.lastRegime.get(vault) ?? null;
        if (rec.regime.changed || (from !== null && from !== rec.regime.regime)) {
          this.db.run('INSERT INTO regimes (vault_id, ts, block, from_regime, to_regime, reason) VALUES (:v, :ts, :block, :from, :to, :reason)', {
            v: vault,
            ts: rec.blockTs,
            block: rec.block,
            from,
            to: rec.regime.regime,
            reason: rec.regime.reason,
          });
          appendEvent(this.db, 'regime', vault, String(rec.block), { from, to: rec.regime.regime, reason: rec.regime.reason, block: rec.block }, receivedAt);
        }
        this.lastRegime.set(vault, rec.regime.regime);
      }
    });
    if (inserted) emitLive('cycle', vault, { seq: rec.seq, block: rec.block, outcome: rec.outcome, winner: rec.winner, via, record: rec }, receivedAt);
    return { inserted, stored, transition, reason: 'ok' };
  }

  // standing runs: one open episode per vault (schema enforces it); the key is
  // standingOf() so compound-only cycles behind a failed gate extend a gate-blocked run
  private applyEpisode(vault: string, rec: CycleRecord, at: number): void {
    const key: StandingKey = standingOf(rec);
    const open = this.db.get<EpisodeRow>('SELECT id, code, subcode, since_ts FROM episodes WHERE vault_id = :v AND until_ts IS NULL', { v: vault });
    if (open && sameStanding({ code: open.code as StandingKey['code'], subcode: open.subcode as StandingKey['subcode'] }, key)) {
      this.db.run('UPDATE episodes SET last_seq = :seq, cycles = cycles + 1, detail = :detail WHERE id = :id', { seq: rec.seq, detail: rec.outcome.detail, id: open.id });
      return;
    }
    if (open) this.db.run('UPDATE episodes SET until_ts = :ts WHERE id = :id', { ts: rec.blockTs, id: open.id });
    this.db.run(
      'INSERT INTO episodes (vault_id, code, subcode, since_ts, until_ts, first_seq, last_seq, cycles, detail) VALUES (:v, :code, :sub, :since, NULL, :seq, :seq, 1, :detail)',
      { v: vault, code: key.code, sub: key.subcode, since: rec.blockTs, seq: rec.seq, detail: rec.outcome.detail },
    );
    appendEvent(
      this.db,
      'standing',
      vault,
      String(rec.seq),
      { code: key.code, subcode: key.subcode, sinceTs: rec.blockTs, prev: open ? { code: open.code, subcode: open.subcode, sinceTs: open.since_ts } : null },
      at,
    );
  }

  // --- /events sse ---------------------------------------------------------------------------

  // one frame from the stream: cycle records, log lines, or a status body
  dispatch(frame: SseFrame, at = this.now()): void {
    this.sseLastFrameAt = at;
    let json: unknown;
    try {
      json = JSON.parse(frame.data);
    } catch {
      return; // raw lines are never streamed unframed; anything else is noise
    }
    if (frame.id) {
      const id = splitEventId(frame.id);
      if (id && this.bootAt && id.bootAt !== this.bootAt && Date.parse(id.bootAt) > Date.parse(this.bootAt)) this.handleBoot(id.bootAt, at);
    }
    const rec = CycleRecord.safeParse(json);
    if (rec.success) {
      this.ingestRecord(rec.data, at, 'sse');
      return;
    }
    if (json !== null && typeof json === 'object') {
      const o = json as Record<string, unknown>;
      if (typeof o.line === 'string' && typeof o.vault === 'string') {
        const vault = o.vault.toLowerCase();
        for (const l of o.line.split('\n')) {
          const { ts, line } = splitLineTs(l, at);
          this.db.run('INSERT INTO keeper_lines (vault_id, ts, line) VALUES (:v, :ts, :line)', { v: vault, ts, line });
        }
        return;
      }
      if (frame.event === 'status' || (o.keeper && o.vaults)) {
        const st = KeeperStatus.safeParse(json);
        if (st.success) this.ingestStatus(st.data, at);
      }
    }
  }

  // one connection, until the stream ends or stop()/a boot reset aborts it
  async sseOnce(): Promise<void> {
    if (!this.baseUrl) return;
    const ac = new AbortController();
    this.sseAbort = ac;
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    const lastId = this.lastEventId();
    if (lastId) headers['last-event-id'] = lastId;
    const res = await this.fetchImpl(`${this.baseUrl}/events`, { headers, signal: ac.signal });
    if (!res.ok) throw new HttpError(res.status);
    if (!res.body) throw new Error('no body');
    this.sseConnected = true;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const f of parser.push(dec.decode(value, { stream: true }))) this.dispatch(f);
      }
      for (const f of parser.flush()) this.dispatch(f);
    } finally {
      this.sseConnected = false;
      reader.releaseLock();
    }
  }

  private async sseLoop(): Promise<void> {
    let backoff = 1000;
    while (!this.sseStopped) {
      try {
        await this.sseOnce();
        backoff = 1000;
      } catch (e) {
        if (!this.sseStopped && !(e instanceof Error && e.name === 'AbortError')) log('collect/keeper', `sse dropped: ${describeError(e)}`);
      }
      if (this.sseStopped) break;
      this.sseReconnects++;
      await sleep(backoff);
      backoff = Math.min(30_000, backoff * 2);
    }
  }
}
