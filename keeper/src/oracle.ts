import { ethers } from 'ethers';
import { tickFromPrice } from './price';

export interface OracleReading {
  tick: number;
  ageSecs: number;
}

export interface OracleInput {
  oracle: ethers.Contract;
  /** token0's feed key, e.g. "DOT/USD". */
  key0: string;
  /** token1's feed key; omit when token1 is the USD-pegged side (e.g. HOLLAR). */
  key1?: string;
  /** Feed value decimals (DIA: 8). Only used in one-feed mode — ratios cancel. */
  priceDecimals: number;
  decimals0: number;
  decimals1: number;
  nowTs: number;
}

// External-truth clamp (DIA-style getValue feeds): the pool tick the outside
// world implies. A swap through our thin pool moves spot and (slowly) the pool
// TWAP, but cannot move Binance et al. — so requiring the pool TWAP to agree
// with this tick makes "manipulate the pool, wait for the keeper" unprofitable.
// Callers must treat any throw as fail-closed (skip the rebalance).
export async function readOracleTick(o: OracleInput): Promise<OracleReading> {
  const [v0, ts0] = await o.oracle.getValue(o.key0);
  if (ethers.BigNumber.from(v0).isZero()) throw new Error(`oracle ${o.key0} returned 0`);

  let priceHuman: number;
  let oldestTs = Number(ts0.toString());
  if (o.key1) {
    const [v1, ts1] = await o.oracle.getValue(o.key1);
    if (ethers.BigNumber.from(v1).isZero()) throw new Error(`oracle ${o.key1} returned 0`);
    priceHuman = Number(v0.toString()) / Number(v1.toString());
    oldestTs = Math.min(oldestTs, Number(ts1.toString()));
  } else {
    priceHuman = Number(v0.toString()) / Math.pow(10, o.priceDecimals);
  }
  if (!(priceHuman > 0) || !Number.isFinite(priceHuman)) {
    throw new Error(`oracle price not usable: ${priceHuman}`);
  }

  // Human price (token1 per token0) -> raw pool price -> tick.
  const priceRaw = priceHuman * Math.pow(10, o.decimals1 - o.decimals0);
  return { tick: tickFromPrice(priceRaw), ageSecs: Math.max(0, o.nowTs - oldestTs) };
}
