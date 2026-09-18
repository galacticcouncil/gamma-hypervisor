import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Chain, VaultCtx, VaultRoles } from './chain';
import {
  GLOBAL_KEYS,
  VAULT_KEYS,
  type Config,
  type EnvKey,
  type GlobalConfig,
  type GlobalKey,
  type VaultKey,
} from './config';
import { addTee, log } from './log';
import {
  RECORD_V,
  TX_KIND_BY_VERB,
  classify,
  cooldownOf,
  gateFailedAtFor,
  sameStanding,
  stageFor,
  standingOf,
  type Compound,
  type Cooldown,
  type CycleRecord,
  type ExitMark,
  type Gate,
  type GateFailedAt,
  type GateVia,
  type OutcomeCode,
  type Pending,
  type Plan,
  type Standing,
  type Tx,
  type Winner,
} from './record';
import type { Regime } from './regime';

// read-only status listener: a memory snapshot of what the keeper knows plus
// the branch log grammar folded into CycleRecord v1. never awaits the provider,
// never throws into the block handler, stdout untouched.

const LINE_RING = 300;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;
const MAX_SSE_CLIENTS = 8;
const SSE_REPLAY_MAX = 500;
const SSE_BACKLOG_MAX = 1 << 20;
const PING_MS = 15_000;
const SLOW_MS = 50;

// ---------------------------------------------------------------------------
// public config projection
// ---------------------------------------------------------------------------

export type PublicGlobalKey = Exclude<GlobalKey, 'PRIVATE_KEY'>;
export const PUBLIC_GLOBAL_KEYS = GLOBAL_KEYS.filter((k): k is PublicGlobalKey => k !== 'PRIVATE_KEY');
export const PUBLIC_VAULT_KEYS: readonly VaultKey[] = VAULT_KEYS;

// compile-time proof: the only Env key the projection hides is PRIVATE_KEY
type _Hidden = Exclude<EnvKey, PublicGlobalKey | VaultKey>;
const _hiddenIsExactlyTheKey: [_Hidden] extends ['PRIVATE_KEY'] ? (['PRIVATE_KEY'] extends [_Hidden] ? true : never) : never = true;
void _hiddenIsExactlyTheKey;

const URL_KEYS: ReadonlySet<string> = new Set(['RPC_URL', 'INDEXER_URL']);

export type PublicValue = string | number | boolean | null | { host: string | null };

export function hostOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function project(cfg: Record<string, unknown>, keys: readonly string[]): Record<string, PublicValue> {
  const out: Record<string, PublicValue> = {};
  for (const k of keys) {
    const v = cfg[k];
    if (URL_KEYS.has(k)) out[k] = { host: hostOf(typeof v === 'string' ? v : null) };
    else if (v === undefined || v === null) out[k] = null;
    else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else out[k] = String(v);
  }
  return out;
}

// digests are cut to 128 bits so no /config body ever carries a 64-hex run
export function digest(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// redaction: by value (the key), by url (host only), by pattern
// ---------------------------------------------------------------------------

const USERINFO_RE = /\/\/[^/\s"'@]+:[^/\s"'@]*@/g;
// ethers quotes these with JSON.stringify, so the value carries escaped quotes
const URL_ATTR_RE = /\b(url|requestBody)=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,)]+)/g;

export function makeRedactor(key: string | undefined, urls: Array<string | undefined>): (s: string) => string {
  const hex = (key ?? '').replace(/^0x/i, '');
  const keyRe = /^[0-9a-f]{32,}$/i.test(hex) ? new RegExp(`(?:0x)?${hex}`, 'gi') : null;
  const pairs = urls
    .filter((u): u is string => typeof u === 'string' && u.length > 0)
    .map((u) => [u, hostOf(u) ?? '[redacted]'] as const)
    .sort((a, b) => b[0].length - a[0].length);
  return (s: string): string => {
    let out = s;
    if (keyRe) out = out.replace(keyRe, '[redacted]');
    for (const [u, h] of pairs) if (out.includes(u)) out = out.split(u).join(h);
    out = out.replace(USERINFO_RE, '//');
    out = out.replace(URL_ATTR_RE, '$1="[redacted]"');
    return out;
  };
}

// the redactor rewrites quoted attributes, so it runs on string leaves and never
// on a serialised body: `url="…"` inside json would inject unescaped quotes
export function redactDeep<T>(v: T, f: (s: string) => string): T {
  if (typeof v === 'string') return f(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, f)) as unknown as T;
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = redactDeep(x, f);
    return out as T;
  }
  return v;
}

// ---------------------------------------------------------------------------
// rings
// ---------------------------------------------------------------------------

class Ring<T> {
  private items: T[] = [];
  constructor(readonly cap: number) {}
  push(t: T): void {
    this.items.push(t);
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
  }
  get size(): number {
    return this.items.length;
  }
  first(): T | undefined {
    return this.items[0];
  }
  last(): T | undefined {
    return this.items[this.items.length - 1];
  }
  toArray(): readonly T[] {
    return this.items;
  }
}

// ---------------------------------------------------------------------------
// the branch grammar (keeper.ts / compound.ts / regime.ts line refs in the plan)
// ---------------------------------------------------------------------------

const RE_SUMMARY = /^#(\d+) tick=(-?\d+) base=\[(-?\d+),(-?\d+)\] (TRIGGER|REFRESH|FOLD|hold)( \+compound-due)? — ([\s\S]*)$/;
const RE_ERROR = /^#(\d+) error: ([\s\S]*)$/;
const RE_ARMING = /^arming (trigger|refresh|fold): held (\d+)s \/ (\d+)s$/;
const RE_COOLDOWN = /^skip: min interval \((\d+)s < (\d+)s\)$/;
const RE_TWAP_OK = /^twap ok: spot (-?\d+) vs TWAP\((\d+)s\) (-?\d+) \(dev (\d+)\)$/;
const RE_ORACLE_OK = /^oracle ok: pool (-?\d+) vs oracle (-?\d+) \(dev (\d+), age (\d+)s\)$/;
const RE_REGIME_CHANGE = /^\*\*\* REGIME -> (CALM|ELEVATED|EXTREME): ([\s\S]*) \*\*\*$/;
const RE_REGIME_ELEVATED = /^regime elevated — /;
const RE_NO_REGIME_FEED = /^oracle unreadable and REGIME_ENABLED=false/;
const RE_VOL = /^vol: /;
const RE_COMPOUND_SKIPPED = /^compound skipped: ([\s\S]*)$/;
const RE_COMPOUND_INFO = /^compound: ([\s\S]*)$/;
const RE_COMPOUND_SUBMITTED = /^compound submitted (0x[0-9a-fA-F]{64})$/;
const RE_COMPOUNDED = /^✓ compounded$/;
const RE_COMPOUND_REGIME = /^regime (CALM|ELEVATED|EXTREME) — not sweeping/;
const RE_SKIP_EXTREME = /^skip: regime EXTREME$/;
const RE_SKIP_GAS = /^skip: gas \(WETH\) balance /;
const RE_CLAMP = /^clamp: walking band/;
const RE_SKIP_TRANSLATION = /^skip: translation cap /;
const RE_SKIP_WIDTH = /^skip: width delta /;
const RE_PLAN = /^plan( \((limit refresh|fold at balance), base unchanged\))?: base=\[(-?\d+),(-?\d+)\] limit=\[(-?\d+),(-?\d+)\] surplus=(above|below) tol=(\d+)bps$/;
const RE_DRY = /^DRY_RUN: not sending$/;
const RE_PREFLIGHT = /^skip: preflight revert — /;
const RE_SUBMITTING = /^submitting rebalance via /;
const RE_LANDED = /^✓ (rebalanced|limit refreshed|folded at balance) — (0x[0-9a-fA-F]{64})$/;
const RE_SKIP = /^skip: ([\s\S]*)$/;
// gate reason numerics (checkPrice, keeper.ts:224/:256)
const RE_TWAP_DEV = /^spot (-?\d+) vs TWAP\((\d+)s\) (-?\d+) dev (\d+) > (\d+)/;
const RE_ORACLE_DEV = /^pool (-?\d+) vs oracle (-?\d+) dev (\d+) > (\d+)/;
// trigger reasons (decide.ts)
const RE_OUTSIDE = /^tick (-?\d+) outside base \[(-?\d+), (-?\d+)\]$/;
const RE_DRIFT = /^drift (\d+) > threshold (\d+)$/;
const RE_INRANGE = /^in range \(drift (\d+) <= (\d+)\)$/;
const RE_REFRESH_REASON = /^limit \[(-?\d+), (-?\d+)\] is (\d+) ticks from spot (-?\d+) \(> (\d+)\)$/;
const RE_FOLD_REASON = /^limit is ([\d.]+)\/([\d.]+) mixed/;

type Leg = 'trigger' | 'refresh' | 'fold';
const LEG_OF_WINNER: Record<Exclude<Winner, 'hold'>, Leg> = { TRIGGER: 'trigger', REFRESH: 'refresh', FOLD: 'fold' };
const PLAN_KIND_OF: Record<string, Plan['kind']> = { '': 'recenter', 'limit refresh': 'refresh', 'fold at balance': 'fold' };

interface GateFail {
  failedAt: GateFailedAt | null;
  reason: string;
  via: GateVia | null;
}

interface PendingCycle {
  block: number;
  blockTs: number;
  tsSource: 'block' | 'wall';
  startedAt: number;
  lastLineAt: number | null;
  touched: boolean;
  /** state.lastRebalanceTs before this cycle ran */
  lastRebalanceTs: number;
  reads: CycleRecord['reads'];
  triggers: CycleRecord['triggers'];
  winner: Winner | null;
  compoundDue: boolean;
  arming: Record<Leg, boolean>;
  armingLine: string | null;
  cooldown: Cooldown | null;
  cooldownLine: string | null;
  post485: boolean;
  twap: Gate['twap'];
  oracle: Gate['oracle'];
  gateFail: GateFail | null;
  regimeChange: { regime: Regime; reason: string } | null;
  compound: Compound | null;
  plan: Omit<Plan, 'clamped'> | null;
  clamped: boolean;
  tx: Tx | null;
  error: string | null;
  marks: Partial<Record<ExitMark, boolean>>;
  lastMark: string | null;
}

interface VaultSlot {
  ctx: VaultCtx;
  lines: Ring<string>;
  records: Ring<{ seq: number; json: string }>;
  pending: PendingCycle | null;
  seq: number;
  last: CycleRecord | null;
  standing: Standing | null;
}

interface SseClient {
  res: http.ServerResponse;
}

interface SseEvent {
  id: number;
  data: string;
}

export interface StatusOpts {
  blockTimeSecs?: number;
  /** record ring per vault; defaults to STATUS_RING */
  ring?: number;
  lineRing?: number;
}

// ---------------------------------------------------------------------------
// snapshot shapes (what GET /status serves)
// ---------------------------------------------------------------------------

export interface DwellLegStatus {
  sinceTs: number;
  heldSecs: number;
  met: boolean;
}

export interface VaultStatus {
  id: string;
  label: string;
  tag: string;
  pool: string;
  token0: { address: string; symbol: string; decimals: number };
  token1: { address: string; symbol: string; decimals: number };
  tickSpacing: number;
  entrypoint: Config['ENTRYPOINT'];
  proxy: string | null;
  admin: string | null;
  feeRecipient: string;
  owner: string;
  dwellSecs: number;
  roles: VaultRoles | null;
  state: {
    lastRebalanceTs: number;
    dwell: { rebalance: DwellLegStatus; refresh: DwellLegStatus; fold: DwellLegStatus };
    regime: { regime: Regime; sinceTs: number; calmSinceTs: number | null };
    priceTrail: { size: number; move15mFrac: number | null; move1hFrac: number | null };
    volBaseline: { median: number; fetchedAtTs: number } | null;
    lastCompoundTs: number;
  };
  standing: Standing | null;
  last: CycleRecord | null;
  ring: { size: number; firstSeq: number | null; lastSeq: number | null };
}

export interface StatusBody {
  v: 1;
  generatedAt: string;
  keeper: {
    version: string;
    bootAt: string;
    mode: 'LIVE' | 'DRY_RUN';
    signer: string;
    rpcHost: string | null;
    pollMs: number;
    blockTimeSecs: number | null;
    /** the last block evaluated: one triple, one writer */
    head: { number: number | null; ts: number | null; at: string | null };
    /** the newest block the subscription saw, evaluated or skipped */
    seenHead: { number: number | null; at: string | null };
    busy: boolean;
    busySinceAt: string | null;
    skippedWhileBusy: number;
    cyclesTotal: number;
    errorsTotal: number;
    hookErrors: number;
    fatalErrors: number;
    listener: { requests: number; slowResponses: number; clients: number };
    configFingerprint: string;
  };
  vaults: VaultStatus[];
}

export interface ConfigBody {
  v: 1;
  generatedAt: string;
  source: 'env' | 'VAULTS_FILE' | 'VAULTS_JSON';
  descriptorSha256: string | null;
  global: Record<string, PublicValue>;
  vaults: Record<string, PublicValue>[];
  fingerprint: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

function readVersion(): string {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  if (raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// `<bootAt>:<n>` or a bare `<n>`; bootAt itself contains colons, so split on the last
function parseCursor(raw: string): { boot: string | null; seq: number | null } {
  const i = raw.lastIndexOf(':');
  const boot = i >= 0 ? raw.slice(0, i) : null;
  const n = Number(i >= 0 ? raw.slice(i + 1) : raw);
  return { boot, seq: Number.isFinite(n) ? Math.trunc(n) : null };
}

// ---------------------------------------------------------------------------
// the instance
// ---------------------------------------------------------------------------

export class StatusInstance {
  readonly bootAt: string;
  readonly redact: (s: string) => string;
  readonly fingerprint: string;
  readonly descriptorSha256: string | null;
  readonly source: ConfigBody['source'];
  hookErrors = 0;
  /** uncaught exceptions / unhandled rejections the process survived */
  fatalErrors = 0;

  private readonly startedAt = Date.now();
  private readonly version = readVersion();
  private readonly vaults: VaultSlot[];
  private readonly byTag = new Map<string, VaultSlot>();
  private readonly events: Ring<SseEvent>;
  private evSeq = 0;
  // the evaluated block, written as one triple; `seenHead` is the newest block
  // the subscription saw, which runs ahead of it while a cycle is in flight
  private head: { number: number | null; ts: number | null; at: number | null } = { number: null, ts: null, at: null };
  private seenHead: { number: number | null; at: number | null } = { number: null, at: null };
  private busy = false;
  private busySinceAt: number | null = null;
  private cycleStartAt: number | null = null;
  private skippedWhileBusy = 0;
  private cyclesTotal = 0;
  private errorsTotal = 0;
  private requests = 0;
  private slowResponses = 0;
  private readonly clients = new Set<SseClient>();
  private server: http.Server | null = null;
  private ping: NodeJS.Timeout | null = null;
  private untee: (() => void) | null = null;

  constructor(
    private readonly global: GlobalConfig,
    private readonly chain: Chain,
    vaults: VaultCtx[],
    private readonly opts: StatusOpts = {},
  ) {
    this.bootAt = iso(this.startedAt);
    this.redact = makeRedactor(global.PRIVATE_KEY, [global.RPC_URL, global.INDEXER_URL]);
    const ring = opts.ring ?? global.STATUS_RING;
    this.events = new Ring(ring);
    this.vaults = vaults.map((ctx) => ({
      ctx,
      lines: new Ring<string>(opts.lineRing ?? LINE_RING),
      records: new Ring(ring),
      pending: null,
      seq: 0,
      last: null,
      standing: null,
    }));
    for (const v of this.vaults) this.byTag.set(v.ctx.tag, v);
    this.source = process.env.VAULTS_FILE ? 'VAULTS_FILE' : process.env.VAULTS_JSON ? 'VAULTS_JSON' : 'env';
    this.descriptorSha256 = this.readDescriptorDigest();
    const pub = this.publicConfig();
    this.fingerprint = digest(JSON.stringify({ global: pub.global, vaults: pub.vaults }));
  }

  private readDescriptorDigest(): string | null {
    const file = process.env.VAULTS_FILE;
    if (!file) return null;
    try {
      return digest(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  // --- wiring ---------------------------------------------------------------

  /** become the hooks' target and start receiving log lines */
  install(): this {
    current = this;
    this.untee?.();
    this.untee = addTee((tag, msg) => {
      try {
        this.onLine(tag, msg);
      } catch {
        this.hookErrors++;
      }
    });
    return this;
  }

  uninstall(): void {
    if (current === this) current = null;
    this.untee?.();
    this.untee = null;
  }

  // --- hooks (called through `status`, which never lets them throw) ---------

  onHead(blockNumber: number, busy: boolean): void {
    const now = Date.now();
    this.seenHead = { number: blockNumber, at: now };
    if (busy) {
      this.skippedWhileBusy++;
      return;
    }
    this.busy = true;
    this.busySinceAt = now;
  }

  onCycleStart(blockNumber: number, blockTs?: number | null): void {
    const now = Date.now();
    this.cycleStartAt = now;
    // one writer, so `number`, `ts` and `at` always describe the same block
    this.head = { number: blockNumber, ts: typeof blockTs === 'number' ? blockTs : this.head.ts, at: now };
    for (const v of this.vaults) this.open(v, blockNumber, blockTs ?? null, now);
  }

  onCycleEnd(_blockNumber: number): void {
    const now = Date.now();
    let cursor = this.cycleStartAt ?? now;
    for (const v of this.vaults) {
      const p = v.pending;
      v.pending = null;
      if (!p) continue;
      // vaults run in order, so one's start is the previous one's last line
      if (this.cycleStartAt !== null) p.startedAt = cursor;
      if (p.lastLineAt !== null) cursor = p.lastLineAt;
      if (p.touched) this.finalize(v, p, now);
    }
    this.cycleStartAt = null;
    this.busy = false;
    this.busySinceAt = null;
    this.cyclesTotal++;
  }

  onLine(tag: string | null, msg: string): void {
    const line = this.redact(msg);
    const at = Date.now();
    if (tag === null) {
      if (RE_ERROR.test(line.trim())) this.errorsTotal++;
      return;
    }
    const v = this.byTag.get(tag);
    if (!v) return;
    // one ctx.log() can carry several physical lines (the deadlock block, the
    // compound-interval warning): each is stamped and counted on its own, so
    // `?n=` returns the number of lines the caller asked for
    const stamp = iso(at);
    for (const physical of line.split('\n')) v.lines.push(`[${stamp}] ${physical}`);
    this.parse(v, line.trim(), at);
  }

  // --- parser -----------------------------------------------------------------

  private open(v: VaultSlot, block: number, blockTs: number | null, at: number): PendingCycle {
    if (v.pending?.touched && v.pending.block !== block) this.finalize(v, v.pending, at);
    const p: PendingCycle = {
      block,
      blockTs: blockTs ?? Math.trunc(at / 1000),
      tsSource: blockTs === null ? 'wall' : 'block',
      startedAt: at,
      lastLineAt: null,
      touched: false,
      lastRebalanceTs: v.ctx.state.lastRebalanceTs,
      reads: null,
      triggers: null,
      winner: null,
      compoundDue: false,
      arming: { trigger: false, refresh: false, fold: false },
      armingLine: null,
      cooldown: null,
      cooldownLine: null,
      post485: false,
      twap: null,
      oracle: null,
      gateFail: null,
      regimeChange: null,
      compound: null,
      plan: null,
      clamped: false,
      tx: null,
      error: null,
      marks: {},
      lastMark: null,
    };
    v.pending = p;
    return p;
  }

  private parse(v: VaultSlot, s: string, at: number): void {
    let m: RegExpExecArray | null;
    // the summary line opens the cycle when no hook did (or when the block moved on)
    if ((m = RE_SUMMARY.exec(s))) {
      const block = Number(m[1]);
      const p = v.pending && v.pending.block === block ? v.pending : this.open(v, block, null, at);
      this.touch(p, at);
      p.reads = { spotTick: Number(m[2]), sqrtPriceX96: null, base: [Number(m[3]), Number(m[4])], limit: null, limitLiquidity: null };
      p.winner = m[5] as Winner;
      p.compoundDue = m[6] !== undefined;
      p.triggers = triggersFrom(p.winner, m[7]);
      return;
    }
    if ((m = RE_ERROR.exec(s))) {
      const block = Number(m[1]);
      const p = v.pending && v.pending.block === block ? v.pending : this.open(v, block, null, at);
      this.touch(p, at);
      p.error = m[2];
      this.errorsTotal++;
      return;
    }
    const p = v.pending;
    if (!p) return;
    this.touch(p, at);
    const mark = (k: ExitMark) => {
      p.marks[k] = true;
      p.lastMark = s;
      p.post485 = true;
    };

    if ((m = RE_ARMING.exec(s))) {
      p.arming[m[1] as Leg] = true;
      p.armingLine = s.slice('arming '.length);
      return;
    }
    if ((m = RE_COOLDOWN.exec(s))) {
      p.cooldown = { evaluated: true, elapsedSecs: Number(m[1]), minIntervalSecs: Number(m[2]), skipped: true };
      p.cooldownLine = s.slice('skip: '.length);
      return;
    }
    if ((m = RE_TWAP_OK.exec(s))) {
      p.post485 = true;
      p.twap = { windowSecs: Number(m[2]), tick: Number(m[3]), devTicks: Number(m[4]), maxDevTicks: v.ctx.cfg.MAX_DEV_TICKS };
      return;
    }
    if ((m = RE_ORACLE_OK.exec(s))) {
      p.post485 = true;
      p.oracle = { tick: Number(m[2]), ageSecs: Number(m[4]), devTicks: Number(m[3]), maxDevTicks: v.ctx.cfg.ORACLE_MAX_DEV_TICKS };
      return;
    }
    if ((m = RE_REGIME_CHANGE.exec(s))) {
      p.post485 = true;
      p.regimeChange = { regime: m[1].toLowerCase() as Regime, reason: m[2] };
      return;
    }
    if (RE_REGIME_ELEVATED.test(s) || RE_VOL.test(s) || RE_SUBMITTING.test(s)) {
      p.post485 = true;
      return;
    }
    if (RE_NO_REGIME_FEED.test(s)) {
      mark('no-regime-feed-unreadable');
      p.gateFail = { failedAt: 'oracle-unreadable', reason: s, via: null };
      return;
    }
    if ((m = RE_COMPOUND_SKIPPED.exec(s))) {
      p.post485 = true;
      const reason = m[1];
      const failedAt = gateFailedAtFor(reason);
      if (failedAt) {
        p.gateFail = { failedAt, reason, via: 'compound-skipped' };
        this.gateNumbers(p, reason);
        p.compound = { allowed: false, reason, submitted: null, landed: false };
      } else if (RE_COMPOUND_REGIME.test(reason)) {
        p.compound = { allowed: false, reason, submitted: null, landed: false };
      } else {
        // compoundOnce's own catch: the sweep was allowed and then failed
        p.compound = { allowed: true, reason, submitted: p.compound?.submitted ?? null, landed: false };
      }
      return;
    }
    if ((m = RE_COMPOUND_INFO.exec(s))) {
      p.post485 = true;
      p.compound = { allowed: true, reason: m[1], submitted: p.compound?.submitted ?? null, landed: false };
      return;
    }
    if ((m = RE_COMPOUND_SUBMITTED.exec(s))) {
      p.post485 = true;
      p.compound = { allowed: true, reason: p.compound?.reason ?? 'sweeping', submitted: m[1], landed: false };
      return;
    }
    if (RE_COMPOUNDED.test(s)) {
      p.post485 = true;
      p.compound = { allowed: true, reason: p.compound?.reason ?? 'sweeping', submitted: p.compound?.submitted ?? null, landed: true };
      return;
    }
    if (RE_SKIP_EXTREME.test(s)) return mark('regime-extreme');
    if (RE_SKIP_GAS.test(s)) return mark('gas-floor');
    if (RE_CLAMP.test(s)) {
      p.post485 = true;
      p.clamped = true;
      return;
    }
    if (RE_SKIP_TRANSLATION.test(s)) return mark('clamp-unworkable');
    if (RE_SKIP_WIDTH.test(s)) return mark('width-cap');
    if (RE_PREFLIGHT.test(s)) return mark('preflight-revert');
    if ((m = RE_PLAN.exec(s))) {
      p.post485 = true;
      p.plan = {
        kind: PLAN_KIND_OF[m[2] ?? ''],
        base: [Number(m[3]), Number(m[4])],
        limit: [Number(m[5]), Number(m[6])],
        side: m[7] as Plan['side'],
        tolBps: Number(m[8]),
      };
      return;
    }
    if (RE_DRY.test(s)) return mark('dry-run');
    if ((m = RE_LANDED.exec(s))) {
      mark('landed');
      p.tx = { hash: m[2], kind: TX_KIND_BY_VERB[m[1]] };
      return;
    }
    if ((m = RE_SKIP.exec(s))) {
      const reason = m[1];
      const failedAt = gateFailedAtFor(reason);
      if (failedAt) {
        mark('gate-blocked');
        p.gateFail = { failedAt, reason, via: 'skip' };
        this.gateNumbers(p, reason);
      }
      return;
    }
  }

  private touch(p: PendingCycle, at: number): void {
    p.touched = true;
    p.lastLineAt = at;
  }

  // pull the numbers out of a failing gate reason
  private gateNumbers(p: PendingCycle, reason: string): void {
    let m: RegExpExecArray | null;
    if ((m = RE_TWAP_DEV.exec(reason))) {
      p.twap = { windowSecs: Number(m[2]), tick: Number(m[3]), devTicks: Number(m[4]), maxDevTicks: Number(m[5]) };
    } else if ((m = RE_ORACLE_DEV.exec(reason))) {
      p.oracle = { tick: Number(m[2]), ageSecs: null, devTicks: Number(m[3]), maxDevTicks: Number(m[4]) };
    }
  }

  private finalize(v: VaultSlot, p: PendingCycle, at: number): void {
    const { ctx } = v;
    const { cfg, state } = ctx;
    const blockTs = p.blockTs;

    const leg = (since: number) => ({
      sinceTs: since,
      heldSecs: since > 0 ? Math.max(0, blockTs - since) : 0,
      requiredSecs: ctx.dwellSecs,
      armed: since > 0 && blockTs - since >= ctx.dwellSecs,
    });
    const dwell = { rebalance: leg(state.dwellSince), refresh: leg(state.refreshDwellSince), fold: leg(state.foldDwellSince) };

    // armed = the winner's dwell was met: its word is on the summary line and no
    // `arming` line followed (keeper.ts:60 prints one whenever it is still counting)
    const winnerLeg = p.winner && p.winner !== 'hold' ? LEG_OF_WINNER[p.winner] : null;
    const armed = winnerLeg !== null && !p.arming[winnerLeg];
    const anyArming = p.arming.trigger || p.arming.refresh || p.arming.fold;

    let cooldown: Cooldown | null = p.cooldown;
    if (!cooldown && armed) {
      cooldown = {
        ...cooldownOf({ now: blockTs, minIntervalSecs: cfg.MIN_INTERVAL_SECS, lastRebalanceTs: p.lastRebalanceTs, caps: null }),
        skipped: false, // no skip line printed, whatever the proxy's interval was
      };
    }

    // past keeper.ts:485 iff compound was due or something was armed and not cooled down
    const gateEvaluated =
      p.post485 || p.gateFail !== null || p.twap !== null || p.oracle !== null || p.compoundDue || (armed && !cooldown?.skipped);
    const gate: Gate | null = gateEvaluated
      ? {
          evaluated: true,
          ok: p.gateFail === null,
          failedAt: p.gateFail?.failedAt ?? null,
          reason: p.gateFail?.reason ?? 'ok',
          via: p.gateFail?.via ?? null,
          twap: p.twap,
          oracle: p.oracle,
        }
      : null;

    const regime: CycleRecord['regime'] =
      cfg.REGIME_ENABLED && gate !== null
        ? { regime: state.regime.regime, changed: p.regimeChange !== null, reason: p.regimeChange?.reason ?? null, sinceTs: state.regime.since }
        : null;

    const pending: Pending = {
      compoundDue: p.compoundDue,
      arming: anyArming,
      cooldown: cooldown ? { skipped: cooldown.skipped } : null,
      gate: gate ? { ok: gate.ok, failedAt: gate.failedAt, via: gate.via } : null,
      tx: p.tx,
      error: p.error,
      marks: p.marks,
    };
    const code = classify(pending);

    v.seq++;
    const rec: CycleRecord = {
      v: RECORD_V,
      bootAt: this.bootAt,
      seq: v.seq,
      vault: { id: ctx.id, label: ctx.label },
      block: p.block,
      blockTs,
      tsSource: p.tsSource,
      evaluatedAt: iso(at),
      durationMs: p.lastLineAt !== null ? Math.max(0, p.lastLineAt - p.startedAt) : null,
      reads: p.reads,
      triggers: p.triggers,
      winner: p.winner,
      compoundDue: p.compoundDue,
      dwell,
      cooldown,
      gate,
      regime,
      compound: p.compound,
      plan: p.plan ? { ...p.plan, clamped: p.clamped } : null,
      tx: p.tx,
      outcome: { code, stage: stageFor(code), detail: detailFor(code, p) },
      source: 'parsed',
    };

    const key = standingOf(rec);
    if (!v.standing || !sameStanding(v.standing, key)) {
      v.standing = { code: key.code, subcode: key.subcode, sinceTs: blockTs, seq: rec.seq };
    }
    v.last = rec;
    const json = JSON.stringify(redactDeep(rec, this.redact));
    v.records.push({ seq: rec.seq, json });
    const ev: SseEvent = { id: ++this.evSeq, data: json };
    this.events.push(ev);
    this.broadcast(this.frame(ev));
  }

  // --- views ------------------------------------------------------------------

  snapshot(): StatusBody {
    const now = Date.now();
    const nowTs = this.head.ts ?? Math.trunc(now / 1000);
    const cfg = this.global;
    return {
      v: 1,
      generatedAt: iso(now),
      keeper: {
        version: this.version,
        bootAt: this.bootAt,
        mode: cfg.DRY_RUN ? 'DRY_RUN' : 'LIVE',
        signer: this.chain.signer.address,
        rpcHost: hostOf(cfg.RPC_URL),
        pollMs: cfg.POLL_INTERVAL_MS,
        blockTimeSecs: this.opts.blockTimeSecs ?? null,
        head: { number: this.head.number, ts: this.head.ts, at: this.head.at === null ? null : iso(this.head.at) },
        seenHead: { number: this.seenHead.number, at: this.seenHead.at === null ? null : iso(this.seenHead.at) },
        busy: this.busy,
        busySinceAt: this.busySinceAt === null ? null : iso(this.busySinceAt),
        skippedWhileBusy: this.skippedWhileBusy,
        cyclesTotal: this.cyclesTotal,
        errorsTotal: this.errorsTotal,
        hookErrors: this.hookErrors,
        fatalErrors: this.fatalErrors,
        listener: { requests: this.requests, slowResponses: this.slowResponses, clients: this.clients.size },
        configFingerprint: this.fingerprint,
      },
      vaults: this.vaults.map((v) => this.vaultStatus(v, nowTs)),
    };
  }

  // explicit fields only: a spread of ctx would serialise the provider url and the wallet
  private vaultStatus(v: VaultSlot, nowTs: number): VaultStatus {
    const { ctx } = v;
    const { cfg, state } = ctx;
    const leg = (since: number): DwellLegStatus => ({
      sinceTs: since,
      heldSecs: since > 0 ? Math.max(0, nowTs - since) : 0,
      met: since > 0 && nowTs - since >= ctx.dwellSecs,
    });
    return {
      id: ctx.id,
      label: ctx.label,
      tag: ctx.tag,
      pool: ctx.pool.address,
      token0: { address: ctx.token0.address, symbol: ctx.symbol0, decimals: ctx.decimals0 },
      token1: { address: ctx.token1.address, symbol: ctx.symbol1, decimals: ctx.decimals1 },
      tickSpacing: ctx.tickSpacing,
      entrypoint: cfg.ENTRYPOINT,
      proxy: ctx.proxy?.address ?? null,
      admin: cfg.ADMIN_ADDRESS ?? null,
      feeRecipient: ctx.feeRecipient,
      owner: ctx.owner,
      dwellSecs: ctx.dwellSecs,
      roles: ctx.roles ?? null,
      state: {
        lastRebalanceTs: state.lastRebalanceTs,
        dwell: { rebalance: leg(state.dwellSince), refresh: leg(state.refreshDwellSince), fold: leg(state.foldDwellSince) },
        regime: { regime: state.regime.regime, sinceTs: state.regime.since, calmSinceTs: state.regime.calmSince ?? null },
        priceTrail: {
          size: state.prices.size,
          move15mFrac: state.prices.moveOver(15 * 60, nowTs) ?? null,
          move1hFrac: state.prices.moveOver(60 * 60, nowTs) ?? null,
        },
        volBaseline: state.volBaseline ? { median: state.volBaseline.median, fetchedAtTs: state.volBaseline.fetchedAt } : null,
        lastCompoundTs: state.lastCompoundTs,
      },
      standing: v.standing,
      last: v.last,
      ring: { size: v.records.size, firstSeq: v.records.first()?.seq ?? null, lastSeq: v.records.last()?.seq ?? null },
    };
  }

  publicConfig(): ConfigBody {
    return {
      v: 1,
      generatedAt: iso(Date.now()),
      source: this.source,
      descriptorSha256: this.descriptorSha256,
      global: project(this.global as unknown as Record<string, unknown>, PUBLIC_GLOBAL_KEYS),
      vaults: this.vaults.map((v) => project(v.ctx.cfg as unknown as Record<string, unknown>, PUBLIC_VAULT_KEYS)),
      fingerprint: this.fingerprint ?? '',
    };
  }

  findVault(id: string): VaultCtx | null {
    let key = id;
    try {
      key = decodeURIComponent(id);
    } catch {
      // keep the raw segment
    }
    const lower = key.toLowerCase();
    const hit = this.vaults.find((v) => v.ctx.id === lower || v.ctx.label === key || v.ctx.tag === key);
    return hit?.ctx ?? null;
  }

  /** pre-serialised records with seq > since, as one json body */
  cycles(id: string, sinceRaw: string | null, limitRaw: string | null, order: string | null): string | null {
    const ctx = this.findVault(id);
    if (!ctx) return null;
    const v = this.vaults.find((x) => x.ctx === ctx)!;
    const limit = clampInt(limitRaw, DEFAULT_LIMIT, 1, MAX_LIMIT);
    let since = 0;
    if (sinceRaw) {
      const c = parseCursor(sinceRaw);
      const mine = (c.boot === null || c.boot === this.bootAt) && c.seq !== null && c.seq <= v.seq;
      // a cursor from another boot, or past this boot's head, means "give me the
      // tail": the newest `limit`, not the oldest
      since = mine ? Math.max(0, c.seq as number) : Math.max(0, v.seq - limit);
    }
    const all = v.records.toArray();
    let start = 0;
    while (start < all.length && all[start].seq <= since) start++;
    const slice = all.slice(start, start + limit);
    const complete = start + limit >= all.length;
    const items = order === 'desc' ? [...slice].reverse() : slice;
    const next = slice.length ? slice[slice.length - 1].seq : since;
    return (
      `{"v":1,"generatedAt":${JSON.stringify(iso(Date.now()))},"vault":${JSON.stringify({ id: ctx.id, label: ctx.label })},` +
      `"bootAt":${JSON.stringify(this.bootAt)},"since":${since},"order":${JSON.stringify(order === 'desc' ? 'desc' : 'asc')},` +
      `"items":[${items.map((r) => r.json).join(',')}],"next":${next},"complete":${complete}}`
    );
  }

  logLines(id: string, nRaw: string | null): string[] | null {
    const ctx = this.findVault(id);
    if (!ctx) return null;
    const v = this.vaults.find((x) => x.ctx === ctx)!;
    const n = clampInt(nRaw, LINE_RING, 1, LINE_RING);
    const all = v.lines.toArray();
    return all.slice(Math.max(0, all.length - n));
  }

  healthy(): { ok: boolean; headAgeSecs: number; busySecs: number } {
    const now = Date.now();
    // the block subscription's own liveness, not the cycle's: a wedged cycle is
    // what `busySecs` is for
    const headAgeSecs = Math.trunc((now - (this.seenHead.at ?? this.startedAt)) / 1000);
    const busySecs = this.busySinceAt === null ? 0 : Math.trunc((now - this.busySinceAt) / 1000);
    return { ok: headAgeSecs <= 60 && busySecs <= 600, headAgeSecs, busySecs };
  }

  // --- http -------------------------------------------------------------------

  listen(port: number, host = '0.0.0.0'): Promise<number> {
    const server = http.createServer((req, res) => this.handle(req, res));
    server.maxConnections = 16;
    server.maxRequestsPerSocket = 100;
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.keepAliveTimeout = 5000;
    server.on('clientError', (_e, socket) => {
      try {
        socket.destroy();
      } catch {
        // already gone
      }
    });
    this.server = server;
    this.ping = setInterval(() => this.broadcast(': ping\n\n'), PING_MS);
    this.ping.unref();
    return new Promise((resolve) => {
      // EADDRINUSE and friends log and leave the keeper running without a listener
      server.on('error', (e: NodeJS.ErrnoException) => {
        log(`warn: status listener error (${e?.code ?? e?.message ?? e})`);
        resolve(0);
      });
      server.listen(port, host, () => {
        const a = server.address();
        const bound = typeof a === 'object' && a ? a.port : port;
        log(`status listener on :${bound} (read-only, overlay only)`);
        resolve(bound);
      });
    });
  }

  async close(): Promise<void> {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    for (const c of [...this.clients]) this.drop(c);
    const s = this.server;
    this.server = null;
    if (!s) return;
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections();
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.requests++;
    const t0 = performance.now();
    try {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return this.send(res, 405, errorBody('method-not-allowed', 'GET only'), t0);
      }
      const url = new URL(req.url ?? '/', 'http://status.local');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (path === '/') return this.send(res, 200, JSON.stringify(discovery()), t0);
      if (path === '/status') return this.send(res, 200, JSON.stringify(redactDeep(this.snapshot(), this.redact)), t0);
      if (path === '/config') return this.send(res, 200, JSON.stringify(redactDeep(this.publicConfig(), this.redact)), t0);
      if (path === '/healthz') {
        const h = this.healthy();
        return this.send(res, h.ok ? 200 : 503, JSON.stringify({ v: 1, ...h, advisory: true }), t0);
      }
      if (path === '/events') return this.sse(req, res, url);
      const m = /^\/vaults\/([^/]+)\/(cycles|log)$/.exec(path);
      if (m) {
        if (m[2] === 'cycles') {
          const body = this.cycles(m[1], url.searchParams.get('since'), url.searchParams.get('limit'), url.searchParams.get('order'));
          if (body === null) return this.send(res, 404, errorBody('not-found', 'no such vault'), t0);
          return this.send(res, 200, body, t0);
        }
        const lines = this.logLines(m[1], url.searchParams.get('n'));
        if (lines === null) return this.send(res, 404, errorBody('not-found', 'no such vault'), t0);
        return this.send(res, 200, lines.length ? this.redact(lines.join('\n')) + '\n' : '', t0, 'text/plain; charset=utf-8');
      }
      return this.send(res, 404, errorBody('not-found', 'no such route'), t0);
    } catch {
      // never echo the exception: it may carry a provider error string
      try {
        this.send(res, 500, errorBody('internal', 'internal error'), t0);
      } catch {
        // response already torn down
      }
    }
  }

  // bodies arrive redacted: json through redactDeep on the object, text through
  // this.redact on the raw lines
  private send(res: http.ServerResponse, code: number, out: string, t0: number, ctype = 'application/json; charset=utf-8'): void {
    res.writeHead(code, {
      'Content-Type': ctype,
      'Content-Length': Buffer.byteLength(out),
      'Cache-Control': 'no-store',
      'X-Api-Version': '1',
    });
    res.end(out);
    if (performance.now() - t0 > SLOW_MS) this.slowResponses++;
  }

  private frame(e: SseEvent): string {
    return `id: ${this.bootAt}:${e.id}\nevent: cycle\ndata: ${e.data}\n\n`;
  }

  private sse(req: http.IncomingMessage, res: http.ServerResponse, _url: URL): void {
    if (this.clients.size >= MAX_SSE_CLIENTS) {
      res.setHeader('Retry-After', '15');
      return this.send(res, 503, errorBody('stream-limit', 'too many stream clients'), performance.now());
    }
    const client: SseClient = { res };
    this.clients.add(client);
    // a write on a peer-torn socket emits `error` asynchronously; without these
    // listeners that is an uncaught exception no handler try/catch covers
    const drop = () => this.drop(client);
    req.on('error', drop);
    res.on('error', drop);
    res.socket?.on('error', drop);
    req.on('close', drop);
    res.on('close', drop);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Api-Version': '1',
    });
    res.write('retry: 5000\n\n');
    const last = req.headers['last-event-id'];
    if (typeof last === 'string' && last) {
      const c = parseCursor(last);
      if (c.boot === this.bootAt && c.seq !== null) {
        const missed = this.events.toArray().filter((e) => e.id > c.seq!);
        for (const e of missed.slice(-SSE_REPLAY_MAX)) res.write(this.frame(e));
      }
    }
  }

  private broadcast(payload: string): void {
    for (const c of [...this.clients]) {
      try {
        c.res.write(payload);
        if (c.res.writableLength > SSE_BACKLOG_MAX) this.drop(c);
      } catch {
        this.drop(c);
      }
    }
  }

  private drop(c: SseClient): void {
    if (!this.clients.delete(c)) return;
    try {
      c.res.destroy();
    } catch {
      // already gone
    }
  }
}

function errorBody(code: string, message: string): string {
  return JSON.stringify({ v: 1, error: { code, message } });
}

function discovery() {
  return {
    v: 1,
    routes: ['/status', '/config', '/vaults/:id/cycles?since=&limit=&order=', '/vaults/:id/log?n=', '/events', '/healthz'],
  };
}

// the log carries only the winner's reason (keeper.ts:453); the other legs get ''
function triggersFrom(winner: Winner, reason: string): NonNullable<CycleRecord['triggers']> {
  const rebalance = { trigger: winner === 'TRIGGER', reason: '', drift: null as number | null, thresholdTicks: null as number | null, outside: null as boolean | null };
  const refresh = { trigger: winner === 'REFRESH', reason: '', awayTicks: null as number | null };
  const fold = { trigger: winner === 'FOLD', reason: '', minLegShare: null as number | null };
  let m: RegExpExecArray | null;
  if (winner === 'TRIGGER' || winner === 'hold') {
    rebalance.reason = reason;
    if ((m = RE_OUTSIDE.exec(reason))) rebalance.outside = true;
    else if ((m = RE_DRIFT.exec(reason))) {
      rebalance.drift = Number(m[1]);
      rebalance.thresholdTicks = Number(m[2]);
      rebalance.outside = false;
    } else if ((m = RE_INRANGE.exec(reason))) {
      rebalance.drift = Number(m[1]);
      rebalance.thresholdTicks = Number(m[2]);
      rebalance.outside = false;
    }
  } else if (winner === 'REFRESH') {
    refresh.reason = reason;
    if ((m = RE_REFRESH_REASON.exec(reason))) refresh.awayTicks = Number(m[3]);
  } else {
    fold.reason = reason;
    if ((m = RE_FOLD_REASON.exec(reason))) fold.minLegShare = Math.min(1, Math.max(0, Number(m[1]) / 100));
  }
  return { rebalance, refresh, fold };
}

function detailFor(code: OutcomeCode, p: PendingCycle): string {
  switch (code) {
    case 'error':
      return p.error ?? '';
    case 'compound-only':
      return p.compound?.reason ?? p.lastMark ?? 'compound due';
    case 'cooldown':
      return p.cooldownLine ?? '';
    case 'arming':
      return p.armingLine ?? '';
    case 'hold':
      return p.triggers?.rebalance.reason ?? '';
    default:
      return p.lastMark ?? p.gateFail?.reason ?? '';
  }
}

// ---------------------------------------------------------------------------
// module-level hooks: what startKeeper calls. no instance = no-op; an instance
// that throws is counted, never propagated (ethers dispatches block listeners
// via setTimeout with no catch — a throw here would be an unhandled rejection)
// ---------------------------------------------------------------------------

let current: StatusInstance | null = null;

export const status = {
  head(blockNumber: number, busy: boolean): void {
    const c = current;
    if (!c) return;
    try {
      c.onHead(blockNumber, busy);
    } catch {
      c.hookErrors++;
    }
  },
  cycleStart(blockNumber: number, blockTs?: number | null): void {
    const c = current;
    if (!c) return;
    try {
      c.onCycleStart(blockNumber, blockTs);
    } catch {
      c.hookErrors++;
    }
  },
  cycleEnd(blockNumber: number): void {
    const c = current;
    if (!c) return;
    try {
      c.onCycleEnd(blockNumber);
    } catch {
      c.hookErrors++;
    }
  },
  /** an uncaught throw the process survived (index.ts's last-resort handlers) */
  fatal(): void {
    if (current) current.fatalErrors++;
  },
};

export function createStatus(global: GlobalConfig, chain: Chain, vaults: VaultCtx[], opts: StatusOpts = {}): StatusInstance {
  return new StatusInstance(global, chain, vaults, opts);
}

/** STATUS_PORT=0 returns null and installs nothing: byte-identical behaviour */
export function startStatus(global: GlobalConfig, chain: Chain, vaults: VaultCtx[], opts: StatusOpts = {}): StatusInstance | null {
  if (!global.STATUS_PORT) return null;
  const inst = createStatus(global, chain, vaults, opts).install();
  inst.listen(global.STATUS_PORT, global.STATUS_HOST).catch((e: any) => log(`warn: status listener not started (${e?.message ?? e})`));
  return inst;
}
