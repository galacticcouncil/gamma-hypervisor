import { ethers } from 'ethers';
import { bnFloor, sqrtPriceFromTick, toFloat } from './price';
import type { LimitSide } from './ticks';
import type { PositionAmounts } from './vault';

export interface Mins {
  inMin: ethers.BigNumber[];
  outMin: ethers.BigNumber[];
}

/**
 * What the re-mint into `newBase` is predicted to consume, and what is left over
 * afterwards. The leftovers are what the one-sided limit range parks, so this
 * drives BOTH the limit-side choice and the mint bounds — the two must agree or
 * the limit range is placed on the side holding nothing.
 */
export interface BaseSplit {
  base0: number;
  base1: number;
  residual0: number;
  residual1: number;
}

/**
 * Uniswap v3 `getLiquidityForAmounts` / `getAmountsForLiquidity` in the raw
 * (non-X96) sqrt domain. The smaller of the two liquidity figures binds; the
 * amounts are then read back out of it.
 */
export function splitForBand(
  total0: ethers.BigNumber,
  total1: ethers.BigNumber,
  sqrtPriceX96: ethers.BigNumber,
  newBase: [number, number],
): BaseSplit {
  const t0 = toFloat(total0);
  const t1 = toFloat(total1);
  const sa = sqrtPriceFromTick(newBase[0]);
  const sb = sqrtPriceFromTick(newBase[1]);
  const spRaw = toFloat(sqrtPriceX96) / Math.pow(2, 96);
  // Clamping handles the out-of-range cases: price below the band makes it 100%
  // token0, above makes it 100% token1.
  const sp = Math.min(Math.max(spRaw, sa), sb);

  const l0 = sp < sb ? (t0 * sp * sb) / (sb - sp) : Number.POSITIVE_INFINITY;
  const l1 = sp > sa ? t1 / (sp - sa) : Number.POSITIVE_INFINITY;
  const L = Math.min(l0, l1);

  let base0 = 0;
  let base1 = 0;
  if (Number.isFinite(L) && L > 0) {
    base0 = (L * (sb - sp)) / (sp * sb);
    base1 = L * (sp - sa);
  }

  return {
    base0,
    base1,
    residual0: Math.max(0, t0 - base0),
    residual1: Math.max(0, t1 - base1),
  };
}

export interface MinsInput {
  split: BaseSplit;
  /** Current positions — the burn expectation. */
  base: PositionAmounts;
  limit: PositionAmounts;
  side: LimitSide;
  toleranceBps: number;
}

// Non-zero rebalance mins: each bound is the predicted burn/mint amount at the
// decision-time price, less a tolerance. If the price is pushed between our read
// and the tx landing (the sandwich-the-rebalance vector), the position
// composition shifts, a bound fails, and the whole rebalance reverts instead of
// executing at the manipulated price.
//
// Tolerance note: a leg's amount moves far faster than price — for a ±600-tick
// band the default 1000 bps corresponds to only ~0.6% of price drift, and for a
// ±300-tick band ~0.3%. Widen it for narrow bands or volatile pairs, or expect
// benign reverts; see keeper/README.md.
export function computeMins(i: MinsInput): Mins {
  const k = 1 - i.toleranceBps / 10_000;

  // outMin — burning the current positions must return ≈ what they hold now.
  // getBasePosition/getLimitPosition add tokensOwed, but zeroBurn() collects
  // those before the burn, so these figures are principal in practice.
  const outMin = [
    bnFloor(toFloat(i.base.amount0) * k),
    bnFloor(toFloat(i.base.amount1) * k),
    bnFloor(toFloat(i.limit.amount0) * k),
    bnFloor(toFloat(i.limit.amount1) * k),
  ];

  // inMin — the base takes what the price ratio dictates; the surplus parks
  // one-sided in the limit range.
  const limit0 = i.side === 'above' ? i.split.residual0 : 0;
  const limit1 = i.side === 'below' ? i.split.residual1 : 0;
  const inMin = [
    bnFloor(i.split.base0 * k),
    bnFloor(i.split.base1 * k),
    bnFloor(limit0 * k),
    bnFloor(limit1 * k),
  ];
  return { inMin, outMin };
}
