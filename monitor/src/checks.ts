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
    'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)',
    'function liquidity() view returns (uint128)',
    'function tickSpacing() view returns (int24)',
  ],
  proxy: ['function lastRebalance(address) view returns (uint256)'],
  vault: [
    'function baseLower() view returns (int24)',
    'function baseUpper() view returns (int24)',
    'function totalSupply() view returns (uint256)',
  ],
  clearing: ['function paused() view returns (bool)'],
  feed: ['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)', 'function decimals() view returns (uint8)'],
};

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
  const [slot0, bl, bu] = await Promise.all([pool.slot0(), vault.baseLower(), vault.baseUpper()]);
  const tick = Number(slot0.tick), lo = Number(bl), hi = Number(bu);
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
      detail: `drift ${drift} > threshold ${threshold} ticks, and the last rebalance was ${Math.round(since / 3600)}h ago (allowance ${Math.round(allowance / 3600)}h). The keeper is down, wedged, or unable to submit.` });
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
  // The keeper legitimately refuses to rebalance while pool and oracle disagree
  // by more than ORACLE_MAX_DEV_TICKS — that is the anti-manipulation clamp, not
  // a fault. Withdraw the overdue alert rather than blaming it for holding.
  const devTicks = Math.abs(Math.log(poolPx / feedPx) / Math.log(1.0001));
  if (devTicks > cfg.ORACLE_MAX_DEV_TICKS) {
    const i = out.findIndex((f) => f.key === 'rebalance-overdue');
    if (i >= 0) out.splice(i, 1);
  }

  if (bps > cfg.DIVERGENCE_BPS) {
    out.push({ key: 'divergence', severity: 'warning', title: 'Pool has drifted from the oracle',
      detail: `pool ${poolPx.toFixed(6)} vs feed ${feedPx.toFixed(6)} = ${bps.toFixed(0)} bps (limit ${cfg.DIVERGENCE_BPS}). With liquidity present this should be arbitraged away; persistent drift means no arbitrage is reaching the pool.` });
  }
  return out;
}
