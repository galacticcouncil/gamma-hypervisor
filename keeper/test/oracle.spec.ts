import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { readOracleTick } from '../src/oracle';
import { tickFromPrice } from '../src/price';

// Minimal stand-in for a Chainlink AggregatorV3 feed. Hydration's feeds carry 8
// decimals; the reader must scale by decimals() rather than assume.
function fakeFeed(usd: number | string, updatedAt: number, decimals = 8) {
  return {
    address: '0xfeed',
    latestRoundData: async () => ({
      roundId: ethers.BigNumber.from(1),
      answer: ethers.BigNumber.from(
        typeof usd === 'string' ? usd : ethers.utils.parseUnits(String(usd), decimals)
      ),
      startedAt: ethers.BigNumber.from(updatedAt),
      updatedAt: ethers.BigNumber.from(updatedAt),
      answeredInRound: ethers.BigNumber.from(1),
    }),
    decimals: async () => decimals,
  } as unknown as ethers.Contract;
}

const NOW = 1_800_000_000;

describe('readOracleTick', () => {
  it('converts a two-feed ratio into the expected pool tick (equal decimals)', async () => {
    // DOT $4, HOLLAR $1 -> 4 HOLLAR per DOT.
    const o = await readOracleTick({
      feed0Side: 'token0' as const,
      feed0: fakeFeed(4, NOW),
      feed1: fakeFeed(1, NOW),
      decimals0: 18,
      decimals1: 18,
      nowTs: NOW,
    });
    expect(o.tick).toBe(tickFromPrice(4));
    expect(o.ageSecs).toBe(0);
  });

  it('adjusts for differing token decimals', async () => {
    // Human price 4, but token0 has 10 decimals and token1 18 -> raw price 4e8.
    const o = await readOracleTick({
      feed0Side: 'token0' as const,
      feed0: fakeFeed(4, NOW),
      feed1: fakeFeed(1, NOW),
      decimals0: 10,
      decimals1: 18,
      nowTs: NOW,
    });
    expect(o.tick).toBe(tickFromPrice(4 * 1e8));
  });

  it('supports one-feed mode when token1 is the USD side', async () => {
    const o = await readOracleTick({
      feed0Side: 'token0' as const,
      feed0: fakeFeed(4, NOW),
      decimals0: 18,
      decimals1: 18,
      nowTs: NOW,
    });
    expect(o.tick).toBe(tickFromPrice(4));
  });

  it('scales by the feed decimals rather than assuming 8', async () => {
    const eight = await readOracleTick({
      feed0Side: 'token0' as const,
      feed0: fakeFeed(4, NOW, 8),
      decimals0: 18,
      decimals1: 18,
      nowTs: NOW,
    });
    const eighteen = await readOracleTick({
      feed0Side: 'token0' as const,
      feed0: fakeFeed(4, NOW, 18),
      decimals0: 18,
      decimals1: 18,
      nowTs: NOW,
    });
    expect(eighteen.tick).toBe(eight.tick);
  });

  it('reports the age of the STALEST feed', async () => {
    const o = await readOracleTick({
      feed0Side: 'token0' as const,
      feed0: fakeFeed(4, NOW - 30),
      feed1: fakeFeed(1, NOW - 900),
      decimals0: 18,
      decimals1: 18,
      nowTs: NOW,
    });
    expect(o.ageSecs).toBe(900);
  });

  it('throws on a zero price rather than reporting tick 0', async () => {
    await expect(
      readOracleTick({
        feed0Side: 'token0' as const,
      feed0: fakeFeed('0', NOW),
        decimals0: 18,
        decimals1: 18,
        nowTs: NOW,
      }),
    ).rejects.toThrow(/returned 0/);
  });

  it('throws on a negative answer (int256 can go below zero)', async () => {
    await expect(
      readOracleTick({
        feed0Side: 'token0' as const,
      feed0: fakeFeed('-100000000', NOW),
        decimals0: 18,
        decimals1: 18,
        nowTs: NOW,
      }),
    ).rejects.toThrow(/returned -/);
  });

  it('propagates a failing feed so the caller fails closed', async () => {
    const broken = {
      address: '0xdead',
      latestRoundData: async () => {
        throw new Error('call revert exception');
      },
      decimals: async () => 8,
    } as unknown as ethers.Contract;
    await expect(
      readOracleTick({ feed0Side: 'token0', feed0: broken, decimals0: 18, decimals1: 18, nowTs: NOW }),
    ).rejects.toThrow(/revert/);
  });
});

// A rate source is the stableswap precompile: latestAnswer()/decimals() only.
// Deliberately has NO latestRoundData — calling it on the real thing reverts,
// and a fake that lacks it will throw the same way if the reader ever reaches
// for it.
function fakeRate(rate: number | string, decimals = 8, address = '0xrate') {
  return {
    address,
    latestAnswer: async () =>
      ethers.BigNumber.from(typeof rate === 'string' ? rate : ethers.utils.parseUnits(String(rate), decimals)),
    decimals: async () => decimals,
  } as unknown as ethers.Contract;
}

describe('readOracleTick with a rate source (wrapper/share tokens)', () => {
  // GETH/HOLLAR on mainnet: HOLLAR sorts first, so feed0 (ETH/USD) prices
  // token1, and the rate is aETH per GETH share from the stableswap precompile.
  // Pool price = GETH per HOLLAR = 1 / (ETH_USD × rate).
  it('lifts the underlying feed by the rate before orienting (the GETH case)', async () => {
    const o = await readOracleTick({
      feed0Side: 'token1',
      feed0: fakeFeed(2713.96, NOW),
      rate: fakeRate(1.0160919),
      decimals0: 18,
      decimals1: 18,
      nowTs: NOW,
    });
    expect(o.price).toBeCloseTo(1 / (2713.96 * 1.0160919), 12);
    expect(o.tick).toBe(tickFromPrice(1 / (2713.96 * 1.0160919)));
  });

  it('applies the rate on the token0 side too', async () => {
    const o = await readOracleTick({
      feed0Side: 'token0',
      feed0: fakeFeed(4, NOW),
      rate: fakeRate(1.5),
      decimals0: 18,
      decimals1: 18,
      nowTs: NOW,
    });
    expect(o.tick).toBe(tickFromPrice(6));
  });

  it('is exactly the un-rated reading when the rate is 1', async () => {
    const plain = await readOracleTick({ feed0Side: 'token0', feed0: fakeFeed(4, NOW), decimals0: 18, decimals1: 18, nowTs: NOW });
    const rated = await readOracleTick({ feed0Side: 'token0', feed0: fakeFeed(4, NOW), rate: fakeRate(1), decimals0: 18, decimals1: 18, nowTs: NOW });
    expect(rated.tick).toBe(plain.tick);
  });

  it('scales by the rate source decimals rather than assuming 8', async () => {
    const eight = await readOracleTick({ feed0Side: 'token0', feed0: fakeFeed(4, NOW), rate: fakeRate(1.5, 8), decimals0: 18, decimals1: 18, nowTs: NOW });
    const eighteen = await readOracleTick({ feed0Side: 'token0', feed0: fakeFeed(4, NOW), rate: fakeRate(1.5, 18), decimals0: 18, decimals1: 18, nowTs: NOW });
    expect(eighteen.tick).toBe(eight.tick);
  });

  it('takes its age from the feed — the rate is live state with no timestamp', async () => {
    const o = await readOracleTick({
      feed0Side: 'token1',
      feed0: fakeFeed(2700, NOW - 1234),
      rate: fakeRate(1.01),
      decimals0: 18,
      decimals1: 18,
      nowTs: NOW,
    });
    expect(o.ageSecs).toBe(1234);
  });

  it('composes with a second feed', async () => {
    // feed0 = $2700 underlying × 1.01 rate on token1; feed1 = $1 on token0.
    const o = await readOracleTick({
      feed0Side: 'token1',
      feed0: fakeFeed(2700, NOW),
      feed1: fakeFeed(1, NOW),
      rate: fakeRate(1.01),
      decimals0: 18,
      decimals1: 18,
      nowTs: NOW,
    });
    expect(o.tick).toBe(tickFromPrice(1 / (2700 * 1.01)));
  });

  it('throws on a zero rate rather than pricing the pool token at zero', async () => {
    await expect(
      readOracleTick({ feed0Side: 'token0', feed0: fakeFeed(4, NOW), rate: fakeRate('0'), decimals0: 18, decimals1: 18, nowTs: NOW }),
    ).rejects.toThrow(/rate source .* returned 0/);
  });

  it('throws on a negative rate', async () => {
    await expect(
      readOracleTick({ feed0Side: 'token0', feed0: fakeFeed(4, NOW), rate: fakeRate('-1'), decimals0: 18, decimals1: 18, nowTs: NOW }),
    ).rejects.toThrow(/returned -/);
  });

  it('propagates a reverting rate source so the caller fails closed', async () => {
    const broken = {
      address: '0xdead',
      latestAnswer: async () => {
        throw new Error('call revert exception');
      },
      decimals: async () => 8,
    } as unknown as ethers.Contract;
    await expect(
      readOracleTick({ feed0Side: 'token0', feed0: fakeFeed(4, NOW), rate: broken, decimals0: 18, decimals1: 18, nowTs: NOW }),
    ).rejects.toThrow(/revert/);
  });

  it('never calls latestRoundData on the rate source', async () => {
    // The real precompile reverts on it; a reader that reached for it would
    // fail closed on every block. Prove the code path does not touch it.
    const rate = {
      address: '0xrate',
      latestAnswer: async () => ethers.BigNumber.from('101609190'),
      decimals: async () => 8,
      latestRoundData: async () => {
        throw new Error('must not be called');
      },
    } as unknown as ethers.Contract;
    const o = await readOracleTick({ feed0Side: 'token0', feed0: fakeFeed(4, NOW), rate, decimals0: 18, decimals1: 18, nowTs: NOW });
    expect(o.tick).toBe(tickFromPrice(4 * 1.0160919));
  });
});

describe('readOracleTick orientation', () => {
  // The pool tick means "token1 per token0". A feed on token1 is therefore the
  // reciprocal of that, and using it as-is lands the oracle tick on the wrong
  // side of the pool — silently, because nothing reverts.
  it('inverts a one-feed price when the feed prices token1', async () => {
    const asToken1 = await readOracleTick({
      feed0Side: 'token1',
      feed0: fakeFeed(4, NOW),
      decimals0: 18,
      decimals1: 18,
      nowTs: NOW,
    });
    expect(asToken1.tick).toBe(tickFromPrice(1 / 4));
  });

  it('flips the two-feed ratio when feed0 prices token1', async () => {
    // feed0 = $4 asset, feed1 = $1 asset. With feed0 on token1 the pool holds
    // 0.25 of the $4 asset per unit of the $1 asset.
    const flipped = await readOracleTick({
      feed0Side: 'token1',
      feed0: fakeFeed(4, NOW),
      feed1: fakeFeed(1, NOW),
      decimals0: 18,
      decimals1: 18,
      nowTs: NOW,
    });
    expect(flipped.tick).toBe(tickFromPrice(1 / 4));
  });

  it('is a no-op relative to the old behaviour when feed0 prices token0', async () => {
    const o = await readOracleTick({
      feed0Side: 'token0',
      feed0: fakeFeed(4, NOW),
      decimals0: 18,
      decimals1: 18,
      nowTs: NOW,
    });
    expect(o.tick).toBe(tickFromPrice(4));
  });
});
