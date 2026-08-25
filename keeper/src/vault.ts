import { ethers } from 'ethers';
import type { BaseSplit } from './mins';
import type { LimitSide } from './ticks';

export async function readTotalAmounts(
  vault: ethers.Contract,
): Promise<[ethers.BigNumber, ethers.BigNumber]> {
  const r = await vault.getTotalAmounts();
  return [r.total0, r.total1];
}

export interface PositionAmounts {
  liquidity: ethers.BigNumber;
  amount0: ethers.BigNumber;
  amount1: ethers.BigNumber;
}

export async function readPositions(
  vault: ethers.Contract,
): Promise<{ base: PositionAmounts; limit: PositionAmounts }> {
  const [b, l] = await Promise.all([vault.getBasePosition(), vault.getLimitPosition()]);
  return {
    base: { liquidity: b.liquidity, amount0: b.amount0, amount1: b.amount1 },
    limit: { liquidity: l.liquidity, amount0: l.amount0, amount1: l.amount1 },
  };
}

/**
 * Which side the one-sided limit range goes: surplus token0 -> above the tick
 * (an above-tick range is 100% token0), surplus token1 -> below.
 *
 * The comparison is on what is left AFTER the base range takes its share, which
 * is what AutoRebal.liquidityOptions does (`(total0-amount0)*price >
 * (total1-amount1)`, proxy/AutoRebal.sol:66). Comparing raw totals instead is
 * wrong whenever the band is not symmetric around the price — which is exactly
 * the normal case here, since the band is centered on the TWAP and may also be
 * translation-clamped, so it is routinely offset from spot.
 *
 * Residual quantities come from the spot-price split (that is mechanically what
 * the mint will consume); they are valued at `priceRaw`, the placement price.
 */
export function surplusSide(split: BaseSplit, priceRaw: number): LimitSide {
  return split.residual0 * priceRaw > split.residual1 ? 'above' : 'below';
}

/**
 * The vault's own token balances. This is exactly what `compound()` re-mints —
 * `getTotalAmounts()` is the wrong number, because it also counts the tokens
 * already sitting inside the Uniswap positions.
 */
export async function readIdleBalances(
  token0: ethers.Contract,
  token1: ethers.Contract,
  vault: string,
): Promise<[ethers.BigNumber, ethers.BigNumber]> {
  const [b0, b1] = await Promise.all([token0.balanceOf(vault), token1.balanceOf(vault)]);
  return [b0, b1];
}
