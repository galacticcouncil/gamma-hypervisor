import { ethers } from 'ethers';
import type { Pool } from './pools';

export interface Finding {
  key: string;
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
  /** pool id (lowercase vault address); null = global (gas, the monitor itself). */
  vault: string | null;
}

/** the gauges one cycle computes, kept for /status instead of discarded. */
export interface Snapshot {
  checkedAt: string;
  tick: number;
  base: [number, number];
  limit: [number, number];
  drift: number;
  threshold: number;
  lastRebalanceTs: number;
  sinceSecs: number;
  allowanceSecs: number;
  limitOutsideBy: number;
  paused: boolean | null;
  feedPx: number | null;
  poolPx: number;
  divergenceBps: number | null;
  oracleTick: number | null;
  twapTick: number | null;
  devTicks: number | null;
  spotDevTicks: number | null;
  feedAgeSecs: number | null;
  navToken1: number;
  limitValueToken1: number;
}

const ABI = {
  pool: [
    'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16,uint8,bool)',
    'function liquidity() view returns (uint128)',
    'function tickSpacing() view returns (int24)',
    'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives,uint160[])',
    'function observations(uint256) view returns (uint32 blockTimestamp,int56 tickCumulative,uint160,bool initialized)',
  ],
  proxy: ['function lastRebalance(address) view returns (uint256)'],
  vault: [
    'function baseLower() view returns (int24)',
    'function baseUpper() view returns (int24)',
    'function limitLower() view returns (int24)',
    'function limitUpper() view returns (int24)',
    'function getLimitPosition() view returns (uint128 liquidity,uint256 amount0,uint256 amount1)',
    'function getTotalAmounts() view returns (uint256,uint256)',
    'function totalSupply() view returns (uint256)',
  ],
  clearing: ['function paused() view returns (bool)'],
  feed: ['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)', 'function decimals() view returns (uint8)'],
};

// --- price math, per-pool decimals instead of the aDOT/HOLLAR 1e-8 literal ----

const LOG_1_0001 = Math.log(1.0001);

/** human token1 per token0 from a pool tick (raw tick × 10^(dec0−dec1)). */
export function poolPriceHuman(tick: number, dec0: number, dec1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
}

/** nearest pool tick for a human token1-per-token0 price (keeper oracle.ts:75). */
export function tickFromHuman(priceHuman: number, dec0: number, dec1: number): number {
  return Math.round(Math.log(priceHuman * Math.pow(10, dec1 - dec0)) / LOG_1_0001);
}

/** human token1 per token0 implied by usd feeds; one feed => the other side is usd-pegged. */
export function feedPriceHuman(usd0: number, usd1: number | null, feed0Side: 'token0' | 'token1'): number {
  if (usd1 === null) return feed0Side === 'token0' ? usd0 : 1 / usd0;
  return feed0Side === 'token0' ? usd0 / usd1 : usd1 / usd0;
}

/** human token amount from a raw balance. */
export function human(x: ethers.BigNumber, decimals: number): number {
  return Number(ethers.utils.formatUnits(x, decimals));
}

/**
 * The pool's arithmetic-mean tick, exactly as the keeper computes it.
 *
 * This MUST mirror `checkPrice` in the keeper: it gates on `twapTick ?? spotTick`
 * versus the oracle, NOT on spot. Watching spot instead made the watchdog
 * disagree with the thing it watches in both directions — it alerted on a keeper
 * that was correctly gated (2026-09-17 15:38 UTC: dev(spot) 39 so no suppression,
 * while dev(TWAP) was 121 and the keeper was blocked), and it would have stayed
 * silent through a real fault whenever spot diverged but the TWAP had not caught
 * up yet. Returns undefined if the pool cannot serve the window, which is the
 * same condition under which the keeper refuses to act.
 */
async function poolTwapTick(
  pool: ethers.Contract,
  windowSecs: number,
  minWindowSecs: number,
  nowTs: number,
): Promise<number | undefined> {
  try {
    const s = await pool.slot0();
    const next = (Number(s.observationIndex) + 1) % Number(s.observationCardinality);
    let obs = await pool.observations(next);
    if (!obs.initialized) obs = await pool.observations(0);
    const oldest = Math.max(0, nowTs - Number(obs.blockTimestamp));
    const window = Math.min(windowSecs, oldest);
    if (window < minWindowSecs) return undefined;
    const res = await pool.observe([window, 0]);
    const cum: ethers.BigNumber[] = res.tickCumulatives ?? res[0];
    const delta = cum[1].sub(cum[0]);
    let tick = delta.div(window).toNumber();
    if (delta.isNegative() && !delta.mod(window).isZero()) tick -= 1;
    return tick;
  } catch {
    return undefined;
  }
}

// one AggregatorV3 read as the keeper does it: a non-positive answer is a throw,
// which fails the pool's cycle rather than passing as a price of zero
async function readFeed(feed: ethers.Contract): Promise<{ usd: number; ts: number }> {
  const [rd, dec] = await Promise.all([feed.latestRoundData(), feed.decimals()]);
  const answer = ethers.BigNumber.from(rd[1]);
  if (answer.lte(0)) throw new Error(`feed ${feed.address} returned ${answer.toString()}`);
  const usd = Number(ethers.utils.formatUnits(answer, Number(dec)));
  if (!(usd > 0) || !Number.isFinite(usd)) throw new Error(`feed ${feed.address} price not usable: ${usd}`);
  return { usd, ts: Number(rd[3]) };
}

/** per-pool carry-over between cycles. */
export interface Memo {
  failures: number;
  lastOkTs: number | null;
}

export const blankMemo = (): Memo => ({ failures: 0, lastOkTs: null });

const fmt = (w: ethers.BigNumber) => ethers.utils.formatEther(w);

/** the one signer is process-wide, so gas is checked once per cycle, not per pool. */
export async function checkGas(
  keeper: string,
  gasWarn: ethers.BigNumber,
  gasFloor: ethers.BigNumber,
  p: ethers.providers.Provider,
): Promise<{ wei: ethers.BigNumber; finding: Finding | null }> {
  const bal = await p.getBalance(keeper);
  // one key for both levels: warn→floor is an escalation, not a resolve + new alert
  if (bal.lt(gasFloor)) {
    return { wei: bal, finding: { key: 'gas', severity: 'critical', vault: null, title: 'Keeper is below its gas floor',
      detail: `${fmt(bal)} WETH < floor ${fmt(gasFloor)}. The keeper is skipping every rebalance and compound. Fund ${keeper} with WETH (asset 20).` } };
  }
  if (bal.lt(gasWarn)) {
    return { wei: bal, finding: { key: 'gas', severity: 'warning', vault: null, title: 'Keeper gas is running low',
      detail: `${fmt(bal)} WETH, floor is ${fmt(gasFloor)}. Top up ${keeper} before it stops acting.` } };
  }
  return { wei: bal, finding: null };
}

export async function runChecks(
  pool: Pool,
  p: ethers.providers.Provider,
  memo: Memo,
): Promise<{ snapshot: Snapshot; findings: Finding[] }> {
  const out: Finding[] = [];
  const now = Math.floor(Date.now() / 1000);
  const t = pool.thresholds;
  const { dec0, dec1 } = pool;
  const push = (f: Omit<Finding, 'vault'>) => out.push({ ...f, vault: pool.id });

  // --- deposits gate -------------------------------------------------------
  const poolC = new ethers.Contract(pool.pool, ABI.pool, p);
  const vault = new ethers.Contract(pool.vault, ABI.vault, p);
  const [slot0, bl, bu, ll, lu, limPos, tots] = await Promise.all([
    poolC.slot0(), vault.baseLower(), vault.baseUpper(),
    vault.limitLower(), vault.limitUpper(), vault.getLimitPosition(), vault.getTotalAmounts(),
  ]);
  const tick = Number(slot0.tick), lo = Number(bl), hi = Number(bu);
  const limLo = Number(ll), limHi = Number(lu);
  if (lo !== hi && (tick < lo || tick >= hi)) {
    push({ key: 'out-of-band', severity: 'critical', title: 'Spot is outside the vault band',
      detail: `tick ${tick} outside [${lo},${hi}] — ClearingV2 rejects every deposit with "price out of base range" until the keeper re-centres.` });
  }

  // --- liveness: work that was DUE and did not happen -----------------------
  // Mirrors the keeper's own trigger: drift = |spot - mid(base)| against
  // REBALANCE_THRESHOLD_MULT * tickSpacing. A static nonce proves nothing —
  // a healthy keeper is silent for days — so this is the only honest signal.
  const spacing = Number(await poolC.tickSpacing());
  const mid = Math.trunc((lo + hi) / 2);
  const drift = Math.abs(tick - mid);
  const threshold = t.REBALANCE_THRESHOLD_MULT * spacing;
  const proxy = new ethers.Contract(pool.proxy, ABI.proxy, p);
  const lastRebalance = Number(await proxy.lastRebalance(pool.vault));
  const since = now - lastRebalance;
  const allowance = t.MIN_INTERVAL_SECS + t.REBALANCE_GRACE_SECS;
  if (lo !== hi && drift > threshold && since > allowance) {
    push({ key: 'rebalance-overdue', severity: 'critical',
      title: 'A rebalance was due and has not happened',
      detail: `drift ${drift} > threshold ${threshold} ticks, and the last rebalance was ${Math.round(since / 3600)}h ago (allowance ${Math.round(allowance / 3600)}h). No price gate explains it — check the keeper is running and its key is funded.` });
  }

  // nav in token1, human units, from the pool's own decimals
  const px = poolPriceHuman(tick, dec0, dec1);
  const nav = human(tots[0], dec0) * px + human(tots[1], dec1);
  const limVal = human(limPos.amount0, dec0) * px + human(limPos.amount1, dec1);

  // --- limit stranded out of range ---------------------------------------
  // The drift trigger alone misses this: the base can sit comfortably inside
  // its threshold while the one-sided limit — which routinely carries most of
  // NAV — sits entirely past spot earning nothing. The keeper's LIMIT_REFRESH
  // exists to fix it, so if it has not, something is stopping it. A keeper with
  // the refresh disabled will never fix it, so there is nothing to blame.
  const outsideBy = tick >= limHi ? tick - limHi : tick < limLo ? limLo - tick : 0;
  if (t.LIMIT_REFRESH_ENABLED && limHi > limLo && outsideBy > t.LIMIT_REFRESH_TICKS && since > allowance) {
    push({ key: 'limit-stranded', severity: 'warning',
      title: 'Limit position is stranded out of range',
      detail: `spot ${tick} is ${outsideBy} ticks outside the limit [${limLo},${limHi}] (refresh fires past ${t.LIMIT_REFRESH_TICKS}), and nothing has re-placed it for ${Math.round(since / 3600)}h. ` +
        `${limVal.toFixed(0)} of ${nav.toFixed(0)} NAV (${nav > 0 ? ((limVal / nav) * 100).toFixed(0) : '?'}%) is parked out of range earning nothing.` });
  }

  let paused: boolean | null = null;
  if (pool.clearing) {
    const clearing = new ethers.Contract(pool.clearing, ABI.clearing, p);
    paused = Boolean(await clearing.paused());
    if (paused) {
      push({ key: 'paused', severity: 'warning', title: 'ClearingV2 is paused',
        detail: 'Deposits are disabled. Intentional if governance did it; otherwise investigate.' });
    }
  }

  // --- oracle: only where the keeper has a clamp to mirror --------------------
  let feedPx: number | null = null, bps: number | null = null, age: number | null = null;
  let oracleTick: number | null = null, twapTick: number | null = null, devTicks: number | null = null;
  if (pool.feed) {
    const a = await readFeed(new ethers.Contract(pool.feed, ABI.feed, p));
    const b = pool.feed1 ? await readFeed(new ethers.Contract(pool.feed1, ABI.feed, p)) : null;
    // the stalest feed sets the age, so a fresh one cannot mask a frozen one
    age = now - Math.min(a.ts, b?.ts ?? a.ts);
    if (age > t.STALE_SECONDS!) {
      push({ key: 'feed-stale', severity: 'critical', title: 'Price feed is stale',
        detail: `last update ${age}s ago, ceiling ${t.STALE_SECONDS}s. The keeper's oracle clamp will refuse to rebalance.` });
    }
    feedPx = feedPriceHuman(a.usd, b?.usd ?? null, pool.feed0Side);
    bps = Math.abs(px - feedPx) / feedPx * 1e4;

    // Mirror the keeper's clamp on ITS OWN reference (the TWAP), not on spot.
    oracleTick = tickFromHuman(feedPx, dec0, dec1);
    const twap = t.TWAP_ENABLED ? await poolTwapTick(poolC, t.TWAP_WINDOW_SECS, t.MIN_TWAP_WINDOW_SECS, now) : undefined;
    twapTick = twap ?? null;
    const ref = twap ?? tick;
    devTicks = Math.abs(ref - oracleTick);

    if (devTicks > t.ORACLE_MAX_DEV_TICKS!) {
      // The keeper is RIGHT to hold here, so an overdue rebalance is not its
      // fault. But it is not a non-event either: while this holds, nothing can
      // re-centre or re-place the limit, so say so instead of going quiet.
      const i = out.findIndex((f) => f.key === 'rebalance-overdue');
      const wasOverdue = i >= 0;
      if (wasOverdue) out.splice(i, 1);
      const j = out.findIndex((f) => f.key === 'limit-stranded');
      const wasStranded = j >= 0;
      if (wasStranded) out.splice(j, 1);
      // A clamp that trips while there is no work waiting is a non-event: the
      // gate does that routinely on any fast move. Only report it when it is
      // demonstrably holding something up.
      if (wasOverdue || wasStranded) push({
        key: 'clamp-blocking', severity: 'warning',
        title: 'Oracle clamp is blocking the keeper',
        detail:
          `pool ${twap === undefined ? 'spot' : `${t.TWAP_WINDOW_SECS}s TWAP`} ${ref} vs oracle ${oracleTick} ` +
          `= ${devTicks} ticks, over ORACLE_MAX_DEV_TICKS ${t.ORACLE_MAX_DEV_TICKS}. No rebalance, limit refresh or ` +
          `compound can run until this closes` +
          ` (blocking: ${[wasOverdue && 'an overdue rebalance', wasStranded && 'a stranded limit'].filter(Boolean).join(' and ')})` +
          `. Spot vs oracle is ${Math.abs(tick - oracleTick)} ticks — a large gap here with a small spot gap means the ` +
          `pool TWAP is lagging a fast move, not that the pool is being manipulated.`,
      });
    }

    if (bps > t.DIVERGENCE_BPS) {
      push({ key: 'divergence', severity: 'warning', title: 'Pool has drifted from the oracle',
        detail: `pool ${px.toFixed(6)} vs feed ${feedPx.toFixed(6)} = ${bps.toFixed(0)} bps (limit ${t.DIVERGENCE_BPS}). With liquidity present this should be arbitraged away; persistent drift means no arbitrage is reaching the pool.` });
    }
  }

  memo.failures = 0;
  memo.lastOkTs = now;
  const snapshot: Snapshot = {
    checkedAt: new Date(now * 1000).toISOString(),
    tick, base: [lo, hi], limit: [limLo, limHi], drift, threshold,
    lastRebalanceTs: lastRebalance, sinceSecs: since, allowanceSecs: allowance, limitOutsideBy: outsideBy,
    paused, feedPx, poolPx: px, divergenceBps: bps, oracleTick, twapTick, devTicks,
    spotDevTicks: oracleTick === null ? null : Math.abs(tick - oracleTick), feedAgeSecs: age,
    navToken1: nav, limitValueToken1: limVal,
  };
  return { snapshot, findings: out };
}
