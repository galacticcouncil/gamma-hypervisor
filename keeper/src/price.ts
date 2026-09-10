import { ethers } from 'ethers';

// Float-domain price helpers. Doubles carry ~15-16 significant digits; every
// consumer here (surplus-side choice, min bounds with a ≥1% tolerance, oracle
// deviation in whole ticks) tolerates far more error than that, so this stays
// simpler than a fixed-point port of TickMath.

const Q96 = Math.pow(2, 96);
const LOG_1_0001 = Math.log(1.0001);

/** Raw pool price (token1 per token0, raw units) from slot0's sqrtPriceX96. */
export function priceFromSqrtX96(sqrtPriceX96: ethers.BigNumber): number {
  const s = Number(sqrtPriceX96.toString()) / Q96;
  return s * s;
}

/** sqrt(price) for a tick, in raw units (no X96 scaling). */
export function sqrtPriceFromTick(tick: number): number {
  return Math.pow(1.0001, tick / 2);
}

/** Nearest tick for a raw pool price. */
export function tickFromPrice(priceRaw: number): number {
  return Math.round(Math.log(priceRaw) / LOG_1_0001);
}

/** BigNumber from a float, flooring; non-finite or negative clamps to 0. */
export function bnFloor(x: number): ethers.BigNumber {
  if (!Number.isFinite(x) || x <= 0) return ethers.constants.Zero;
  return ethers.BigNumber.from(BigInt(Math.floor(x)).toString());
}

export function toFloat(x: ethers.BigNumber): number {
  return Number(x.toString());
}
