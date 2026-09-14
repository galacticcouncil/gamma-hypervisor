import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { positionFees, positionKey, vaultFees } from '../src/feesOwed';

const Q128 = 1n << 128n;
const MASK = (1n << 256n) - 1n;
const bn = (x: bigint) => ethers.BigNumber.from(x.toString());

/** Minimal pool stub: only the five reads positionFees makes. */
function stubPool(opts: {
  g0: bigint; g1: bigint;
  lower: { fo0: bigint; fo1: bigint };
  upper: { fo0: bigint; fo1: bigint };
  pos: { liquidity: bigint; fi0: bigint; fi1: bigint; owed0?: bigint; owed1?: bigint };
  lowerTick: number; upperTick: number;
}) {
  return {
    feeGrowthGlobal0X128: async () => bn(opts.g0),
    feeGrowthGlobal1X128: async () => bn(opts.g1),
    ticks: async (t: number) => {
      const s = t === opts.lowerTick ? opts.lower : opts.upper;
      return { feeGrowthOutside0X128: bn(s.fo0), feeGrowthOutside1X128: bn(s.fo1) };
    },
    positions: async () => ({
      liquidity: bn(opts.pos.liquidity),
      feeGrowthInside0LastX128: bn(opts.pos.fi0),
      feeGrowthInside1LastX128: bn(opts.pos.fi1),
      tokensOwed0: bn(opts.pos.owed0 ?? 0n),
      tokensOwed1: bn(opts.pos.owed1 ?? 0n),
    }),
  } as unknown as ethers.Contract;
}

const OWNER = '0xa206D0959813f17c17C87147271C49065438648A';

describe('positionFees', () => {
  it('is zero for a degenerate range', async () => {
    const [a, b] = await positionFees(stubPool({
      g0: 0n, g1: 0n, lower: { fo0: 0n, fo1: 0n }, upper: { fo0: 0n, fo1: 0n },
      pos: { liquidity: 1n, fi0: 0n, fi1: 0n }, lowerTick: 10, upperTick: 10,
    }), OWNER, 10, 10, 10);
    expect(a.isZero()).toBe(true);
    expect(b.isZero()).toBe(true);
  });

  it('credits liquidity * growth-inside / 2**128 when the tick is in range', async () => {
    const [a] = await positionFees(stubPool({
      g0: 10n * Q128, g1: 0n,
      lower: { fo0: 2n * Q128, fo1: 0n },
      upper: { fo0: 3n * Q128, fo1: 0n },
      pos: { liquidity: 1_000n, fi0: 0n, fi1: 0n },
      lowerTick: 100, upperTick: 200,
    }), OWNER, 100, 200, 150);
    // inside = 10 - 2 - 3 = 5 -> 1000 * 5
    expect(a.toString()).toBe('5000');
  });

  it('flips the below/above terms once the tick leaves the range', async () => {
    // Values are chosen so `inside` stays consistent in each case, as a real
    // pool guarantees: only which term is subtracted changes.
    const base = { g1: 0n, pos: { liquidity: 1_000n, fi0: 0n, fi1: 0n }, lowerTick: 100, upperTick: 200 };
    // tick BELOW lower: below = global - lower.outside = 2, above = upper.outside = 3
    const [belowRange] = await positionFees(stubPool({
      ...base, g0: 10n * Q128, lower: { fo0: 8n * Q128, fo1: 0n }, upper: { fo0: 3n * Q128, fo1: 0n },
    }), OWNER, 100, 200, 50);
    expect(belowRange.toString()).toBe('5000');
    // tick ABOVE upper: below = lower.outside = 2, above = global - upper.outside = 3
    const [aboveRange] = await positionFees(stubPool({
      ...base, g0: 10n * Q128, lower: { fo0: 2n * Q128, fo1: 0n }, upper: { fo0: 7n * Q128, fo1: 0n },
    }), OWNER, 100, 200, 250);
    expect(aboveRange.toString()).toBe('5000');
  });

  it('handles the wrapping subtraction Solidity relies on', async () => {
    // insideLast ahead of inside: the difference underflows and must wrap, not go negative.
    const [a] = await positionFees(stubPool({
      g0: 1n * Q128, g1: 0n,
      lower: { fo0: 0n, fo1: 0n }, upper: { fo0: 0n, fo1: 0n },
      pos: { liquidity: 1n, fi0: 2n * Q128, fi1: 0n },
      lowerTick: 100, upperTick: 200,
    }), OWNER, 100, 200, 150);
    // (1 - 2) mod 2**256, divided by 2**128
    expect(a.toString()).toBe((((0n - 1n * Q128) & MASK) / Q128).toString());
  });

  it('adds already-credited tokensOwed', async () => {
    const [a, b] = await positionFees(stubPool({
      g0: 0n, g1: 0n, lower: { fo0: 0n, fo1: 0n }, upper: { fo0: 0n, fo1: 0n },
      pos: { liquidity: 0n, fi0: 0n, fi1: 0n, owed0: 77n, owed1: 88n },
      lowerTick: 100, upperTick: 200,
    }), OWNER, 100, 200, 150);
    expect(a.toString()).toBe('77');
    expect(b.toString()).toBe('88');
  });
});

describe('vaultFees', () => {
  it('sums both positions', async () => {
    const pool = stubPool({
      g0: 0n, g1: 0n, lower: { fo0: 0n, fo1: 0n }, upper: { fo0: 0n, fo1: 0n },
      pos: { liquidity: 0n, fi0: 0n, fi1: 0n, owed0: 5n, owed1: 6n },
      lowerTick: 100, upperTick: 200,
    });
    const [a, b] = await vaultFees(pool, OWNER, [100, 200], [100, 200], 150);
    expect(a.toString()).toBe('10');
    expect(b.toString()).toBe('12');
  });
});

describe('positionKey', () => {
  it('matches Uniswap’s keccak(owner, lower, upper)', () => {
    expect(positionKey(OWNER, 184500, 186480)).toBe(
      ethers.utils.solidityKeccak256(['address', 'int24', 'int24'], [OWNER, 184500, 186480]),
    );
  });
});
