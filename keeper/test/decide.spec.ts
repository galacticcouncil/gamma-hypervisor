import { describe, it, expect } from 'vitest';
import { decide } from '../src/decide';

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
