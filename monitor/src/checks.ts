import { ethers } from 'ethers';
import type { Config } from './config';

export interface Finding {
  key: string;
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
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

export interface Memo { /* reserved */ }

export async function runChecks(cfg: Config, p: ethers.providers.JsonRpcProvider, memo: Memo): Promise<Finding[]> {
  const out: Finding[] = [];
  const now = Math.floor(Date.now() / 1000);
  const fmt = (w: ethers.BigNumber) => ethers.utils.formatEther(w);

  // --- gas -----------------------------------------------------------------
  const bal = await p.getBalance(cfg.KEEPER);
  if (bal.lt(cfg.gasFloor)) {
    out.push({ key: 'gas-floor', severity: 'critical', title: 'Keeper is below its gas floor',
      detail: `${fmt(bal)} WETH < floor ${fmt(cfg.gasFloor)}. The keeper is skipping every rebalance and compound. Fund ${cfg.KEEPER} with WETH (asset 20).` });
  } else if (bal.lt(cfg.gasWarn)) {
    out.push({ key: 'gas-warn', severity: 'warning', title: 'Keeper gas is running low',
      detail: `${fmt(bal)} WETH, floor is ${fmt(cfg.gasFloor)}. Top up ${cfg.KEEPER} before it stops acting.` });
  }


  // --- deposits gate -------------------------------------------------------
  const pool = new ethers.Contract(cfg.POOL, ABI.pool, p);
  const vault = new ethers.Contract(cfg.VAULT, ABI.vault, p);
  const [slot0, bl, bu, ll, lu, limPos] = await Promise.all([
    pool.slot0(), vault.baseLower(), vault.baseUpper(),
    vault.limitLower(), vault.limitUpper(), vault.getLimitPosition(),
  ]);
  const tick = Number(slot0.tick), lo = Number(bl), hi = Number(bu);
  const limLo = Number(ll), limHi = Number(lu);
  if (lo !== hi && (tick < lo || tick >= hi)) {
    out.push({ key: 'out-of-band', severity: 'critical', title: 'Spot is outside the vault band',
      detail: `tick ${tick} outside [${lo},${hi}] — ClearingV2 rejects every deposit with "price out of base range" until the keeper re-centres.` });
  }

  // --- liveness: work that was DUE and did not happen -----------------------
  // Mirrors the keeper's own trigger: drift = |spot - mid(base)| against
  // REBALANCE_THRESHOLD_MULT * tickSpacing. A static nonce proves nothing —
  // a healthy keeper is silent for days — so this is the only honest signal.
  const spacing = Number(await pool.tickSpacing());
  const mid = Math.trunc((lo + hi) / 2);
  const drift = Math.abs(tick - mid);
  const threshold = cfg.REBALANCE_THRESHOLD_MULT * spacing;
  const proxy = new ethers.Contract(cfg.REBALANCE_PROXY, ABI.proxy, p);
  const lastRebalance = Number(await proxy.lastRebalance(cfg.VAULT));
  const since = now - lastRebalance;
  const allowance = cfg.MIN_INTERVAL_SECS + cfg.REBALANCE_GRACE_SECS;
  if (lo !== hi && drift > threshold && since > allowance) {
    out.push({ key: 'rebalance-overdue', severity: 'critical',
      title: 'A rebalance was due and has not happened',
      detail: `drift ${drift} > threshold ${threshold} ticks, and the last rebalance was ${Math.round(since / 3600)}h ago (allowance ${Math.round(allowance / 3600)}h). No price gate explains it — check the keeper is running and its key is funded.` });
  }

  // --- limit stranded out of range ---------------------------------------
  // The drift trigger alone misses this: the base can sit comfortably inside
  // its threshold while the one-sided limit — which routinely carries most of
  // NAV — sits entirely past spot earning nothing. The keeper's LIMIT_REFRESH
  // exists to fix it, so if it has not, something is stopping it.
  const outsideBy = tick >= limHi ? tick - limHi : tick < limLo ? limLo - tick : 0;
  if (limHi > limLo && outsideBy > cfg.LIMIT_REFRESH_TICKS && since > allowance) {
    const [tot0, tot1] = await vault.getTotalAmounts();
    const px = Math.pow(1.0001, tick) * 1e-8;
    const nav = Number(ethers.utils.formatUnits(tot0, 10)) * px + Number(ethers.utils.formatUnits(tot1, 18));
    const limVal = Number(ethers.utils.formatUnits(limPos.amount0, 10)) * px + Number(ethers.utils.formatUnits(limPos.amount1, 18));
    out.push({ key: 'limit-stranded', severity: 'warning',
      title: 'Limit position is stranded out of range',
      detail: `spot ${tick} is ${outsideBy} ticks outside the limit [${limLo},${limHi}] (refresh fires past ${cfg.LIMIT_REFRESH_TICKS}), and nothing has re-placed it for ${Math.round(since / 3600)}h. ` +
        `${limVal.toFixed(0)} of ${nav.toFixed(0)} NAV (${nav > 0 ? ((limVal / nav) * 100).toFixed(0) : '?'}%) is parked out of range earning nothing.` });
  }

  const clearing = new ethers.Contract(cfg.CLEARING, ABI.clearing, p);
  if (await clearing.paused()) {
    out.push({ key: 'paused', severity: 'warning', title: 'ClearingV2 is paused',
      detail: 'Deposits are disabled. Intentional if governance did it; otherwise investigate.' });
  }

  // --- oracle --------------------------------------------------------------
  const feed = new ethers.Contract(cfg.PRICE_FEED, ABI.feed, p);
  const [rd, dec] = await Promise.all([feed.latestRoundData(), feed.decimals()]);
  const age = now - Number(rd[3]);
  if (age > cfg.STALE_SECONDS) {
    out.push({ key: 'feed-stale', severity: 'critical', title: 'Price feed is stale',
      detail: `last update ${age}s ago, ceiling ${cfg.STALE_SECONDS}s. The keeper's oracle clamp will refuse to rebalance.` });
  }
  const feedPx = Number(rd[1]) / 10 ** Number(dec);
  // token0 has 10 decimals, token1 18 — the pool tick is in raw units.
  const poolPx = Math.pow(1.0001, tick) * 1e-8;
  const bps = Math.abs(poolPx - feedPx) / feedPx * 1e4;

  // Mirror the keeper's clamp on ITS OWN reference (the TWAP), not on spot.
  const oracleTick = Math.round(Math.log(feedPx * 1e8) / Math.log(1.0001));
  const twapTick = await poolTwapTick(pool, cfg.TWAP_WINDOW_SECS, cfg.MIN_TWAP_WINDOW_SECS, now);
  const ref = twapTick ?? tick;
  const devTicks = Math.abs(ref - oracleTick);

  if (devTicks > cfg.ORACLE_MAX_DEV_TICKS) {
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
    if (wasOverdue || wasStranded) out.push({
      key: 'clamp-blocking', severity: 'warning',
      title: 'Oracle clamp is blocking the keeper',
      detail:
        `pool ${twapTick === undefined ? 'spot' : `${cfg.TWAP_WINDOW_SECS}s TWAP`} ${ref} vs oracle ${oracleTick} ` +
        `= ${devTicks} ticks, over ORACLE_MAX_DEV_TICKS ${cfg.ORACLE_MAX_DEV_TICKS}. No rebalance, limit refresh or ` +
        `compound can run until this closes` +
        ` (blocking: ${[wasOverdue && 'an overdue rebalance', wasStranded && 'a stranded limit'].filter(Boolean).join(' and ')})` +
        `. Spot vs oracle is ${Math.abs(tick - oracleTick)} ticks — a large gap here with a small spot gap means the ` +
        `pool TWAP is lagging a fast move, not that the pool is being manipulated.`,
    });
  }

  if (bps > cfg.DIVERGENCE_BPS) {
    out.push({ key: 'divergence', severity: 'warning', title: 'Pool has drifted from the oracle',
      detail: `pool ${poolPx.toFixed(6)} vs feed ${feedPx.toFixed(6)} = ${bps.toFixed(0)} bps (limit ${cfg.DIVERGENCE_BPS}). With liquidity present this should be arbitraged away; persistent drift means no arbitrage is reaching the pool.` });
  }
  return out;
}
