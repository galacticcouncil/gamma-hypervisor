import { describe, it, expect } from 'vitest';
import {
  bandMid,
  ceilToSpacing,
  centeredBand,
  clampBandTranslation,
  floorToSpacing,
  limitRange,
  truncToSpacing,
} from '../src/ticks';

describe('centeredBand', () => {
  it('brackets the tick on spacing, at least ±half wide', () => {
    const [lo, hi] = centeredBand(123, 10, 60); // half = 600
    expect(lo % 60 === 0).toBe(true);
    expect(hi % 60 === 0).toBe(true);
    expect(lo).toBeLessThanOrEqual(123 - 600);
    expect(hi).toBeGreaterThanOrEqual(123 + 600);
    expect(lo).toBeLessThan(hi);
  });

  it('works at negative ticks', () => {
    const [lo, hi] = centeredBand(-50, 5, 60); // half = 300
    expect(lo % 60 === 0).toBe(true);
    expect(hi % 60 === 0).toBe(true);
    expect(lo).toBeLessThanOrEqual(-350);
    expect(hi).toBeGreaterThanOrEqual(250);
  });

  it('stays centered far from tick 0 (the tickBands quirk this replaces)', () => {
    const [lo, hi] = centeredBand(50000, 10, 60);
    const mid = (lo + hi) / 2;
    expect(Math.abs(mid - 50000)).toBeLessThanOrEqual(60);
  });
});

describe('limitRange', () => {
  it('above: strictly above tick, on spacing, width respected', () => {
    const [lo, hi] = limitRange(123, 60, 'above', 1);
    expect(lo % 60 === 0).toBe(true);
    expect(lo).toBeGreaterThan(123);
    expect(hi).toBe(lo + 60);
  });

  it('below: strictly below tick, on spacing, width respected', () => {
    const [lo, hi] = limitRange(123, 60, 'below', 2);
    expect(hi % 60 === 0).toBe(true);
    expect(hi).toBeLessThanOrEqual(123);
    expect(hi - lo).toBe(120);
  });

  it('above: tick exactly on a boundary is pushed strictly above', () => {
    const [lo] = limitRange(120, 60, 'above', 1);
    expect(lo).toBe(180);
  });

  it('below: tick exactly on a boundary is pushed strictly below', () => {
    const [, hi] = limitRange(120, 60, 'below', 1);
    expect(hi).toBe(60);
  });
});

describe('rounding helpers at negatives', () => {
  it('floor/ceil/trunc behave', () => {
    expect(floorToSpacing(-1, 60)).toBe(-60);
    expect(ceilToSpacing(-1, 60)).toBe(0);
    expect(truncToSpacing(-130, 60)).toBe(-120);
    expect(truncToSpacing(130, 60)).toBe(120);
  });
});

describe('bandMid', () => {
  it('matches RebalanceProxy.isWithinRange for a straddling band', () => {
    // Contract: lower + (|lower| + upper)/2 for lower<0<upper -> -600 + 600 = 0
    expect(bandMid(-600, 600)).toBe(0);
  });

  it('matches the contract for a one-sided band', () => {
    expect(bandMid(600, 1800)).toBe(1200);
    expect(bandMid(-1800, -600)).toBe(-1200);
  });
});

describe('clampBandTranslation', () => {
  const spacing = 60;
  const halfWidth = 10;

  it('passes the target through when within the cap', () => {
    const target = centeredBand(200, halfWidth, spacing);
    const r = clampBandTranslation(target, [-600, 600], 300, halfWidth, spacing);
    expect(r.clamped).toBe(false);
    expect(r.band).toEqual(target);
  });

  it('walks partway when the target exceeds the cap', () => {
    const target = centeredBand(5000, halfWidth, spacing);
    const current: [number, number] = [-600, 600];
    const r = clampBandTranslation(target, current, 300, halfWidth, spacing);
    expect(r.clamped).toBe(true);
    // Moves toward the target but the on-chain check must still pass.
    const moved = bandMid(r.band[0], r.band[1]) - bandMid(current[0], current[1]);
    expect(moved).toBeGreaterThan(0);
    expect(Math.abs(moved)).toBeLessThanOrEqual(300);
  });

  it('walks partway downward too, still within the cap', () => {
    const target = centeredBand(-5000, halfWidth, spacing);
    const current: [number, number] = [-600, 600];
    const r = clampBandTranslation(target, current, 300, halfWidth, spacing);
    expect(r.clamped).toBe(true);
    const moved = bandMid(r.band[0], r.band[1]) - bandMid(current[0], current[1]);
    expect(moved).toBeLessThan(0);
    expect(Math.abs(moved)).toBeLessThanOrEqual(300);
  });

  it('converges on the target over repeated clamped rebalances', () => {
    const target = centeredBand(5000, halfWidth, spacing);
    let band: [number, number] = [-600, 600];
    for (let i = 0; i < 50; i++) {
      const r = clampBandTranslation(target, band, 300, halfWidth, spacing);
      band = r.band;
      if (!r.clamped) break;
    }
    expect(band).toEqual(target);
  });

  it('refuses a cap too small to make progress under this spacing', () => {
    const target = centeredBand(5000, halfWidth, spacing);
    expect(() => clampBandTranslation(target, [-600, 600], 100, halfWidth, spacing)).toThrow(/not workable/);
  });
});
