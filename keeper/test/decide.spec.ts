import { describe, it, expect } from 'vitest';
import { decide, shouldFold, shouldRefreshLimit } from '../src/decide';

const strat = { tickSpacing: 60, baseHalfWidthMult: 10, rebalanceThresholdMult: 5 };

describe('decide', () => {
  it('holds when the tick is centered in the band', () => {
    const d = decide({ spotTick: 0, placementTick: 0, baseLower: -600, baseUpper: 600, ...strat });
    expect(d.trigger).toBe(false);
    expect(d.reason).toMatch(/in range/);
  });

  it('triggers when the tick leaves the band', () => {
    const d = decide({ spotTick: 700, placementTick: 700, baseLower: -600, baseUpper: 600, ...strat });
    expect(d.trigger).toBe(true);
    expect(d.reason).toMatch(/outside/);
  });

  it('triggers on drift beyond threshold while still inside the band', () => {
    // band [-600,1200], mid 300; tick 700 drift 400 > 5*60 = 300
    const d = decide({ spotTick: 700, placementTick: 700, baseLower: -600, baseUpper: 1200, ...strat });
    expect(d.trigger).toBe(true);
    expect(d.reason).toMatch(/drift/);
  });

  it('recenters the new base around the placement tick', () => {
    const d = decide({ spotTick: 5000, placementTick: 5000, baseLower: -600, baseUpper: 600, ...strat });
    const mid = (d.newBaseLower + d.newBaseUpper) / 2;
    expect(Math.abs(mid - 5000)).toBeLessThanOrEqual(60);
    expect(d.newBaseLower % 60 === 0).toBe(true);
    expect(d.newBaseUpper % 60 === 0).toBe(true);
  });

  it('places on the TWAP tick even when spot is what triggered', () => {
    // Manipulated spot far away; TWAP barely moved. The trigger fires on spot,
    // but the band must be built around the TWAP. This is the core
    // anti-manipulation property: a price push can cost an attacker a rebalance,
    // but cannot relocate the vault's liquidity to the pushed price.
    const d = decide({ spotTick: 9000, placementTick: 120, baseLower: -600, baseUpper: 600, ...strat });
    expect(d.trigger).toBe(true);
    const mid = (d.newBaseLower + d.newBaseUpper) / 2;
    expect(Math.abs(mid - 120)).toBeLessThanOrEqual(60);
    expect(d.newBaseUpper).toBeLessThan(9000);
  });
});

describe('shouldRefreshLimit', () => {
  const limit = { limitLower: 184440, limitUpper: 184620, limitLiquidity: 1n, refreshTicks: 120 };

  it('holds while spot is inside the limit range (fills happen in place)', () => {
    const r = shouldRefreshLimit({ ...limit, spotTick: 184500 });
    expect(r.trigger).toBe(false);
    expect(r.reason).toMatch(/inside/);
  });

  it('holds while spot is outside but adjacent (re-fills on the next wiggle)', () => {
    const r = shouldRefreshLimit({ ...limit, spotTick: 184440 - 120 });
    expect(r.trigger).toBe(false);
  });

  it('fires when price fell away below the limit', () => {
    // the 2026-09-11..15 mainnet episode: aDOT sell window left ~300 ticks above
    const r = shouldRefreshLimit({ ...limit, spotTick: 184146 });
    expect(r.trigger).toBe(true);
    expect(r.reason).toMatch(/294 ticks from spot/);
  });

  it('fires when price traded up through the limit and kept going', () => {
    const r = shouldRefreshLimit({ ...limit, spotTick: 184620 + 121 });
    expect(r.trigger).toBe(true);
  });

  it('never fires without a limit position', () => {
    expect(shouldRefreshLimit({ ...limit, limitLiquidity: 0n, spotTick: 0 }).trigger).toBe(false);
    expect(
      shouldRefreshLimit({ ...limit, limitLower: 0, limitUpper: 0, spotTick: 184146 }).trigger,
    ).toBe(false);
  });
});

describe('shouldFold', () => {
  const base = {
    limitLiquidity: 1n,
    navValue: 100_000,
    foldMinShare: 0.4,
    foldMinLimitShare: 0.05,
  };

  it('holds while the limit is one-sided (nothing converted yet)', () => {
    const r = shouldFold({ ...base, limitValue0: 40_000, limitValue1: 0 });
    expect(r.trigger).toBe(false);
    expect(r.reason).toMatch(/min leg 0.0%/);
  });

  it('holds while conversion is under the threshold', () => {
    // 30/70 mixed: converted, but not yet "at balance"
    const r = shouldFold({ ...base, limitValue0: 12_000, limitValue1: 28_000 });
    expect(r.trigger).toBe(false);
    expect(r.reason).toMatch(/min leg 30.0% < 40%/);
  });

  it('fires once the limit reaches the mixed threshold', () => {
    const r = shouldFold({ ...base, limitValue0: 18_000, limitValue1: 22_000 });
    expect(r.trigger).toBe(true);
    expect(r.reason).toMatch(/45.0\/55.0 mixed/);
  });

  it('fires at exactly the threshold, either side heavy', () => {
    expect(shouldFold({ ...base, limitValue0: 16_000, limitValue1: 24_000 }).trigger).toBe(true);
    expect(shouldFold({ ...base, limitValue0: 24_000, limitValue1: 16_000 }).trigger).toBe(true);
  });

  it('ignores a dust limit — not worth a cooldown slot', () => {
    // perfectly mixed but only 2% of NAV
    const r = shouldFold({ ...base, limitValue0: 1_000, limitValue1: 1_000 });
    expect(r.trigger).toBe(false);
    expect(r.reason).toMatch(/2.0% of NAV < floor 5%/);
  });

  it('never fires without a limit position or value', () => {
    expect(shouldFold({ ...base, limitLiquidity: 0n, limitValue0: 0, limitValue1: 0 }).trigger).toBe(false);
    expect(shouldFold({ ...base, limitValue0: 0, limitValue1: 0 }).trigger).toBe(false);
  });

  it('is self-clearing: the post-fold residual limit is one-sided again', () => {
    // after a fold the re-parked residual is 100% one token -> min leg 0
    const r = shouldFold({ ...base, limitValue0: 0, limitValue1: 9_000 });
    expect(r.trigger).toBe(false);
  });
});
