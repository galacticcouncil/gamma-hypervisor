import { ethers } from 'ethers';

/**
 * Uncollected swap fees sitting inside a Uniswap v3 position.
 *
 * These are NOT the vault's token balance. A position accrues fees into the
 * pool's `feeGrowthGlobal` accumulators, and they are only credited to
 * `tokensOwed` — let alone transferred out — when the position is poked by a
 * burn, mint or collect. So a vault can hold real, growing fees while its ERC-20
 * balance reads zero.
 *
 * That distinction is the whole point of this module: gating a compound on the
 * idle balance alone means the sweep can never see the fees it exists to sweep,
 * because the only thing that makes them idle is the sweep itself.
 *
 * Formula is Uniswap's own (Position.sol / Tick.sol):
 *
 *   feeGrowthBelow = tick >= lower ? lower.outside : global - lower.outside
 *   feeGrowthAbove = tick <  upper ? upper.outside : global - upper.outside
 *   inside         = global - below - above
 *   owed          += liquidity * (inside - insideLast) / 2**128
 *
 * All of it is unchecked wrapping arithmetic on uint256 in Solidity, so every
 * subtraction here is masked back into range rather than allowed to go negative.
 */
const MASK = (1n << 256n) - 1n;
/** ethers v5 BigNumber has no toBigInt(); go through the decimal string. */
const big = (x: ethers.BigNumber): bigint => BigInt(x.toString());
const Q128 = 1n << 128n;

export const POOL_FEES_ABI = [
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
  'function positions(bytes32) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
];

export function positionKey(owner: string, lower: number, upper: number): string {
  return ethers.utils.solidityKeccak256(['address', 'int24', 'int24'], [owner, lower, upper]);
}

/** Fees owed to one position: already-credited `tokensOwed` plus what has accrued since. */
export async function positionFees(
  pool: ethers.Contract,
  owner: string,
  lower: number,
  upper: number,
  tick: number,
): Promise<[ethers.BigNumber, ethers.BigNumber]> {
  if (lower === upper) return [ethers.constants.Zero, ethers.constants.Zero];
  const [g0, g1, lo, hi, pos] = await Promise.all([
    pool.feeGrowthGlobal0X128(),
    pool.feeGrowthGlobal1X128(),
    pool.ticks(lower),
    pool.ticks(upper),
    pool.positions(positionKey(owner, lower, upper)),
  ]);
  const G0 = big(g0), G1 = big(g1);
  const lo0 = big(lo.feeGrowthOutside0X128), lo1 = big(lo.feeGrowthOutside1X128);
  const hi0 = big(hi.feeGrowthOutside0X128), hi1 = big(hi.feeGrowthOutside1X128);
  const below0 = tick >= lower ? lo0 : (G0 - lo0) & MASK;
  const below1 = tick >= lower ? lo1 : (G1 - lo1) & MASK;
  const above0 = tick < upper ? hi0 : (G0 - hi0) & MASK;
  const above1 = tick < upper ? hi1 : (G1 - hi1) & MASK;
  const inside0 = (G0 - below0 - above0) & MASK;
  const inside1 = (G1 - below1 - above1) & MASK;
  const liq = big(pos.liquidity);
  const accrued0 = (liq * ((inside0 - big(pos.feeGrowthInside0LastX128)) & MASK)) / Q128;
  const accrued1 = (liq * ((inside1 - big(pos.feeGrowthInside1LastX128)) & MASK)) / Q128;
  return [
    ethers.BigNumber.from((accrued0 + big(pos.tokensOwed0)).toString()),
    ethers.BigNumber.from((accrued1 + big(pos.tokensOwed1)).toString()),
  ];
}

/** Fees owed across both of a Hypervisor's positions. */
export async function vaultFees(
  pool: ethers.Contract,
  vault: string,
  base: [number, number],
  limit: [number, number],
  tick: number,
): Promise<[ethers.BigNumber, ethers.BigNumber]> {
  const [b, l] = await Promise.all([
    positionFees(pool, vault, base[0], base[1], tick),
    positionFees(pool, vault, limit[0], limit[1], tick),
  ]);
  return [b[0].add(l[0]), b[1].add(l[1])];
}
