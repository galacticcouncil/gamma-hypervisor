import type { TxKind } from '../contract/enums';
import { weiToNum } from '../contract/format';

// every formula in plan › data model › derived metrics, pure and unit-tested.
// amounts are bigint (raw units); per-share results are plain numbers. windows
// [t0, t] are given as the two bounding points the caller picked from the
// samples table; the caller also supplies the ZeroBurn events and receipts.

export interface Decimals {
  d0: number;
  d1: number;
}

export type Big = bigint | string | number | null | undefined;

export function big(x: Big): bigint | null {
  if (x === null || x === undefined) return null;
  try {
    if (typeof x === 'bigint') return x;
    if (typeof x === 'number') return BigInt(Math.trunc(x));
    return BigInt(x);
  } catch {
    return null;
  }
}

export function priceRaw(tick: number): number {
  return Math.pow(1.0001, tick);
}

// P(t) = 1.0001^tick × 10^(d0−d1): token1 per token0, human
export function priceHuman(tick: number, d: Decimals): number {
  return priceRaw(tick) * Math.pow(10, d.d0 - d.d1);
}

export function human(x: Big, decimals: number): number | null {
  const b = big(x);
  return b === null ? null : weiToNum(b, decimals);
}

// S(t) = supply / 1e18
export function shares(supply: Big): number | null {
  return human(supply, 18);
}

// nav1 = total0/10^d0 × P + total1/10^d1 — excludes fees accrued since the last poke
export function nav1(total0: Big, total1: Big, P: number, d: Decimals): number | null {
  const a = human(total0, d.d0);
  const b = human(total1, d.d1);
  if (a === null || b === null) return null;
  return a * P + b;
}

export function nav1Incl(nav: number | null, fees0: Big, fees1: Big, P: number, d: Decimals): number | null {
  if (nav === null) return null;
  const f0 = human(fees0, d.d0);
  const f1 = human(fees1, d.d1);
  if (f0 === null || f1 === null) return nav;
  return nav + f0 * P + f1;
}

// sp = nav1_incl / S
export function sharePrice(navIncl: number | null, supply: Big): number | null {
  const s = shares(supply);
  if (navIncl === null || s === null || s <= 0) return null;
  return navIncl / s;
}

// --- composition (wiki §7.1) ------------------------------------------------------

export interface Composition {
  x: number;
  baseShare: number;
  limitShare: number;
  twoXMinusOne: number;
  reflectTo: number;
}

// the theoretical table: at token0 share X the one-sided limit carries |2X−1| of nav; a full traversal reflects X → 1−X
export function compositionFromX(x: number): Composition {
  const two = Math.abs(2 * x - 1);
  return { x, baseShare: 1 - two, limitShare: two, twoXMinusOne: two, reflectTo: 1 - x };
}

export interface CompositionInput {
  total0: Big;
  total1: Big;
  baseAmt0: Big;
  baseAmt1: Big;
  limitAmt0: Big;
  limitAmt1: Big;
}

// measured from position amounts; falls back to the theoretical split when legs are missing
export function composition(i: CompositionInput, P: number, d: Decimals): Composition | null {
  const nav = nav1(i.total0, i.total1, P, d);
  const t0 = human(i.total0, d.d0);
  if (nav === null || t0 === null || nav <= 0) return null;
  const x = clamp01((t0 * P) / nav);
  const b = nav1(i.baseAmt0, i.baseAmt1, P, d);
  const l = nav1(i.limitAmt0, i.limitAmt1, P, d);
  if (b === null || l === null) return compositionFromX(x);
  return {
    x,
    baseShare: clamp01(b / nav),
    limitShare: clamp01(l / nav),
    twoXMinusOne: Math.abs(2 * x - 1),
    reflectTo: 1 - x,
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// --- benchmarks ----------------------------------------------------------------------

// q0 = (total0/10^d0)/S, q1 = (total1/10^d1)/S at t0
export function basketPerShare(total0: Big, total1: Big, supply: Big, d: Decimals): { q0: number; q1: number } | null {
  const a = human(total0, d.d0);
  const b = human(total1, d.d1);
  const s = shares(supply);
  if (a === null || b === null || s === null || s <= 0) return null;
  return { q0: a / s, q1: b / s };
}

// hodl_b(t) = q0·P(t) + q1 (wiki §7.6, the headline)
export function basketHodl(q0: number, q1: number, P: number): number {
  return q0 * P + q1;
}

// hodl_50(t) = sp(t0) × (½·P(t)/P(t0) + ½) (spec §E)
export function hodl5050(sp0: number, P0: number, Pt: number): number {
  return sp0 * (0.5 * (Pt / P0) + 0.5);
}

// --- fees (experimental) ----------------------------------------------------------

export interface ZeroBurnEv {
  ts: number;
  block: number;
  // Hypervisor.fee() divisor as the event carries it; 0 = no skim
  fee: number;
  fees0: Big;
  fees1: Big;
  // pool tick at the event block; null → the window's end tick
  tick: number | null;
  // totalSupply at the event block; null → the window's end supply
  supply: Big;
}

// retained = fees × (1 − 1/fee), skim = fees/fee → feeRecipient
export function feesRetained(fees0: Big, fees1: Big, fee: number): { retained0: bigint; retained1: bigint; skim0: bigint; skim1: bigint } {
  const f0 = big(fees0) ?? 0n;
  const f1 = big(fees1) ?? 0n;
  if (!Number.isFinite(fee) || fee <= 0) return { retained0: f0, retained1: f1, skim0: 0n, skim1: 0n };
  const div = BigInt(Math.trunc(fee));
  const skim0 = f0 / div;
  const skim1 = f1 / div;
  return { retained0: f0 - skim0, retained1: f1 - skim1, skim0, skim1 };
}

export interface FeesResult {
  feesPerShare: number | null;
  skim0: bigint;
  skim1: bigint;
  retained0: bigint;
  retained1: bigint;
  events: number;
}

// Σ (retained0/10^d0 × P(blk) + retained1/10^d1)/S(blk) + Δ(owed per share)
export function feesPerShare(events: ZeroBurnEv[], d: Decimals, fallback: { tick: number; supply: Big }, owedDeltaPerShare = 0): FeesResult {
  let sum = 0;
  let any = false;
  let skim0 = 0n;
  let skim1 = 0n;
  let retained0 = 0n;
  let retained1 = 0n;
  for (const ev of events) {
    const r = feesRetained(ev.fees0, ev.fees1, ev.fee);
    skim0 += r.skim0;
    skim1 += r.skim1;
    retained0 += r.retained0;
    retained1 += r.retained1;
    const P = priceHuman(ev.tick ?? fallback.tick, d);
    const s = shares(ev.supply ?? fallback.supply);
    const v = nav1(r.retained0, r.retained1, P, d);
    if (s === null || s <= 0 || v === null) continue;
    sum += v / s;
    any = true;
  }
  const total = sum + owedDeltaPerShare;
  return { feesPerShare: any || owedDeltaPerShare !== 0 ? total : events.length === 0 ? 0 : null, skim0, skim1, retained0, retained1, events: events.length };
}

// --- time in range -----------------------------------------------------------------

export interface RangeSample {
  ts: number;
  inBase: boolean | null;
  inLimit: boolean | null;
  limitLiq: Big;
  spotTick: number | null;
  limitLower: number | null;
  limitUpper: number | null;
  // measured base share, for the time-weighted mean
  baseShare: number | null;
}

export interface TimeInRange {
  base: number | null;
  limit: number | null;
  twBaseShare: number | null;
  bandExits: number | null;
  limitStrandedFrac: number | null;
}

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

// timeInBase = mean(in_base); timeInLimit = mean(in_limit ∧ liq>0); bandExits = count(in_base 1→0); stranded = mean(¬in_limit ∧ liq>0 ∧ outsideBy > refreshTicks)
export function timeInRange(samples: RangeSample[], refreshTicks: number | null): TimeInRange {
  const inBase: number[] = [];
  const inLimit: number[] = [];
  const stranded: number[] = [];
  const shares: number[] = [];
  let exits = 0;
  let prev: boolean | null = null;
  for (const s of samples) {
    if (s.inBase !== null) {
      inBase.push(s.inBase ? 1 : 0);
      if (prev === true && !s.inBase) exits++;
      prev = s.inBase;
    }
    const liq = big(s.limitLiq);
    const hasLimit = liq !== null && liq > 0n;
    if (s.inLimit !== null) inLimit.push(s.inLimit && hasLimit ? 1 : 0);
    if (s.baseShare !== null) shares.push(s.baseShare);
    if (refreshTicks !== null && s.inLimit !== null && s.spotTick !== null && s.limitLower !== null && s.limitUpper !== null) {
      const away = s.spotTick < s.limitLower ? s.limitLower - s.spotTick : s.spotTick > s.limitUpper ? s.spotTick - s.limitUpper : 0;
      stranded.push(!s.inLimit && hasLimit && away > refreshTicks ? 1 : 0);
    }
  }
  return {
    base: mean(inBase),
    limit: mean(inLimit),
    twBaseShare: mean(shares),
    bandExits: inBase.length ? exits : null,
    limitStrandedFrac: mean(stranded),
  };
}

// --- actions, cadence, cost, runway ----------------------------------------------

export interface TxLite {
  hash: string;
  kind: TxKind;
  ts: number;
  gasUsed: number | null;
  gasPriceWei: Big;
  costWei: Big;
}

export type Actions = Record<'recenter' | 'refresh' | 'fold' | 'compound', number>;

export function actionsByKind(txs: TxLite[]): Actions {
  const a: Actions = { recenter: 0, refresh: 0, fold: 0, compound: 0 };
  for (const t of txs) if (t.kind in a) a[t.kind as keyof Actions]++;
  return a;
}

export const POLICY_CAP_PER_DAY = 2;

export interface Cadence {
  perDay: number | null;
  policyCapPerDay: number;
  proxyCapPerDay: number | null;
  minGapOk: boolean | null;
}

// rebalances (every kind but compound) per day over the window vs the policy cap 2/day and the proxy's 86400/minInterval
export function cadence(txs: TxLite[], fromTs: number, toTs: number, minIntervalSecs: number | null): Cadence {
  const reb = txs.filter((t) => t.kind !== 'compound' && t.ts >= fromTs && t.ts <= toTs).sort((a, b) => a.ts - b.ts);
  const days = Math.max(0, toTs - fromTs) / 86400;
  let minGapOk: boolean | null = null;
  if (minIntervalSecs !== null && reb.length >= 2) {
    minGapOk = true;
    for (let i = 1; i < reb.length; i++) if (reb[i].ts - reb[i - 1].ts < minIntervalSecs) minGapOk = false;
  } else if (minIntervalSecs !== null) minGapOk = true;
  return {
    perDay: days > 0 ? reb.length / days : null,
    policyCapPerDay: POLICY_CAP_PER_DAY,
    proxyCapPerDay: minIntervalSecs !== null && minIntervalSecs > 0 ? 86400 / minIntervalSecs : null,
    minGapOk,
  };
}

// mainnet.stack.yml:192-194: recenter ≈ 815k gas, compound ≈ 643k; ×1.2 markup
export const ESTIMATE_GAS: Record<TxKind, bigint> = {
  recenter: 815_000n,
  refresh: 815_000n,
  fold: 815_000n,
  compound: 643_000n,
  unknown: 815_000n,
};
export const ESTIMATE_MARKUP_NUM = 12n;
export const ESTIMATE_MARKUP_DEN = 10n;

export function txCostWei(t: TxLite): bigint | null {
  const c = big(t.costWei);
  if (c !== null) return c;
  const p = big(t.gasPriceWei);
  if (t.gasUsed !== null && p !== null) return BigInt(t.gasUsed) * p;
  return null;
}

export interface CostResult {
  avgCostWei: Record<TxKind, bigint | null>;
  totalWei: bigint | null;
  costSource: 'receipts' | 'estimate';
}

// avg receipt cost by kind; without a recenter receipt the fallback is gas × eth_gasPrice × 1.2 flagged `estimate`
export function costPerTx(txs: TxLite[], gasPriceWei: Big): CostResult {
  const sums: Record<string, { sum: bigint; n: number }> = {};
  let total = 0n;
  let anyTotal = false;
  for (const t of txs) {
    const c = txCostWei(t);
    if (c === null) continue;
    const cur = sums[t.kind] ?? { sum: 0n, n: 0 };
    cur.sum += c;
    cur.n++;
    sums[t.kind] = cur;
    total += c;
    anyTotal = true;
  }
  const avg = {} as Record<TxKind, bigint | null>;
  for (const k of Object.keys(ESTIMATE_GAS) as TxKind[]) avg[k] = sums[k] ? sums[k].sum / BigInt(sums[k].n) : null;
  let costSource: 'receipts' | 'estimate' = 'receipts';
  const gp = big(gasPriceWei);
  if (avg.recenter === null && gp !== null) {
    costSource = 'estimate';
    for (const k of Object.keys(ESTIMATE_GAS) as TxKind[]) {
      if (avg[k] === null) avg[k] = (ESTIMATE_GAS[k] * gp * ESTIMATE_MARKUP_NUM) / ESTIMATE_MARKUP_DEN;
    }
  }
  return { avgCostWei: avg, totalWei: anyTotal ? total : null, costSource };
}

// Σ receipt cost over the last `days` / days; null with no receipts
export function burnPerDay(txs: TxLite[], nowTs: number, days = 30): bigint | null {
  const from = nowTs - days * 86400;
  let sum = 0n;
  let any = false;
  for (const t of txs) {
    if (t.ts < from) continue;
    const c = txCostWei(t);
    if (c === null) continue;
    sum += c;
    any = true;
  }
  return any ? sum / BigInt(days) : null;
}

// runwayTx = floor((balance − floor)/avgRecenter); runwayDays = (balance − floor)/burnPerDay (null without burn)
export function gasRunway(balanceWei: Big, floorWei: Big, avgRecenterWei: Big, burnPerDayWei: Big): { runwayTx: number | null; runwayDays: number | null } {
  const bal = big(balanceWei);
  const floor = big(floorWei) ?? 0n;
  if (bal === null) return { runwayTx: null, runwayDays: null };
  const spare = bal - floor;
  const avg = big(avgRecenterWei);
  const burn = big(burnPerDayWei);
  const runwayTx = avg !== null && avg > 0n ? Math.max(0, Number(spare / avg)) : null;
  const runwayDays = burn !== null && burn > 0n ? Math.max(0, Number(spare) / Number(burn)) : null;
  return { runwayTx, runwayDays };
}

// --- the window -----------------------------------------------------------------------

export interface EconPoint {
  ts: number;
  block: number;
  tick: number;
  total0: Big;
  total1: Big;
  supply: Big;
  fees0: Big;
  fees1: Big;
}

export interface EconWindowInput {
  d: Decimals;
  start: EconPoint | null;
  end: EconPoint | null;
  zeroBurns: ZeroBurnEv[];
  samples: RangeSample[];
  txs: TxLite[];
  refreshTicks: number | null;
  minIntervalSecs: number | null;
  // Δ(owed valued per share) between the bounds, when fees were sampled at both
  owedDeltaPerShare?: number;
}

export interface EconResult {
  perShare: { spStart: number | null; spEnd: number | null; hodlBasket: number | null; hodl5050: number | null };
  netVsBasketHodl: number | null;
  netVs5050Hodl: number | null;
  feesPerShare: number | null;
  feesFrac: number | null;
  ilFrac: number | null;
  skim: { amount0: bigint; amount1: bigint };
  timeInRange: TimeInRange;
  actions: Actions;
  cadence: Cadence;
}

// sp(t) from a point, fees included when sampled
export function spAt(p: EconPoint, d: Decimals): number | null {
  const P = priceHuman(p.tick, d);
  const nav = nav1(p.total0, p.total1, P, d);
  return sharePrice(nav1Incl(nav, p.fees0, p.fees1, P, d), p.supply);
}

export function economicsWindow(i: EconWindowInput): EconResult {
  const { d, start, end } = i;
  let spStart: number | null = null;
  let spEnd: number | null = null;
  let hodlBasket: number | null = null;
  let hodl50: number | null = null;
  let netVsBasketHodl: number | null = null;
  let netVs5050Hodl: number | null = null;
  let feesFrac: number | null = null;
  let ilFrac: number | null = null;

  if (start && end) {
    spStart = spAt(start, d);
    spEnd = spAt(end, d);
    const P0 = priceHuman(start.tick, d);
    const Pt = priceHuman(end.tick, d);
    const q = basketPerShare(start.total0, start.total1, start.supply, d);
    if (q) hodlBasket = basketHodl(q.q0, q.q1, Pt);
    if (spStart !== null) hodl50 = hodl5050(spStart, P0, Pt);
    if (spEnd !== null && hodlBasket !== null && hodlBasket > 0) netVsBasketHodl = spEnd / hodlBasket - 1;
    if (spEnd !== null && hodl50 !== null && hodl50 > 0) netVs5050Hodl = spEnd / hodl50 - 1;
  }

  const fallback = end ? { tick: end.tick, supply: end.supply } : { tick: 0, supply: null };
  const fees = feesPerShare(i.zeroBurns, d, fallback, i.owedDeltaPerShare ?? 0);
  if (fees.feesPerShare !== null && hodlBasket !== null && hodlBasket > 0) {
    feesFrac = fees.feesPerShare / hodlBasket;
    if (netVsBasketHodl !== null) ilFrac = netVsBasketHodl - feesFrac;
  }

  const from = start?.ts ?? (i.samples[0]?.ts ?? 0);
  const to = end?.ts ?? (i.samples[i.samples.length - 1]?.ts ?? from);
  return {
    perShare: { spStart, spEnd, hodlBasket, hodl5050: hodl50 },
    netVsBasketHodl,
    netVs5050Hodl,
    feesPerShare: fees.feesPerShare,
    feesFrac,
    ilFrac,
    skim: { amount0: fees.skim0, amount1: fees.skim1 },
    timeInRange: timeInRange(i.samples, i.refreshTicks),
    actions: actionsByKind(i.txs.filter((t) => t.ts >= from && t.ts <= to)),
    cadence: cadence(i.txs, from, to, i.minIntervalSecs),
  };
}
