import { CycleRecord as CycleRecordSchema, type CycleRecord, type OutcomeCode, type GateFailedAt } from '@keeper/record';
import type { Db, Row } from '../db/index';
import { getDb } from '../db/index';
import { getConfig, publicConfig, type UiConfig } from '../config';
import type { KeeperCollectorState } from '../collect/keeper';
import type { MonitorCollectorState } from '../collect/monitor';
import { descriptorEntry, findVault, listVaults, type VaultRow } from '../collect/descriptor';
import { lastReading } from '../collect/chain';
import { anyTickWithin, collectorHealth, nowSec } from '../collect/util';
import { episodeFromRow, gateBlockedSecs, openEpisodeRow } from '../derive/episodes';
import { armedAction, livenessFor, standingV1, worstLiveness } from '../derive/standing';
import { verdictFor } from '../derive/verdict';
import {
  configDrift,
  disagreementsFor,
  findingFromRow,
  sortFindings,
  stalledCheck,
  type FlaggedTx,
  type HeadLite,
  type SampleLite,
} from '../derive/disagree';
import {
  basketHodl,
  basketPerShare,
  burnPerDay,
  cadence,
  composition,
  costPerTx,
  economicsWindow,
  gasRunway,
  human,
  nav1,
  nav1Incl,
  priceHuman,
  priceRaw,
  sharePrice,
  shares,
  spAt,
  type Decimals,
  type EconPoint,
  type RangeSample,
  type TxLite,
  type ZeroBurnEv,
} from '../derive/economics';
import type { CostSource, EventKind, FindingSource, Liveness, TxKind, WindowName } from './enums';
import { PUBLIC_ENUMS } from './enums';
import type {
  Amount,
  ChainEvent,
  ChainSide,
  ConfigV1,
  ConfigValue,
  CycleItem,
  Deposits,
  DiscoveryV1,
  Disagreement,
  DriftRow,
  EconomicsSummary,
  EconomicsV1,
  Episode,
  Finding,
  FlowsV1,
  Gas,
  GateRow,
  GatesV1,
  HealthV1,
  Head,
  KeeperSide,
  KeeperSummary,
  LogV1,
  MonitorSide,
  MonitorV1,
  Price,
  Sample,
  SamplesV1,
  Sources,
  StatusV1,
  TimelineEvent,
  Token,
  TxV1,
  VaultDescriptor,
  VaultDetailV1,
  VaultRef,
  VaultV1,
} from './types';
import { UNITS } from './types';
import { fmtDur, fmtWei, toIso } from './format';

// the only module that turns state into json. everything public is built here,
// once, so the page, the .txt renderer and /api/v1 cannot disagree. bigint and
// BigNumber leave as decimal strings; every chain-derived object carries
// asOf + ageSecs; urls never enter a body (redaction is a property of the
// types, and routes run the value pass over whatever comes out anyway).

export interface StateSources {
  keeper: KeeperCollectorState | null;
  monitor: MonitorCollectorState | null;
  chain: ChainState | null;
}

export interface ChainState {
  ok: boolean;
  head: Head | null;
  fallbackHead: Head | null;
  backfill: { from: number; to: number; done: boolean } | null;
  lastSampleAtMs: number | null;
  detail: string | null;
}

const sources: StateSources = { keeper: null, monitor: null, chain: null };

// index.ts publishes the live collectors here; tests inject fixtures
export function setSources(s: Partial<StateSources> | null): void {
  if (s === null) {
    sources.keeper = null;
    sources.monitor = null;
    sources.chain = null;
    return;
  }
  if ('keeper' in s) sources.keeper = s.keeper ?? null;
  if ('monitor' in s) sources.monitor = s.monitor ?? null;
  if ('chain' in s) sources.chain = s.chain ?? null;
}

export function getSources(): StateSources {
  return sources;
}

export interface Ctx {
  db: Db;
  cfg: UiConfig;
  nowMs: number;
  nowTs: number;
  sources: StateSources;
}

export function ctx(over: Partial<Ctx> = {}): Ctx {
  const nowMs = over.nowMs ?? Date.now();
  return {
    db: over.db ?? getDb(),
    cfg: over.cfg ?? getConfig(),
    nowMs,
    nowTs: over.nowTs ?? Math.trunc(nowMs / 1000),
    sources: over.sources ?? sources,
  };
}

// --- primitives -------------------------------------------------------------

export function iso(tsSecs: number | null | undefined): string | null {
  return tsSecs === null || tsSecs === undefined ? null : new Date(tsSecs * 1000).toISOString();
}

export function isoToTs(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.trunc(t / 1000) : null;
}

export function ageOf(tsSecs: number | null, nowTs: number): number | null {
  return tsSecs === null ? null : Math.max(0, nowTs - tsSecs);
}

// BigNumber | bigint | number | decimal string -> decimal string
export function bigStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v).toString() : null;
  if (typeof v === 'string') return /^-?\d+$/.test(v) ? v : null;
  const o = v as { toString?: () => string; _isBigNumber?: boolean };
  if (typeof o.toString === 'function') {
    const s = o.toString();
    return /^-?\d+$/.test(s) ? s : null;
  }
  return null;
}

export function amount(raw: unknown, decimals: number | null, symbol: string | null): Amount | null {
  const s = bigStr(raw);
  if (s === null || decimals === null) return null;
  return { raw: s, decimals, human: human(s, decimals) ?? 0, symbol: symbol ?? '' };
}

// raw = 1.0001^tick (token1/token0 raw units); human = raw × 10^(d0−d1)
export function price(tick: number, d: Decimals, sym0: string | null, sym1: string | null): Price {
  return {
    raw: priceRaw(tick),
    human: priceHuman(tick, d),
    quote: `${sym1 ?? 'token1'} per ${sym0 ?? 'token0'}`,
  };
}

function numOr(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function intOr(v: unknown): number | null {
  const n = numOr(v);
  return n === null ? null : Math.trunc(n);
}

function boolOr(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return null;
}

function strOr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function cfgNum(cfgv: unknown): number | null {
  if (typeof cfgv === 'number') return Number.isFinite(cfgv) ? cfgv : null;
  if (typeof cfgv === 'string' && /^-?\d+(\.\d+)?$/.test(cfgv)) return Number(cfgv);
  return null;
}

function cfgBool(cfgv: unknown): boolean | null {
  if (typeof cfgv === 'boolean') return cfgv;
  if (typeof cfgv === 'string') {
    if (cfgv === 'true') return true;
    if (cfgv === 'false') return false;
  }
  return null;
}

// --- rows -------------------------------------------------------------------

type SampleRow = Row;

function sampleRow(db: Db, vault: string, order: 'first' | 'last' = 'last'): SampleRow | null {
  return db.get(`SELECT * FROM samples WHERE vault_id = :v ORDER BY ts ${order === 'last' ? 'DESC' : 'ASC'} LIMIT 1`, { v: vault }) ?? null;
}

function sampleNear(db: Db, vault: string, ts: number): SampleRow | null {
  return db.get('SELECT * FROM samples WHERE vault_id = :v ORDER BY ABS(ts - :ts) LIMIT 1', { v: vault, ts }) ?? null;
}

function sampleLite(r: SampleRow | null): SampleLite | null {
  if (!r) return null;
  return {
    ts: intOr(r.ts) ?? 0,
    block: intOr(r.block),
    gateOk: boolOr(r.gate_ok),
    gateFailedAt: strOr(r.gate_failed_at),
    inBase: boolOr(r.in_base),
    baseLower: intOr(r.base_lower),
    baseUpper: intOr(r.base_upper),
  };
}

function parseRecord(json: unknown): CycleRecord | null {
  if (typeof json !== 'string') return null;
  try {
    const p = CycleRecordSchema.safeParse(JSON.parse(json));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

export function lastRecord(c: Ctx, vault: string): CycleRecord | null {
  const k = c.sources.keeper?.status?.vaults.find((v) => v.id === vault);
  if (k?.last) return k.last;
  const raw = c.db.get<{ record_json: string }>('SELECT record_json FROM cycles_raw WHERE vault_id = :v ORDER BY id DESC LIMIT 1', { v: vault });
  const rec = parseRecord(raw?.record_json);
  if (rec) return rec;
  const row = c.db.get<{ record_json: string }>('SELECT record_json FROM cycles WHERE vault_id = :v ORDER BY id DESC LIMIT 1', { v: vault });
  return parseRecord(row?.record_json);
}

function decimalsOf(v: VaultRow): Decimals | null {
  return v.dec0 === null || v.dec1 === null ? null : { d0: v.dec0, d1: v.dec1 };
}

// null, not 0x000…0: the identity read has not landed yet (index.ts needs a provider)
function tokenOf(address: string | null, symbol: string | null, decimals: number | null): Token {
  return { address, symbol: symbol ?? '', decimals };
}

export function vaultRef(v: VaultRow): VaultRef {
  return {
    id: v.id,
    label: v.label,
    pool: v.pool,
    token0: tokenOf(v.token0, v.sym0, v.dec0),
    token1: tokenOf(v.token1, v.sym1, v.dec1),
    tickSpacing: v.tick_spacing && v.tick_spacing > 0 ? v.tick_spacing : 1,
    entrypoint: v.entrypoint === 'proxy' ? 'proxy' : 'direct',
  };
}

export function vaultRefs(c: Ctx): VaultRef[] {
  return listVaults(c.db).map(vaultRef);
}

// --- keeper config ------------------------------------------------------------

export function keeperConfigOf(c: Ctx) {
  return c.sources.keeper?.config ?? c.db.metaGetJson<NonNullable<KeeperCollectorState['config']>>('keeper:config') ?? null;
}

function keeperVaultConfig(c: Ctx, vault: string): Record<string, unknown> | null {
  const kc = keeperConfigOf(c);
  const hit = kc?.vaults.find((v) => String(v.VAULT ?? '').toLowerCase() === vault);
  return (hit as Record<string, unknown> | undefined) ?? null;
}

// keeper /config first, the descriptor second — both are the operator's own numbers, never literals
function setting(c: Ctx, vault: string, key: string): unknown {
  const kv = keeperVaultConfig(c, vault);
  if (kv && kv[key] !== undefined) return kv[key];
  const g = keeperConfigOf(c)?.global as Record<string, unknown> | undefined;
  if (g && g[key] !== undefined) return g[key];
  const d = descriptorEntry(c.db, vault);
  return d[key];
}

// --- chain side ----------------------------------------------------------------

function depositsOf(s: SampleRow, supply: string | null): Deposits {
  const open = boolOr(s.deposits_open);
  const threshold = intOr(s.clearing_threshold);
  const dev = numOr(s.clearing_dev_bps);
  const twapCheck = boolOr(s.clearing_twap_check);
  const paused = boolOr(s.reserve_paused);
  const max = bigStr(s.max_total_supply);
  let reason: string | null = null;
  if (open === false) {
    if (paused) reason = 'clearing paused';
    else if (max !== null && supply !== null && BigInt(max) > 0n && BigInt(supply) >= BigInt(max)) reason = 'supply at maxTotalSupply';
    else if (threshold !== null && dev !== null && dev + 10_000 > threshold) reason = `twap deviation ${Math.round(dev)} bps over threshold ${threshold - 10_000} bps`;
    else reason = 'clearing refuses deposits';
  }
  const inBase = boolOr(s.in_base);
  return {
    state: open === false ? 'blocked' : 'open',
    reason,
    threshold,
    deviationBps: dev,
    twapCheck,
    whitelisted: null,
    note: inBase === false ? 'out of base range' : null,
  };
}

// eth_gasPrice, sampled once per chain pass: the estimate fallback for cost per
// tx has no other source before the first recenter receipt
function gasPriceWei(c: Ctx): bigint | null {
  const raw = c.db.metaGet('chain:gasPriceWei');
  if (!raw) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function gasOf(c: Ctx, vault: string, s: SampleRow | null, txs: TxLite[]): Gas {
  const balance = s ? bigStr(s.gas_wei) : null;
  const floor = gasFloorWei(c, vault);
  const warn = gasWarnWei(c, vault);
  const cost = costPerTx(txs, gasPriceWei(c));
  const burn = burnPerDay(txs, c.nowTs);
  const run = gasRunway(balance, floor, cost.avgCostWei.recenter, burn);
  return {
    signerBalanceWei: balance,
    floorWei: floor,
    warnWei: warn,
    runwayTx: run.runwayTx === null ? null : Math.max(0, Math.trunc(run.runwayTx)),
    runwayDays: run.runwayDays,
    costSource: cost.costSource satisfies CostSource,
  };
}

// unknown -> ConfigValue, so a monitor threshold can be published verbatim
function configValues(src: Record<string, unknown>): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (v !== undefined && typeof v === 'object' && typeof (v as { host?: unknown }).host === 'string') out[k] = { host: (v as { host: string }).host };
    else if (v !== undefined) out[k] = String(v);
  }
  return out;
}

function monitorThreshold(c: Ctx, vault: string, key: string): unknown {
  const m = c.sources.monitor?.vaults[vault];
  return m?.thresholds?.[key];
}

// GAS_WARN_WEI is not a per-pool threshold: one signer, so the monitor carries
// it in its global gas block. without this the header's gas bar has no scale.
function gasWarnWei(c: Ctx, vault: string): string | null {
  return bigStr(monitorThreshold(c, vault, 'GAS_WARN_WEI')) ?? c.sources.monitor?.status?.gas?.warnWei ?? null;
}

// the keeper's own floor first; the monitor's mirror only when the keeper said nothing
function gasFloorWei(c: Ctx, vault: string): string | null {
  return bigStr(setting(c, vault, 'GAS_FLOOR_WEI')) ?? c.sources.monitor?.status?.gas?.floorWei ?? null;
}

// the sampler keeps the fields `samples` has no column for (proxy caps, the
// deposits verdict, the gate it read); absent until the first sample lands
function readingOf(c: Ctx, vault: string) {
  try {
    return lastReading(c.db, vault);
  } catch {
    return null;
  }
}

function capsOf(c: Ctx, vault: string) {
  return readingOf(c, vault)?.caps ?? null;
}

function chainSide(c: Ctx, v: VaultRow, s: SampleRow | null, rec: CycleRecord | null, txs: TxLite[], opts: { compact: boolean }): ChainSide | null {
  const d = decimalsOf(v);
  if (!s || !d) return null;
  const ts = intOr(s.ts) ?? 0;
  const block = intOr(s.block) ?? 0;
  const spotTick = intOr(s.spot_tick);
  if (spotTick === null) return null;
  const P = priceHuman(spotTick, d);
  const baseLower = intOr(s.base_lower) ?? 0;
  const baseUpper = intOr(s.base_upper) ?? 0;
  const limitLower = intOr(s.limit_lower) ?? 0;
  const limitUpper = intOr(s.limit_upper) ?? 0;
  const mid = Math.round((baseLower + baseUpper) / 2);
  const supply = bigStr(s.supply);
  const nav = nav1(bigStr(s.total0), bigStr(s.total1), P, d);
  const comp = composition(
    {
      total0: bigStr(s.total0),
      total1: bigStr(s.total1),
      baseAmt0: bigStr(s.base_amt0),
      baseAmt1: bigStr(s.base_amt1),
      limitAmt0: bigStr(s.limit_amt0),
      limitAmt1: bigStr(s.limit_amt1),
    },
    P,
    d,
  );
  const spacing = v.tick_spacing && v.tick_spacing > 0 ? v.tick_spacing : 1;
  const thrMult = cfgNum(setting(c, v.id, 'REBALANCE_THRESHOLD_MULT'));
  const thresholdTicks = thrMult === null ? (rec?.triggers?.rebalance.thresholdTicks ?? null) : Math.round(thrMult * spacing);
  const outsideBy = spotTick < limitLower ? limitLower - spotTick : spotTick > limitUpper ? spotTick - limitUpper : 0;
  const refreshTicks = cfgNum(setting(c, v.id, 'LIMIT_REFRESH_TICKS'));
  const limitLiq = bigStr(s.limit_liq);
  const side = limitUpper <= mid ? 'below' : limitLower >= mid ? 'above' : null;
  const navIncl = nav1Incl(nav, bigStr(s.fees0), bigStr(s.fees1), P, d);

  return {
    asOf: { block, ts },
    ageSecs: Math.max(0, c.nowTs - ts),
    spotTick,
    price: price(spotTick, d, v.sym0, v.sym1),
    base: {
      lower: baseLower,
      upper: baseUpper,
      inRange: boolOr(s.in_base) ?? (spotTick >= baseLower && spotTick <= baseUpper),
      driftTicks: Math.abs(spotTick - mid),
      thresholdTicks,
    },
    limit: {
      lower: limitLower,
      upper: limitUpper,
      side,
      liquidity: limitLiq ?? '0',
      outsideByTicks: outsideBy,
      stranded: limitLiq === null ? null : BigInt(limitLiq) > 0n && refreshTicks !== null && outsideBy > refreshTicks,
    },
    nav: {
      total0: amount(s.total0, d.d0, v.sym0) ?? { raw: '0', decimals: d.d0, human: 0, symbol: v.sym0 ?? '' },
      total1: amount(s.total1, d.d1, v.sym1) ?? { raw: '0', decimals: d.d1, human: 0, symbol: v.sym1 ?? '' },
      navToken1: nav ?? 0,
      note: 'excludes fees accrued since last poke',
    },
    shares: {
      totalSupply: supply ?? '0',
      sharePriceToken1: sharePrice(navIncl, supply),
      maxTotalSupply: bigStr(s.max_total_supply) ?? '0',
    },
    composition: {
      token0Share: comp?.x ?? 0,
      baseShare: comp?.baseShare ?? 0,
      limitShare: comp?.limitShare ?? 0,
      twoXMinusOne: comp?.twoXMinusOne ?? 0,
    },
    gates: opts.compact ? [] : gateRows(c, v, s, rec),
    caps: capsOf(c, v.id),
    feesOwed:
      s.fees0 === null || s.fees0 === undefined
        ? null
        : {
            fees0: amount(s.fees0, d.d0, v.sym0) ?? { raw: '0', decimals: d.d0, human: 0, symbol: v.sym0 ?? '' },
            fees1: amount(s.fees1, d.d1, v.sym1) ?? { raw: '0', decimals: d.d1, human: 0, symbol: v.sym1 ?? '' },
            asOf: { block, ts },
          },
    idle:
      s.idle0 === null || s.idle0 === undefined
        ? null
        : {
            idle0: amount(s.idle0, d.d0, v.sym0) ?? { raw: '0', decimals: d.d0, human: 0, symbol: v.sym0 ?? '' },
            idle1: amount(s.idle1, d.d1, v.sym1) ?? { raw: '0', decimals: d.d1, human: 0, symbol: v.sym1 ?? '' },
            asOf: { block, ts },
          },
    fee: feeOf(s),
    gas: gasOf(c, v.id, s, txs),
    roles: c.sources.keeper?.status?.vaults.find((x) => x.id === v.id)?.roles ?? null,
    deposits: readingOf(c, v.id)?.deposits ?? depositsOf(s, supply),
  };
}

// slot0.feeProtocol: fp0 = v & 0xf, fp1 = v >> 4; 0 = off, N = 1/N to the protocol
function feeOf(s: SampleRow) {
  const divisor = intOr(s.fee_divisor);
  const fp = intOr(s.fee_protocol);
  if (fp === null) return { divisor, protocolFrac0: null, protocolFrac1: null };
  const fp0 = fp & 0xf;
  const fp1 = fp >> 4;
  return { divisor, protocolFrac0: fp0 === 0 ? 0 : 1 / fp0, protocolFrac1: fp1 === 0 ? 0 : 1 / fp1 };
}

// --- gates ----------------------------------------------------------------------

interface GateRowIn {
  gate: string;
  enabled: boolean;
  reading: string | number | boolean | null;
  limit: string | number | boolean | null;
  op: string | null;
  ratio: number | null;
  verdict: string;
  keeperSaw: string | number | boolean | null;
  agrees: boolean | null;
}

function row(r: GateRowIn): GateRow {
  return r;
}

// `=` when the keeper's own value matches the as-of reading, the number when it
// differs, null when the keeper never evaluated that gate (lazy, display-only)
function saw(chain: number | null, keeper: number | null): { keeperSaw: string | number | null; agrees: boolean | null } {
  if (keeper === null) return { keeperSaw: null, agrees: null };
  if (chain === null) return { keeperSaw: keeper, agrees: null };
  return chain === keeper ? { keeperSaw: '=', agrees: true } : { keeperSaw: keeper, agrees: false };
}

export function gateRows(c: Ctx, v: VaultRow, s: SampleRow | null, rec: CycleRecord | null): GateRow[] {
  const id = v.id;
  const out: GateRow[] = [];
  const spacing = v.tick_spacing && v.tick_spacing > 0 ? v.tick_spacing : 1;
  const spot = s ? intOr(s.spot_tick) : null;
  const baseLower = s ? intOr(s.base_lower) : null;
  const baseUpper = s ? intOr(s.base_upper) : null;
  const mid = baseLower !== null && baseUpper !== null ? Math.round((baseLower + baseUpper) / 2) : null;
  const drift = spot !== null && mid !== null ? Math.abs(spot - mid) : null;
  const thrMult = cfgNum(setting(c, id, 'REBALANCE_THRESHOLD_MULT'));
  const threshold = thrMult === null ? (rec?.triggers?.rebalance.thresholdTicks ?? null) : Math.round(thrMult * spacing);
  out.push(
    row({
      gate: 'drift',
      enabled: true,
      reading: drift === null ? null : `${drift} tk`,
      limit: threshold === null ? null : `> ${threshold}`,
      op: '>',
      ratio: drift !== null && threshold ? drift / threshold : null,
      verdict: drift !== null && threshold !== null ? (drift > threshold ? 'TRIGGER' : 'ok') : '-',
      ...saw(drift, rec?.triggers?.rebalance.drift ?? null),
    }),
  );

  const dwellReq = cfgNum(setting(c, id, 'DWELL_SECS'));
  const leg = rec ? (rec.winner === 'REFRESH' ? rec.dwell.refresh : rec.winner === 'FOLD' ? rec.dwell.fold : rec.dwell.rebalance) : null;
  out.push(
    row({
      gate: 'dwell',
      enabled: true,
      reading: leg ? `${fmtDur(leg.heldSecs)} held` : null,
      limit: leg ? `>= ${fmtDur(leg.requiredSecs)}` : dwellReq === null ? null : `>= ${fmtDur(dwellReq)}`,
      op: '>=',
      ratio: leg && leg.requiredSecs > 0 ? leg.heldSecs / leg.requiredSecs : null,
      verdict: leg ? (leg.armed ? 'armed' : 'holding') : '-',
      keeperSaw: leg ? '=' : null,
      agrees: leg ? true : null,
    }),
  );

  const cd = rec?.cooldown ?? null;
  const caps = capsOf(c, id);
  const minInterval = cd?.minIntervalSecs ?? caps?.minIntervalSecs ?? cfgNum(setting(c, id, 'MIN_INTERVAL_SECS'));
  const sinceLast = s ? (intOr(s.proxy_last_rebalance_ts) ? c.nowTs - (intOr(s.proxy_last_rebalance_ts) as number) : null) : null;
  out.push(
    row({
      gate: 'cooldown',
      enabled: true,
      reading: sinceLast === null ? (cd?.elapsedSecs === null || cd?.elapsedSecs === undefined ? null : `${fmtDur(cd.elapsedSecs)} since`) : `${fmtDur(sinceLast)} since`,
      limit: minInterval === null ? null : `>= ${fmtDur(minInterval)}`,
      op: '>=',
      ratio: sinceLast !== null && minInterval ? sinceLast / minInterval : null,
      verdict: cd ? (cd.skipped ? 'BLOCKED' : 'ok') : '-',
      keeperSaw: cd?.evaluated ? '=' : null,
      agrees: cd?.evaluated ? true : null,
    }),
  );

  const twapEnabled = cfgBool(setting(c, id, 'TWAP_ENABLED')) ?? true;
  const twapWindow = s ? intOr(s.twap_window) : null;
  const minTwap = cfgNum(setting(c, id, 'MIN_TWAP_WINDOW_SECS'));
  out.push(
    row({
      gate: 'twap window',
      enabled: twapEnabled,
      reading: twapWindow === null ? null : `${twapWindow}s`,
      limit: minTwap === null ? null : `>= ${minTwap}s`,
      op: '>=',
      ratio: twapWindow !== null && minTwap ? twapWindow / minTwap : null,
      verdict: twapWindow !== null && minTwap !== null ? (twapWindow >= minTwap ? 'ok' : 'FAIL') : '-',
      ...saw(twapWindow, rec?.gate?.twap?.windowSecs ?? null),
    }),
  );

  const twapTick = s ? intOr(s.twap_tick) : null;
  const oracleTick = s ? intOr(s.oracle_tick) : null;
  const maxDev = cfgNum(setting(c, id, 'MAX_DEV_TICKS'));
  const spotVsTwap = spot !== null && twapTick !== null ? Math.abs(spot - twapTick) : null;
  out.push(
    row({
      gate: 'spot vs twap',
      enabled: twapEnabled,
      reading: spotVsTwap === null ? null : `${spotVsTwap} tk`,
      limit: maxDev === null ? null : `<= ${maxDev}`,
      op: '<=',
      ratio: spotVsTwap !== null && maxDev ? spotVsTwap / maxDev : null,
      verdict: spotVsTwap !== null && maxDev !== null ? (spotVsTwap <= maxDev ? 'ok' : 'FAIL') : '-',
      ...saw(spotVsTwap, rec?.gate?.twap?.devTicks ?? null),
    }),
  );

  const oracleEnabled = cfgBool(setting(c, id, 'ORACLE_ENABLED')) ?? true;
  const maxOracleDev = cfgNum(setting(c, id, 'ORACLE_MAX_DEV_TICKS'));
  const twapVsOracle = twapTick !== null && oracleTick !== null ? Math.abs(twapTick - oracleTick) : null;
  out.push(
    row({
      gate: 'twap vs oracle',
      enabled: oracleEnabled,
      reading: twapVsOracle === null ? null : `${twapVsOracle} tk`,
      limit: maxOracleDev === null ? null : `<= ${maxOracleDev}`,
      op: '<=',
      ratio: twapVsOracle !== null && maxOracleDev ? twapVsOracle / maxOracleDev : null,
      verdict: twapVsOracle !== null && maxOracleDev !== null ? (twapVsOracle <= maxOracleDev ? 'ok' : 'FAIL') : '-',
      ...saw(twapVsOracle, rec?.gate?.oracle?.devTicks ?? null),
    }),
  );

  // info only: its gap to `twap vs oracle` is the twap-lag diagnosis
  const spotVsOracle = spot !== null && oracleTick !== null ? Math.abs(spot - oracleTick) : null;
  out.push(
    row({
      gate: 'spot vs oracle',
      enabled: oracleEnabled,
      reading: spotVsOracle === null ? null : `${spotVsOracle} tk`,
      limit: '(info)',
      op: null,
      ratio: spotVsOracle !== null && maxOracleDev ? spotVsOracle / maxOracleDev : null,
      verdict: spotVsOracle === null || maxOracleDev === null ? '-' : spotVsOracle <= maxOracleDev ? 'agrees' : 'differs',
      keeperSaw: null,
      agrees: null,
    }),
  );

  const oracleAge = s ? intOr(s.oracle_age) : null;
  const maxAge = cfgNum(setting(c, id, 'ORACLE_MAX_AGE_SECS'));
  out.push(
    row({
      gate: 'oracle age',
      enabled: oracleEnabled,
      reading: oracleAge === null ? null : `${oracleAge}s`,
      limit: maxAge === null ? null : `<= ${maxAge}`,
      op: '<=',
      ratio: oracleAge !== null && maxAge ? oracleAge / maxAge : null,
      verdict: oracleAge !== null && maxAge !== null ? (oracleAge <= maxAge ? 'ok' : 'FAIL') : '-',
      ...saw(oracleAge, rec?.gate?.oracle?.ageSecs ?? null),
    }),
  );

  out.push(
    row({
      gate: 'feed',
      enabled: oracleEnabled,
      reading: oracleTick === null ? 'unreadable' : 'readable',
      limit: 'readable',
      op: null,
      ratio: null,
      verdict: oracleTick === null ? 'FAIL' : 'ok',
      keeperSaw: rec?.gate?.failedAt === 'oracle-unreadable' ? 'unreadable' : rec?.gate?.oracle ? '=' : null,
      agrees: rec?.gate?.oracle ? true : null,
    }),
  );

  const paused = s ? boolOr(s.reserve_paused) : null;
  out.push(
    row({
      gate: 'reserve pause',
      enabled: true,
      reading: paused === null ? null : paused ? 'paused' : 'not paused',
      limit: 'not paused',
      op: null,
      ratio: null,
      verdict: paused === null ? '-' : paused ? 'FAIL' : 'ok',
      keeperSaw: null,
      agrees: null,
    }),
  );

  // keeper-says only: volBaseline and the price trail live in the signing process
  const kv = c.sources.keeper?.status?.vaults.find((x) => x.id === id) ?? null;
  const volRatio = null; // the keeper publishes the baseline, not the ratio; increment 7 records it
  const volLimit = cfgNum(setting(c, id, 'VOL_RATIO_ELEVATED'));
  const regimeEnabled = cfgBool(setting(c, id, 'REGIME_ENABLED')) ?? true;
  out.push(
    row({
      gate: 'vol ratio',
      enabled: regimeEnabled,
      reading: kv?.state.volBaseline ? `median ${kv.state.volBaseline.median}` : null,
      limit: volLimit === null ? null : `< ${volLimit}x`,
      op: '<',
      ratio: volRatio,
      verdict: kv?.state.regime.regime ?? '-',
      keeperSaw: kv?.state.volBaseline ? '=' : null,
      agrees: null,
    }),
  );

  const move15 = kv?.state.priceTrail.move15mFrac ?? null;
  const move15Limit = cfgNum(setting(c, id, 'MOVE_15M_ELEVATED'));
  out.push(
    row({
      gate: 'move 15m',
      enabled: regimeEnabled,
      reading: move15 === null ? null : `${(move15 * 100).toFixed(1)}%`,
      limit: move15Limit === null ? null : `< ${(move15Limit * 100).toFixed(1)}%`,
      op: '<',
      ratio: move15 !== null && move15Limit ? move15 / move15Limit : null,
      verdict: move15 === null || move15Limit === null ? '-' : move15 < move15Limit ? 'calm' : 'elevated',
      keeperSaw: move15 === null ? null : '=',
      agrees: null,
    }),
  );

  const move1h = kv?.state.priceTrail.move1hFrac ?? null;
  const move1hLimit = cfgNum(setting(c, id, 'MOVE_1H_EXTREME'));
  out.push(
    row({
      gate: 'move 1h',
      enabled: regimeEnabled,
      reading: move1h === null ? null : `${(move1h * 100).toFixed(1)}%`,
      limit: move1hLimit === null ? null : `< ${(move1hLimit * 100).toFixed(1)}%`,
      op: '<',
      ratio: move1h !== null && move1hLimit ? move1h / move1hLimit : null,
      verdict: move1h === null || move1hLimit === null ? '-' : move1h < move1hLimit ? 'calm' : 'extreme',
      keeperSaw: move1h === null ? null : '=',
      agrees: null,
    }),
  );

  const gasWei = s ? bigStr(s.gas_wei) : null;
  const floor = gasFloorWei(c, id);
  out.push(
    row({
      gate: 'gas',
      enabled: true,
      reading: gasWei === null ? null : fmtWei(gasWei),
      limit: floor === null ? null : `>= ${fmtWei(floor)}`,
      op: '>=',
      ratio: gasWei !== null && floor !== null && BigInt(floor) > 0n ? Number(BigInt(gasWei) * 1000n / BigInt(floor)) / 1000 : null,
      verdict: gasWei !== null && floor !== null ? (BigInt(gasWei) >= BigInt(floor) ? 'ok' : 'FAIL') : '-',
      keeperSaw: rec?.outcome.code === 'gas-floor' ? 'below floor' : null,
      agrees: null,
    }),
  );

  out.push(
    row({
      gate: 'translation',
      enabled: caps !== null,
      reading: null,
      limit: caps === null ? null : `<= ${caps.maxTranslation}`,
      op: '<=',
      ratio: null,
      verdict: rec?.outcome.code === 'clamp-unworkable' ? 'FAIL' : caps === null ? '-' : 'ok',
      keeperSaw: null,
      agrees: null,
    }),
  );

  out.push(
    row({
      gate: 'width delta',
      enabled: caps !== null,
      reading: null,
      limit: caps === null ? null : `<= ${caps.maxWidth}`,
      op: '<=',
      ratio: null,
      verdict: rec?.outcome.code === 'width-cap' ? 'FAIL' : caps === null ? '-' : 'ok',
      keeperSaw: null,
      agrees: null,
    }),
  );

  out.push(
    row({
      gate: 'preflight',
      enabled: true,
      reading: rec?.outcome.code === 'preflight-revert' ? 'revert' : 'not run',
      limit: null,
      op: null,
      ratio: null,
      verdict: rec?.outcome.code === 'preflight-revert' ? 'FAIL' : '-',
      keeperSaw: null,
      agrees: null,
    }),
  );

  return out;
}

// --- keeper side ------------------------------------------------------------------

function txLites(db: Db, vault: string, sinceTs = 0): TxLite[] {
  const rows = db.all<Row>('SELECT hash, kind, ts, gas_used, gas_price_wei, cost_wei FROM txs WHERE vault_id = :v AND ts >= :s ORDER BY ts', { v: vault, s: sinceTs });
  return rows.map((r) => ({
    hash: String(r.hash),
    kind: (strOr(r.kind) ?? 'unknown') as TxKind,
    ts: intOr(r.ts) ?? 0,
    gasUsed: intOr(r.gas_used),
    gasPriceWei: bigStr(r.gas_price_wei),
    costWei: bigStr(r.cost_wei),
  }));
}

function keeperSide(c: Ctx, v: VaultRow, rec: CycleRecord | null, opts: { compact: boolean }): KeeperSide {
  const k = c.sources.keeper;
  const kv = k?.status?.vaults.find((x) => x.id === v.id) ?? null;
  const reachable = k?.reachable ?? false;
  const asOf = rec ? { block: rec.block, ts: rec.blockTs } : null;
  const open = openEpisodeRow(c.db, v.id);
  const standingSrc = kv?.standing
    ? { code: kv.standing.code, subcode: kv.standing.subcode, sinceTs: kv.standing.sinceTs, seq: kv.standing.seq }
    : open
      ? { code: open.code, subcode: open.subcode, sinceTs: open.sinceTs, seq: open.lastSeq }
      : null;
  const compoundInterval = cfgNum(setting(c, v.id, 'COMPOUND_INTERVAL_SECS'));
  const lastCompoundTs = kv?.state.lastCompoundTs ?? null;
  const lastTx = c.db.get<Row>('SELECT hash, kind, ts FROM txs WHERE vault_id = :v ORDER BY ts DESC LIMIT 1', { v: v.id });
  const lastErr = c.db.get<Row>("SELECT block, block_ts, error FROM cycles WHERE vault_id = :v AND error IS NOT NULL ORDER BY id DESC LIMIT 1", { v: v.id });
  // the regime is advanced lazily (keeper.ts:485), so a quiet cycle carries none:
  // the age comes from the last cycle that actually evaluated one
  const regimeAt = rec?.regime
    ? rec.evaluatedAt
    : (() => {
        const r = c.db.get<Row>('SELECT evaluated_at, block_ts FROM cycles WHERE vault_id = :v AND regime IS NOT NULL ORDER BY id DESC LIMIT 1', { v: v.id });
        const ts = r ? (intOr(r.evaluated_at) ?? intOr(r.block_ts)) : null;
        return ts === null ? null : toIso(ts * 1000);
      })();

  return {
    reachable,
    asOf,
    ageSecs: asOf ? Math.max(0, c.nowTs - asOf.ts) : null,
    action: armedAction(rec),
    outcome: rec?.outcome ?? null,
    standing: standingV1(standingSrc, c.nowTs, open?.cycles ?? null),
    dwell: rec?.dwell ?? null,
    cooldown: rec?.cooldown ?? null,
    gateSaw: rec?.gate ?? null,
    regime: kv
      ? {
          regime: kv.state.regime.regime,
          sinceTs: kv.state.regime.sinceTs,
          lastEvaluatedAt: regimeAt,
          inputs: {
            volRatio: null,
            move15mFrac: kv.state.priceTrail.move15mFrac,
            move1hFrac: kv.state.priceTrail.move1hFrac,
          },
        }
      : rec?.regime
        ? { regime: rec.regime.regime, sinceTs: rec.regime.sinceTs, lastEvaluatedAt: rec.evaluatedAt, inputs: { volRatio: null, move15mFrac: null, move1hFrac: null } }
        : null,
    compound:
      rec || kv
        ? {
            due: rec?.compoundDue ?? false,
            dueInSecs: compoundInterval !== null && lastCompoundTs ? Math.max(0, lastCompoundTs + compoundInterval - c.nowTs) : null,
            lastTs: lastCompoundTs && lastCompoundTs > 0 ? lastCompoundTs : null,
          }
        : null,
    lastTx: lastTx
      ? { hash: String(lastTx.hash), kind: (strOr(lastTx.kind) ?? 'unknown') as TxKind, ts: intOr(lastTx.ts) }
      : rec?.tx
        ? { hash: rec.tx.hash, kind: rec.tx.kind, ts: rec.blockTs }
        : null,
    lastError: lastErr
      ? { at: toIso((intOr(lastErr.block_ts) ?? 0) * 1000), block: intOr(lastErr.block) ?? 0, message: strOr(lastErr.error) ?? 'error' }
      : null,
    config: opts.compact ? null : ((keeperVaultConfig(c, v.id) as KeeperSide['config']) ?? null),
  };
}

function monitorSide(c: Ctx, v: VaultRow, opts: { compact: boolean }): MonitorSide {
  const m = c.sources.monitor;
  const cache = m?.vaults[v.id] ?? null;
  const checkedAt = cache?.snapshot?.checkedAt ?? m?.status?.lastCycleAt ?? null;
  const ts = isoToTs(checkedAt);
  return {
    reachable: m?.reachable ?? false,
    asOf: checkedAt,
    ageSecs: ageOf(ts, c.nowTs),
    stale: m?.findingsStale ?? false,
    firing: cache?.firing ?? [],
    snapshot: opts.compact ? null : (cache?.snapshot ?? null),
  };
}

// --- verdict, liveness, disagreements ---------------------------------------------

function headLite(h: Head | null): HeadLite | null {
  if (!h) return null;
  const at = isoToTs(h.at);
  return at === null ? null : { number: h.number, atTs: at };
}

// a cycle mid-submit has no record yet (the keeper finalises it after tx.wait),
// so `acting` is read off the newest log line inside the busy window
const RE_SUBMITTING = /^(submitting rebalance via |compound submitted )/;

function submittingNow(c: Ctx, vault: string, busySinceTs: number | null): boolean {
  if (busySinceTs === null) return false;
  const r = c.db.get<Row>('SELECT ts, line FROM keeper_lines WHERE vault_id = :v ORDER BY id DESC LIMIT 1', { v: vault });
  if (!r) return false;
  const ts = intOr(r.ts);
  if (ts === null || ts < busySinceTs - 5) return false;
  return RE_SUBMITTING.test((strOr(r.line) ?? '').trim());
}

function flaggedTxs(db: Db, vault: string): FlaggedTx[] {
  const rows = db.all<Row>('SELECT hash, ts, full_range, foreign_recipient FROM txs WHERE vault_id = :v AND (full_range = 1 OR foreign_recipient = 1) ORDER BY ts DESC LIMIT 20', {
    v: vault,
  });
  return rows.map((r) => ({ hash: String(r.hash), ts: intOr(r.ts) ?? 0, fullRange: boolOr(r.full_range) ?? false, foreignRecipient: boolOr(r.foreign_recipient) ?? false }));
}

export function vaultV1(c: Ctx, v: VaultRow, opts: { compact?: boolean } = {}): VaultV1 {
  const compact = opts.compact ?? false;
  const rec = lastRecord(c, v.id);
  const s = sampleRow(c.db, v.id);
  const txs = txLites(c.db, v.id, c.nowTs - 30 * 86400);
  const chain = chainSide(c, v, s, rec, txs, { compact });
  const keeper = keeperSide(c, v, rec, { compact });
  const monitor = monitorSide(c, v, { compact });

  const k = c.sources.keeper;
  const uiHead = headLite(c.sources.chain?.head ?? null);
  const fallbackHead = headLite(c.sources.chain?.fallbackHead ?? null);
  const keeperHeadAt = isoToTs(k?.status?.keeper.head?.at ?? null);
  const keeperRpcHost = k?.status?.keeper.rpcHost ?? null;
  const stalled = stalledCheck({
    keeperHead: k?.status?.keeper.head ? { number: k.status.keeper.head.number, atTs: keeperHeadAt ?? 0 } : null,
    busySinceTs: isoToTs(k?.status?.keeper.busySinceAt ?? null),
    uiHead,
    fallbackHead,
    chainRpcShared: keeperRpcHost !== null && keeperRpcHost === c.cfg.rpcHost,
    fallbackShared: keeperRpcHost !== null && keeperRpcHost === c.cfg.headFallbackHost,
    nowTs: c.nowTs,
  });

  const monitorOverdue = monitor.firing.some((f) => f.key === 'rebalance-overdue');
  const busySinceTs = isoToTs(k?.status?.keeper.busySinceAt ?? null);
  const liveness = livenessFor({
    configured: c.cfg.keeperConfigured,
    reachable: keeper.reachable,
    misses: k?.consecutiveFailures ?? 0,
    nowTs: c.nowTs,
    bootAtTs: isoToTs(k?.bootAt ?? null),
    headAtTs: keeperHeadAt,
    busySinceTs,
    submitting: submittingNow(c, v.id, busySinceTs),
    record: rec,
    standing: keeper.standing ? { code: keeper.standing.code, subcode: keeper.standing.subcode } : null,
    monitorOverdue,
    stalledEvidence: stalled !== null,
  });

  const descriptor = descriptorEntry(c.db, v.id);
  const disagreements: Disagreement[] = disagreementsFor(
    {
      id: v.id,
      label: v.label,
      record: rec,
      sampleNearRecord: rec ? sampleLite(sampleNear(c.db, v.id, rec.blockTs)) : null,
      latestSample: sampleLite(s),
      monitorFiring: monitor.firing,
      monitorCheckedAtTs: isoToTs(monitor.asOf),
      flaggedTxs: flaggedTxs(c.db, v.id),
      descriptorLive: cfgBool(descriptor.DRY_RUN) !== true,
    },
    c.nowTs,
  );

  const monitorCritical = monitor.firing.find((f) => f.severity === 'critical')?.title ?? null;
  const verdict = verdictFor({
    configured: c.cfg.keeperConfigured,
    standing: keeper.standing ? { code: keeper.standing.code, subcode: keeper.standing.subcode } : null,
    detail: rec?.outcome.detail ?? null,
    sinceTs: keeper.standing?.sinceTs ?? null,
    nowTs: c.nowTs,
    liveness,
    winner: rec?.winner ?? null,
    dwell: rec?.dwell ?? null,
    spotTick: chain?.spotTick ?? rec?.reads?.spotTick ?? null,
    gate: rec?.gate ?? null,
    compoundDueInSecs: keeper.compound?.dueInSecs ?? null,
    dryRunLive: (k?.status?.keeper.mode ?? null) === 'DRY_RUN' && cfgBool(descriptor.DRY_RUN) !== true,
    monitorCritical,
    disagreements: disagreements.length,
    unreachableSinceTs: k?.unreachableSince ?? null,
    stalled,
  });

  return {
    id: v.id,
    label: v.label,
    pair: `${v.sym0 ?? '?'}/${v.sym1 ?? '?'}`,
    pool: v.pool,
    tickSpacing: v.tick_spacing && v.tick_spacing > 0 ? v.tick_spacing : 1,
    entrypoint: v.entrypoint === 'proxy' ? 'proxy' : 'direct',
    verdict,
    liveness,
    keeper,
    chain,
    monitor,
    disagreements,
    economics: compact ? null : economicsSummary(c, v),
  };
}

// --- status ---------------------------------------------------------------------

function sourceStates(c: Ctx): Sources {
  const k = c.sources.keeper;
  const m = c.sources.monitor;
  const ch = c.sources.chain;
  return {
    keeper: {
      configured: c.cfg.keeperConfigured,
      reachable: k?.reachable ?? false,
      asOf: iso(k?.statusAt ?? null),
      ageSecs: ageOf(k?.statusAt ?? null, c.nowTs),
      unreachableSince: iso(k?.unreachableSince ?? null),
      detail: k?.detail ?? null,
    },
    monitor: {
      configured: c.cfg.monitorConfigured,
      reachable: m?.reachable ?? false,
      asOf: iso(m?.statusAt ?? null),
      ageSecs: ageOf(m?.statusAt ?? null, c.nowTs),
      unreachableSince: iso(m?.unreachableSince ?? null),
      detail: m?.detail ?? null,
    },
    chain: {
      ok: ch?.ok ?? false,
      rpcHost: c.cfg.rpcHost,
      head: ch?.head ?? null,
      fallbackHead: ch?.fallbackHead ?? null,
      backfill: ch?.backfill ?? null,
    },
    ui: { ssr: true, commit: c.cfg.COMMIT ?? null },
  };
}

function keeperSummary(c: Ctx, vaults: VaultV1[]): KeeperSummary {
  const k = c.sources.keeper;
  const st = k?.status ?? null;
  const gas = vaults.find((v) => v.chain?.gas)?.chain?.gas ?? null;
  const liveness: Liveness = vaults.length ? worstLiveness(vaults.map((v) => v.liveness)) : k?.reachable ? 'alive' : 'unreachable';
  return {
    configured: c.cfg.keeperConfigured,
    reachable: k?.reachable ?? false,
    mode: st?.keeper.mode ?? null,
    version: st?.keeper.version ?? null,
    bootAt: st?.keeper.bootAt ?? null,
    signer: st?.keeper.signer ?? null,
    rpcHost: st?.keeper.rpcHost ?? null,
    head: st?.keeper.head ? { number: st.keeper.head.number, ts: st.keeper.head.ts, at: st.keeper.head.at } : null,
    busy: st?.keeper.busy ?? null,
    busySinceAt: st?.keeper.busySinceAt ?? null,
    skippedWhileBusy: st?.keeper.skippedWhileBusy ?? null,
    cyclesTotal: st?.keeper.cyclesTotal ?? null,
    errorsTotal: st?.keeper.errorsTotal ?? null,
    hookErrors: st?.keeper.hookErrors ?? null,
    configFingerprint: st?.keeper.configFingerprint ?? null,
    gas,
    liveness,
  };
}

export function findings(c: Ctx, o: { active?: boolean; vault?: string | null; sinceId?: number; limit?: number } = {}): Finding[] {
  const stale = new Set<FindingSource>();
  if (c.sources.monitor?.findingsStale) stale.add('monitor');
  const where: string[] = ['1 = 1'];
  const params: Record<string, string | number | null> = {};
  if (o.active) where.push('cleared_ts IS NULL');
  if (o.vault !== undefined && o.vault !== null) {
    where.push('vault_id = :v');
    params.v = o.vault;
  }
  if (o.sinceId !== undefined) {
    where.push('id > :sinceId');
    params.sinceId = o.sinceId;
  }
  params.limit = o.limit ?? 200;
  const rows = c.db.all<Row>(`SELECT * FROM findings WHERE ${where.join(' AND ')} ORDER BY id LIMIT :limit`, params);
  return sortFindings(rows.map((r) => findingFromRow(r, stale)));
}

export interface StatusOptions {
  vault?: string | null;
  compact?: boolean;
}

export function statusBody(c: Ctx, o: StatusOptions = {}): StatusV1 {
  const all = listVaults(c.db);
  // ?vault= takes the same key the paths do: lowercase address or label slug
  const one = o.vault ? findVault(c.db, o.vault) : null;
  const wanted = o.vault ? all.filter((v) => v.id === one?.id) : all;
  const vaults = wanted.map((v) => vaultV1(c, v, { compact: o.compact ?? false }));
  return {
    v: 1,
    generatedAt: toIso(c.nowMs),
    sources: sourceStates(c),
    keeper: keeperSummary(c, vaults),
    vaults,
    findings: findings(c, { active: true, limit: 200 }),
  };
}

// W/"<keeperBootAt>-<keeperSeq>-<monitorCycleTs>-<sampleTs>"
export function statusEtagParts(c: Ctx): Array<string | number | null> {
  const k = c.sources.keeper;
  const seq = k?.status?.vaults.reduce((m, v) => Math.max(m, v.last?.seq ?? v.ring.lastSeq), 0) ?? 0;
  const monitorTs = isoToTs(c.sources.monitor?.status?.lastCycleAt ?? null);
  const sample = c.db.get<{ ts: number }>('SELECT MAX(ts) AS ts FROM samples');
  const findingId = c.db.get<{ id: number }>('SELECT MAX(id) AS id FROM findings');
  return [k?.bootAt ?? null, seq, monitorTs, sample?.ts ?? null, findingId?.id ?? null];
}

export function vaultDetail(c: Ctx, v: VaultRow): VaultDetailV1 {
  const cycles = c.db
    .all<Row>('SELECT * FROM cycles WHERE vault_id = :v ORDER BY id DESC LIMIT 20', { v: v.id })
    .map(cycleItem)
    .filter((x): x is CycleItem => x !== null)
    .reverse();
  const txs = c.db.all<Row>('SELECT * FROM txs WHERE vault_id = :v ORDER BY ts DESC LIMIT 10', { v: v.id }).map(txV1);
  return { v: 1, generatedAt: toIso(c.nowMs), vault: vaultV1(c, v), cycles, txs };
}

export function gatesBody(c: Ctx, v: VaultRow): GatesV1 {
  const s = sampleRow(c.db, v.id);
  const rec = lastRecord(c, v.id);
  const open = openEpisodeRow(c.db, v.id);
  const code: OutcomeCode | null = open?.code ?? rec?.outcome.code ?? null;
  const subcode: GateFailedAt | null = open?.subcode ?? (rec?.gate && !rec.gate.ok ? rec.gate.failedAt : null);
  const blocks: string[] = [];
  if (rec) {
    if (rec.winner && rec.winner !== 'hold') blocks.push(rec.winner === 'TRIGGER' ? 'recenter' : rec.winner === 'REFRESH' ? 'limit refresh' : 'fold at balance');
    if (rec.compoundDue) blocks.push('compound sweep');
  }
  return {
    v: 1,
    generatedAt: toIso(c.nowMs),
    vault: v.id,
    asOf: s ? { block: intOr(s.block) ?? 0, ts: intOr(s.ts) ?? 0 } : null,
    keeperSawAt: rec?.evaluatedAt ?? null,
    rows: gateRows(c, v, s, rec),
    holding: code === null ? null : { code, subcode, sinceTs: open?.sinceTs ?? rec?.blockTs ?? 0, blocks },
  };
}

// --- history rows ------------------------------------------------------------------

export function cursorOf(id: number): string {
  return `c:${id}`;
}

export function parseCursor(s: string | undefined): { id: number | null; ts: number | null } {
  if (!s) return { id: null, ts: null };
  const m = /^c:(\d+)$/.exec(s);
  if (m) return { id: Number(m[1]), ts: null };
  if (/^\d+$/.test(s)) return { id: null, ts: Number(s) };
  const t = Date.parse(s);
  return { id: null, ts: Number.isFinite(t) ? Math.trunc(t / 1000) : null };
}

export function cycleItem(r: Row): CycleItem | null {
  const rec = parseRecord(r.record_json);
  if (!rec) return null;
  return {
    id: intOr(r.id) ?? 0,
    cursor: cursorOf(intOr(r.id) ?? 0),
    receivedAt: toIso((intOr(r.block_ts) ?? 0) * 1000),
    isTransition: boolOr(r.is_transition) ?? true,
    record: rec,
  };
}

export function txV1(r: Row): TxV1 {
  const plan = (() => {
    if (typeof r.plan_json !== 'string') return null;
    try {
      return JSON.parse(r.plan_json) as TxV1['plan'];
    } catch {
      return null;
    }
  })();
  const base = intOr(r.base_lower) !== null && intOr(r.base_upper) !== null ? ([intOr(r.base_lower) as number, intOr(r.base_upper) as number] as [number, number]) : null;
  const lim = intOr(r.limit_lower) !== null && intOr(r.limit_upper) !== null ? ([intOr(r.limit_lower) as number, intOr(r.limit_upper) as number] as [number, number]) : null;
  return {
    hash: String(r.hash),
    vault: String(r.vault_id),
    kind: (strOr(r.kind) ?? 'unknown') as TxKind,
    block: intOr(r.block) ?? 0,
    ts: intOr(r.ts) ?? 0,
    from: strOr(r.from_addr),
    gasUsed: intOr(r.gas_used),
    gasPriceWei: bigStr(r.gas_price_wei),
    costWei: bigStr(r.cost_wei),
    costSource: r.cost_wei === null || r.cost_wei === undefined ? 'estimate' : 'receipts',
    status: intOr(r.status),
    tick: intOr(r.tick),
    total0: bigStr(r.total0),
    total1: bigStr(r.total1),
    supply: bigStr(r.supply),
    base,
    limit: lim,
    feeRecipient: strOr(r.fee_recipient),
    flags: { fullRange: boolOr(r.full_range) ?? false, foreignRecipient: boolOr(r.foreign_recipient) ?? false },
    plan,
  };
}

export function episodeItem(r: Row, nowTs: number): Episode {
  return episodeFromRow(r, nowTs);
}

const SAMPLE_COLUMNS: ReadonlyArray<[keyof Sample, string]> = [
  ['ts', 'ts'],
  ['block', 'block'],
  ['spotTick', 'spot_tick'],
  ['sqrtPriceX96', 'sqrt_price_x96'],
  ['priceHuman', 'price_human'],
  ['total0', 'total0'],
  ['total1', 'total1'],
  ['supply', 'supply'],
  ['maxTotalSupply', 'max_total_supply'],
  ['nav1', 'nav1'],
  ['sharePrice', 'share_price'],
  ['x', 'x'],
  ['baseLower', 'base_lower'],
  ['baseUpper', 'base_upper'],
  ['limitLower', 'limit_lower'],
  ['limitUpper', 'limit_upper'],
  ['inBase', 'in_base'],
  ['inLimit', 'in_limit'],
  ['baseLiq', 'base_liq'],
  ['baseAmt0', 'base_amt0'],
  ['baseAmt1', 'base_amt1'],
  ['limitLiq', 'limit_liq'],
  ['limitAmt0', 'limit_amt0'],
  ['limitAmt1', 'limit_amt1'],
  ['fees0', 'fees0'],
  ['fees1', 'fees1'],
  ['fees1Value', 'fees1_value'],
  ['idle0', 'idle0'],
  ['idle1', 'idle1'],
  ['oracleTick', 'oracle_tick'],
  ['oraclePrice', 'oracle_price'],
  ['oracleAge', 'oracle_age'],
  ['twapTick', 'twap_tick'],
  ['twapWindow', 'twap_window'],
  ['gateOk', 'gate_ok'],
  ['gateFailedAt', 'gate_failed_at'],
  ['proxyLastRebalanceTs', 'proxy_last_rebalance_ts'],
  ['gasWei', 'gas_wei'],
  ['poolLiq', 'pool_liq'],
  ['feeDivisor', 'fee_divisor'],
  ['feeProtocol', 'fee_protocol'],
  ['reservePaused', 'reserve_paused'],
  ['clearingTwapCheck', 'clearing_twap_check'],
  ['clearingThreshold', 'clearing_threshold'],
  ['clearingDevBps', 'clearing_dev_bps'],
  ['depositsOpen', 'deposits_open'],
];

const BOOL_SAMPLE_KEYS = new Set<string>(['inBase', 'inLimit', 'gateOk', 'reservePaused', 'clearingTwapCheck', 'depositsOpen']);
const STR_SAMPLE_KEYS = new Set<string>([
  'sqrtPriceX96',
  'total0',
  'total1',
  'supply',
  'maxTotalSupply',
  'baseLiq',
  'baseAmt0',
  'baseAmt1',
  'limitLiq',
  'limitAmt0',
  'limitAmt1',
  'fees0',
  'fees1',
  'idle0',
  'idle1',
  'gasWei',
  'poolLiq',
]);

export function sampleItem(r: Row, vault: string, fields: ReadonlySet<string> | null): Partial<Sample> & { vault: string; ts: number } {
  const out: Record<string, unknown> = { vault, ts: intOr(r.ts) ?? 0 };
  for (const [key, col] of SAMPLE_COLUMNS) {
    if (key === 'ts') continue;
    if (fields && !fields.has(key)) continue;
    const v = r[col];
    if (v === undefined) continue;
    if (BOOL_SAMPLE_KEYS.has(key)) out[key] = boolOr(v);
    else if (STR_SAMPLE_KEYS.has(key)) out[key] = bigStr(v);
    else if (key === 'gateFailedAt') out[key] = strOr(v);
    else out[key] = numOr(v);
  }
  return out as Partial<Sample> & { vault: string; ts: number };
}

export function samplesBody(c: Ctx, v: VaultRow, q: { from: number; to: number; step: number; fields?: string }): SamplesV1 {
  const fields = q.fields ? new Set(q.fields.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const cap = 5000;
  const hourly = q.step >= 3600;
  const rows = hourly
    ? c.db.all<Row>('SELECT * FROM samples_1h WHERE vault_id = :v AND ts >= :from AND ts <= :to ORDER BY ts LIMIT :lim', { v: v.id, from: q.from, to: q.to, lim: cap + 1 })
    : // a sample is stamped with wall clock, never on the step grid, so decimate
      // by keeping the newest row of each step-wide bucket. node:sqlite binds a
      // js number as REAL, so the divisor has to be cast or the division floats
      c.db.all<Row>(
        `SELECT * FROM samples WHERE vault_id = :v AND ts >= :from AND ts <= :to
           AND ts IN (SELECT max(ts) FROM samples WHERE vault_id = :v AND ts >= :from AND ts <= :to GROUP BY ts / CAST(:step AS INTEGER))
         ORDER BY ts LIMIT :lim`,
        { v: v.id, from: q.from, to: q.to, step: Math.max(1, q.step), lim: cap + 1 },
      );
  const truncated = rows.length > cap;
  const items = (truncated ? rows.slice(0, cap) : rows).map((r) => (hourly ? hourItem(r, v.id, fields) : sampleItem(r, v.id, fields)));
  return { v: 1, generatedAt: toIso(c.nowMs), vault: v.id, step: q.step, from: q.from, to: q.to, items, truncated };
}

// the 1h rollup, mapped onto the sample shape so one chart code path reads both
function hourItem(r: Row, vault: string, fields: ReadonlySet<string> | null): Partial<Sample> & { vault: string; ts: number } {
  const out: Record<string, unknown> = { vault, ts: intOr(r.ts) ?? 0 };
  const put = (k: string, v: unknown) => {
    if (!fields || fields.has(k)) out[k] = v;
  };
  put('priceHuman', numOr(r.price_last));
  put('nav1', numOr(r.nav1_last));
  put('sharePrice', numOr(r.share_price_last));
  put('x', numOr(r.x_avg));
  put('fees1Value', numOr(r.fees1_value_last));
  put('gasWei', bigStr(r.gas_wei_last));
  return out as Partial<Sample> & { vault: string; ts: number };
}

export function flowsBody(c: Ctx, v: VaultRow, o: { sinceTs: number; limit: number }): FlowsV1 {
  const d = decimalsOf(v);
  const rows = c.db.all<Row>(
    "SELECT * FROM chain_events WHERE vault_id = :v AND kind IN ('Deposit','Withdraw') AND ts >= :s ORDER BY ts DESC, log_index DESC LIMIT :lim",
    { v: v.id, s: o.sinceTs, lim: o.limit },
  );
  const items = rows.map((r) => {
    const args = parseArgs(r.args_json);
    return {
      hash: String(r.tx_hash),
      logIndex: intOr(r.log_index) ?? 0,
      vault: v.id,
      block: intOr(r.block) ?? 0,
      ts: intOr(r.ts) ?? 0,
      kind: (strOr(r.kind) === 'Withdraw' ? 'Withdraw' : 'Deposit') as 'Deposit' | 'Withdraw',
      sender: strOr(args.sender),
      to: strOr(args.to),
      shares: bigStr(args.shares) ?? '0',
      amount0: amount(args.amount0, d?.d0 ?? 0, v.sym0) ?? { raw: '0', decimals: d?.d0 ?? 0, human: 0, symbol: v.sym0 ?? '' },
      amount1: amount(args.amount1, d?.d1 ?? 0, v.sym1) ?? { raw: '0', decimals: d?.d1 ?? 0, human: 0, symbol: v.sym1 ?? '' },
    };
  });
  const counts = c.db.get<Row>(
    `SELECT SUM(kind = 'Deposit') AS deposits, SUM(kind = 'Withdraw') AS withdrawals,
            COUNT(DISTINCT json_extract(args_json, '$.to')) AS depositors
     FROM chain_events WHERE vault_id = :v AND kind IN ('Deposit','Withdraw')`,
    { v: v.id },
  );
  const supply = c.db.get<Row>('SELECT supply FROM samples WHERE vault_id = :v ORDER BY ts DESC LIMIT 1', { v: v.id });
  return {
    v: 1,
    generatedAt: toIso(c.nowMs),
    vault: v.id,
    items,
    summary: {
      deposits: intOr(counts?.deposits) ?? 0,
      withdrawals: intOr(counts?.withdrawals) ?? 0,
      depositors: intOr(counts?.depositors) ?? 0,
      supply: supply ? bigStr(supply.supply) : null,
    },
  };
}

function parseArgs(json: unknown): Record<string, unknown> {
  if (typeof json !== 'string') return {};
  try {
    const v = JSON.parse(json);
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function chainEventItem(r: Row): ChainEvent {
  return {
    hash: String(r.tx_hash),
    logIndex: intOr(r.log_index) ?? 0,
    vault: String(r.vault_id),
    block: intOr(r.block) ?? 0,
    ts: intOr(r.ts) ?? 0,
    kind: (strOr(r.kind) ?? 'Rebalance') as ChainEvent['kind'],
    args: parseArgs(r.args_json),
  };
}

export function timelineItem(r: Row): TimelineEvent {
  return {
    id: intOr(r.id) ?? 0,
    ts: intOr(r.ts) ?? 0,
    vault: strOr(r.vault_id),
    kind: (strOr(r.kind) ?? 'cycle') as EventKind,
    ref: strOr(r.ref_id),
    payload: parseArgs(r.payload_json),
  };
}

export function logBody(c: Ctx, v: VaultRow, n: number): LogV1 {
  const rows = c.db.all<Row>('SELECT ts, line FROM keeper_lines WHERE vault_id = :v ORDER BY id DESC LIMIT :n', { v: v.id, n });
  return {
    v: 1,
    generatedAt: toIso(c.nowMs),
    vault: v.id,
    source: 'db',
    lines: rows.reverse().map((r) => ({ ts: intOr(r.ts), line: strOr(r.line) ?? '' })),
  };
}

// --- economics ---------------------------------------------------------------------

export const WINDOWS: Record<WindowName, number | null> = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400, launch: null };

export function windowBounds(c: Ctx, v: VaultRow, spec: string): { label: string; from: number; to: number } {
  const to = c.nowTs;
  const range = /^(\d+)\.\.(\d+)$/.exec(spec);
  if (range) return { label: spec, from: Number(range[1]), to: Number(range[2]) };
  const w = (spec in WINDOWS ? spec : '7d') as WindowName;
  const secs = WINDOWS[w];
  if (secs !== null) return { label: w, from: to - secs, to };
  const first = c.db.get<{ ts: number }>('SELECT MIN(ts) AS ts FROM samples WHERE vault_id = :v', { v: v.id });
  return { label: 'launch', from: intOr(first?.ts) ?? v.first_seen_at ?? to - 7 * 86400, to };
}

function econPoint(r: Row | null): EconPoint | null {
  if (!r) return null;
  const tick = intOr(r.spot_tick);
  if (tick === null) return null;
  return {
    ts: intOr(r.ts) ?? 0,
    block: intOr(r.block) ?? 0,
    tick,
    total0: bigStr(r.total0),
    total1: bigStr(r.total1),
    supply: bigStr(r.supply),
    fees0: bigStr(r.fees0),
    fees1: bigStr(r.fees1),
  };
}

// the newest sample at or before `ts`; `first-if-empty` falls back to the oldest
// sample there is, which is what the window start wants when the window opens
// before the first sample
function boundSample(db: Db, vault: string, ts: number, empty: 'first-if-empty' | 'strict'): Row | null {
  const at = db.get<Row>('SELECT * FROM samples WHERE vault_id = :v AND ts <= :ts ORDER BY ts DESC LIMIT 1', { v: vault, ts });
  if (at) return at;
  if (empty === 'strict') return null;
  return db.get<Row>('SELECT * FROM samples WHERE vault_id = :v ORDER BY ts ASC LIMIT 1', { v: vault }) ?? null;
}

function zeroBurns(db: Db, vault: string, from: number, to: number): ZeroBurnEv[] {
  const rows = db.all<Row>("SELECT * FROM chain_events WHERE vault_id = :v AND kind = 'ZeroBurn' AND ts >= :from AND ts <= :to ORDER BY ts", {
    v: vault,
    from,
    to,
  });
  return rows.map((r) => {
    const a = parseArgs(r.args_json);
    const at = db.get<Row>('SELECT spot_tick, supply FROM samples WHERE vault_id = :v AND ts <= :ts ORDER BY ts DESC LIMIT 1', { v: vault, ts: intOr(r.ts) ?? 0 });
    return {
      ts: intOr(r.ts) ?? 0,
      block: intOr(r.block) ?? 0,
      fee: Number(a.fee ?? 0),
      fees0: bigStr(a.fees0),
      fees1: bigStr(a.fees1),
      tick: at ? intOr(at.spot_tick) : null,
      supply: at ? bigStr(at.supply) : null,
    };
  });
}

function rangeSamples(db: Db, vault: string, from: number, to: number, d: Decimals | null): RangeSample[] {
  const rows = db.all<Row>('SELECT * FROM samples WHERE vault_id = :v AND ts >= :from AND ts <= :to ORDER BY ts', { v: vault, from, to });
  return rows.map((r) => {
    const tick = intOr(r.spot_tick);
    let baseShare: number | null = null;
    if (d && tick !== null) {
      const P = priceHuman(tick, d);
      const nav = nav1(bigStr(r.total0), bigStr(r.total1), P, d);
      const b = nav1(bigStr(r.base_amt0), bigStr(r.base_amt1), P, d);
      if (nav !== null && b !== null && nav > 0) baseShare = b / nav;
    }
    return {
      ts: intOr(r.ts) ?? 0,
      inBase: boolOr(r.in_base),
      inLimit: boolOr(r.in_limit),
      limitLiq: bigStr(r.limit_liq),
      spotTick: tick,
      limitLower: intOr(r.limit_lower),
      limitUpper: intOr(r.limit_upper),
      baseShare,
    };
  });
}

export function economicsBody(c: Ctx, v: VaultRow, spec: string): EconomicsV1 {
  const w = windowBounds(c, v, spec);
  const d = decimalsOf(v) ?? { d0: 18, d1: 18 };
  const startRow = boundSample(c.db, v.id, w.from, 'first-if-empty');
  const endRow = boundSample(c.db, v.id, w.to, 'strict');
  const start = econPoint(startRow);
  const end = econPoint(endRow);
  const txs = txLites(c.db, v.id, w.from);
  const res = economicsWindow({
    d,
    start,
    end,
    zeroBurns: zeroBurns(c.db, v.id, w.from, w.to),
    samples: rangeSamples(c.db, v.id, w.from, w.to, decimalsOf(v)),
    txs,
    refreshTicks: cfgNum(setting(c, v.id, 'LIMIT_REFRESH_TICKS')),
    minIntervalSecs: cfgNum(setting(c, v.id, 'MIN_INTERVAL_SECS')),
  });
  const cost = costPerTx(txs, gasPriceWei(c));
  const gasBalance = endRow ? bigStr(endRow.gas_wei) : null;
  const burn = burnPerDay(txs, c.nowTs);
  const floor = gasFloorWei(c, v.id);
  const runway = gasRunway(gasBalance, floor, cost.avgCostWei.recenter, burn);
  const flows = flowsBody(c, v, { sinceTs: w.from, limit: 1 });
  const avg: Record<string, string | null> = {};
  for (const [k, val] of Object.entries(cost.avgCostWei)) avg[k] = val === null ? null : val.toString();
  const feeSample = endRow ?? startRow;

  return {
    v: 1,
    generatedAt: toIso(c.nowMs),
    vault: v.id,
    window: {
      label: w.label,
      from: start ? { block: start.block, ts: start.ts } : null,
      to: end ? { block: end.block, ts: end.ts } : null,
    },
    perShare: res.perShare,
    netVsBasketHodl: res.netVsBasketHodl,
    netVs5050Hodl: res.netVs5050Hodl,
    experimental: {
      feesFrac: res.feesFrac,
      ilFrac: res.ilFrac,
      feesPerShare: res.feesPerShare,
      skim: {
        amount0: amount(res.skim.amount0, d.d0, v.sym0),
        amount1: amount(res.skim.amount1, d.d1, v.sym1),
        feeDivisor: feeSample ? intOr(feeSample.fee_divisor) : null,
        feeProtocol: feeSample ? intOr(feeSample.fee_protocol) : null,
      },
    },
    timeInRange: {
      base: res.timeInRange.base,
      limit: res.timeInRange.limit,
      twBaseShare: res.timeInRange.twBaseShare,
      bandExits: res.timeInRange.bandExits,
      limitStrandedFrac: res.timeInRange.limitStrandedFrac,
    },
    actions: res.actions,
    cadence: res.cadence,
    cost: { avgCostWei: avg as EconomicsV1['cost']['avgCostWei'], totalWei: cost.totalWei === null ? null : cost.totalWei.toString(), costSource: cost.costSource },
    gas: {
      balanceWei: gasBalance,
      burnPerDayWei: burn === null ? null : burn.toString(),
      runwayDays: runway.runwayDays,
      warnWei: gasWarnWei(c, v.id),
      floorWei: floor,
    },
    flows: {
      deposits: flows.summary.deposits,
      withdrawals: flows.summary.withdrawals,
      depositors: flows.summary.depositors,
      supplyStart: start ? bigStr(start.supply) : null,
      supplyEnd: end ? bigStr(end.supply) : null,
    },
  };
}

export function economicsSummary(c: Ctx, v: VaultRow): EconomicsSummary | null {
  try {
    const e = economicsBody(c, v, '7d');
    const txs = e.actions.recenter + e.actions.refresh + e.actions.fold + e.actions.compound;
    return {
      window: '7d',
      netVsBasketHodl: e.netVsBasketHodl,
      netVs5050Hodl: e.netVs5050Hodl,
      experimental: { feesFrac: e.experimental.feesFrac, ilFrac: e.experimental.ilFrac },
      timeInBase: e.timeInRange.base,
      txs,
      avgCostWei: e.cost.avgCostWei.recenter ?? null,
    };
  } catch {
    return null;
  }
}

// --- config, monitor, discovery, health -------------------------------------------

export function configBody(c: Ctx): ConfigV1 {
  const k = c.sources.keeper;
  const cached = keeperConfigOf(c);
  const fetchedAt = k?.configAt ?? (Number(c.db.metaGet('keeper:config_at') ?? '') || null);
  const descriptorSha = c.db.metaGet('descriptor_sha256');
  const vaults = listVaults(c.db);
  const descriptorEntries: VaultDescriptor[] = vaults.map((v) => descriptorEntry(c.db, v.id));
  const drift: DriftRow[] = configDrift(descriptorEntries, cached);
  const thresholds: Record<string, Record<string, ConfigValue>> = {};
  for (const v of vaults) {
    const m = c.sources.monitor?.vaults[v.id];
    if (m) thresholds[v.id] = configValues(m.thresholds);
  }
  return {
    v: 1,
    generatedAt: toIso(c.nowMs),
    keeper: {
      source: cached === null ? 'none' : k?.reachable ? 'keeper' : 'cache',
      fetchedAt: iso(fetchedAt),
      config: cached,
    },
    descriptor: descriptorSha === null ? null : { sha256: descriptorSha, vaults: descriptorEntries },
    drift,
    monitor: Object.keys(thresholds).length ? { thresholds } : null,
    ui: publicConfig(c.cfg, c.sources.keeper?.status?.keeper.rpcHost ?? null),
  };
}

export function monitorBody(c: Ctx): MonitorV1 {
  const m = c.sources.monitor;
  return {
    v: 1,
    generatedAt: toIso(c.nowMs),
    configured: c.cfg.monitorConfigured,
    reachable: m?.reachable ?? false,
    asOf: iso(m?.statusAt ?? null),
    status: m?.status ?? null,
  };
}

export function discovery(c: Ctx): DiscoveryV1 {
  const base = '/api/v1';
  return {
    v: 1,
    generatedAt: toIso(c.nowMs),
    name: 'gamma-ui',
    commit: c.cfg.COMMIT ?? null,
    publicUrl: c.cfg.PUBLIC_URL ?? null,
    endpoints: {
      status: `${base}/status`,
      statusText: `${base}/status.txt`,
      vaults: `${base}/vaults`,
      vault: `${base}/vaults/{id}`,
      vaultText: `${base}/vaults/{id}.txt`,
      gates: `${base}/vaults/{id}/gates`,
      cycles: `${base}/vaults/{id}/cycles`,
      episodes: `${base}/vaults/{id}/episodes`,
      txs: `${base}/vaults/{id}/txs`,
      flows: `${base}/vaults/{id}/flows`,
      samples: `${base}/vaults/{id}/samples`,
      economics: `${base}/vaults/{id}/economics`,
      log: `${base}/vaults/{id}/log`,
      events: `${base}/vaults/{id}/events`,
      findings: `${base}/findings`,
      config: `${base}/config`,
      monitor: `${base}/monitor`,
      queries: `${base}/queries`,
      healthz: '/healthz',
    },
    schema: `${base}/schema`,
    openapi: `${base}/openapi.json`,
    stream: `${base}/stream`,
    conventions: { units: UNITS },
    enums: PUBLIC_ENUMS as unknown as DiscoveryV1['enums'],
  };
}

// the probe writes, and /healthz is publicly routed: the write is taken at most
// once per PROBE_SECS and the verdict cached, so anonymous traffic cannot drive
// the single writer the collectors share
const PROBE_SECS = 30;
let probe: { at: number; ok: boolean } | null = null;

// tests only
export function resetHealthProbe(): void {
  probe = null;
}

export function healthBody(c: Ctx): HealthV1 {
  let dbOk: boolean;
  if (probe && c.nowTs - probe.at < PROBE_SECS) {
    dbOk = probe.ok;
  } else {
    try {
      c.db.run('INSERT INTO meta (k, v) VALUES (:k, :v) ON CONFLICT (k) DO UPDATE SET v = excluded.v', { k: 'healthz_at', v: String(c.nowTs) });
      dbOk = true;
    } catch {
      dbOk = false;
    }
    probe = { at: c.nowTs, ok: dbOk };
  }
  const collectors = collectorHealth();
  // before the first tick there is nothing to judge, and a 503 there would
  // restart-loop the task; a registered collector that stops ticking does fail
  const ticked = anyTickWithin(300, c.nowTs) || Object.keys(collectors).length === 0;
  return { ok: dbOk && ticked, db: dbOk, collectors };
}

export function findVaultRow(c: Ctx, idOrSlug: string): VaultRow | null {
  return findVault(c.db, idOrSlug);
}

// re-exported so routes and the text renderer never reach into collect/ directly
export { listVaults };
