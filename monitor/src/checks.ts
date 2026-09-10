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
  ],
  vault: [
    'function baseLower() view returns (int24)',
    'function baseUpper() view returns (int24)',
    'function totalSupply() view returns (uint256)',
  ],
  clearing: ['function paused() view returns (bool)'],
  feed: ['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)', 'function decimals() view returns (uint8)'],
};

/** Nonce is the only liveness signal that survives the container being gone. */
export interface Memo { lastNonce?: number; lastNonceAt?: number }

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

  // --- liveness ------------------------------------------------------------
  // Silence is normal when there is nothing to do, so this only fires once the
  // gap exceeds a compound interval by a wide margin.
  const nonce = await p.getTransactionCount(cfg.KEEPER);
  if (memo.lastNonce === undefined || nonce !== memo.lastNonce) {
    memo.lastNonce = nonce;
    memo.lastNonceAt = now;
  } else if (memo.lastNonceAt && now - memo.lastNonceAt > cfg.STALL_MINUTES * 60) {
    const mins = Math.round((now - memo.lastNonceAt) / 60);
    out.push({ key: 'stalled', severity: 'critical', title: 'Keeper has sent nothing for hours',
      detail: `nonce stuck at ${nonce} for ${mins} min (threshold ${cfg.STALL_MINUTES}). Container down, wedged, or unable to price a transaction.` });
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
  if (bps > cfg.DIVERGENCE_BPS) {
    out.push({ key: 'divergence', severity: 'warning', title: 'Pool has drifted from the oracle',
      detail: `pool ${poolPx.toFixed(6)} vs feed ${feedPx.toFixed(6)} = ${bps.toFixed(0)} bps (limit ${cfg.DIVERGENCE_BPS}). With liquidity present this should be arbitraged away; persistent drift means no arbitrage is reaching the pool.` });
  }
  return out;
}
