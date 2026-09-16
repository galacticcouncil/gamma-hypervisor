import { describe, it, expect } from 'vitest';
import {
  bandMid,
  ceilToSpacing,
  centeredBand,
  clampBandTranslation,
  clampBandWidth,
  floorToSpacing,
  legValueRatio,
  limitRange,
  skewedBand,
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
    const r = clampBandTranslation(target, [-600, 600], 300, spacing);
    expect(r.clamped).toBe(false);
    expect(r.band).toEqual(target);
  });

  it('walks partway when the target exceeds the cap', () => {
    const target = centeredBand(5000, halfWidth, spacing);
    const current: [number, number] = [-600, 600];
    const r = clampBandTranslation(target, current, 300, spacing);
    expect(r.clamped).toBe(true);
    // Moves toward the target but the on-chain check must still pass.
    const moved = bandMid(r.band[0], r.band[1]) - bandMid(current[0], current[1]);
    expect(moved).toBeGreaterThan(0);
    expect(Math.abs(moved)).toBeLessThanOrEqual(300);
  });

  it('walks partway downward too, still within the cap', () => {
    const target = centeredBand(-5000, halfWidth, spacing);
    const current: [number, number] = [-600, 600];
    const r = clampBandTranslation(target, current, 300, spacing);
    expect(r.clamped).toBe(true);
    const moved = bandMid(r.band[0], r.band[1]) - bandMid(current[0], current[1]);
    expect(moved).toBeLessThan(0);
    expect(Math.abs(moved)).toBeLessThanOrEqual(300);
  });

  it('converges on the target over repeated clamped rebalances', () => {
    const target = centeredBand(5000, halfWidth, spacing);
    let band: [number, number] = [-600, 600];
    for (let i = 0; i < 50; i++) {
      const r = clampBandTranslation(target, band, 300, spacing);
      band = r.band;
      if (!r.clamped) break;
    }
    expect(band).toEqual(target);
  });

  it('refuses a cap too small to make progress under this spacing', () => {
    const target = centeredBand(5000, halfWidth, spacing);
    expect(() => clampBandTranslation(target, [-600, 600], 100, spacing)).toThrow(/not workable/);
  });
});

describe('skewedBand', () => {
  const spacing = 60;
  const opts = { minLegTicks: 8 * spacing, maxSkewRatio: 8 };

  // The realised (post-rounding) legs, which is what the pool actually gets.
  const legs = (tick: number, band: [number, number]) => ({
    lower: tick - band[0],
    upper: band[1] - tick,
  });

  it('is the identity at share0 = 0.5 — exactly centeredBand, same rounding', () => {
    for (const tick of [0, 123, -50, 50000, 184517, -184517]) {
      for (const mult of [10, 16, 30]) {
        expect(skewedBand(tick, 0.5, mult, spacing, opts)).toEqual(
          centeredBand(tick, mult, spacing),
        );
      }
    }
  });

  it('extends the UPPER leg when the vault is long token0, and mirrors below', () => {
    const tick = 184500;
    const heavy0 = skewedBand(tick, 0.8, 30, spacing, opts);
    const heavy1 = skewedBand(tick, 0.2, 30, spacing, opts);
    const even = centeredBand(tick, 30, spacing);

    // Long token0 ⇒ more room ABOVE to sell it into as price rises.
    expect(legs(tick, heavy0).upper).toBeGreaterThan(legs(tick, even).upper);
    expect(legs(tick, heavy0).lower).toBeLessThan(legs(tick, even).lower);
    // Long token1 ⇒ the mirror image.
    expect(legs(tick, heavy1).lower).toBeGreaterThan(legs(tick, even).lower);
    expect(legs(tick, heavy1).upper).toBeLessThan(legs(tick, even).upper);
  });

  it('never lets a leg fall under minLegTicks, at any share', () => {
    for (const tick of [0, 184517, -77]) {
      for (const share of [0, 0.001, 0.05, 0.25, 0.5, 0.75, 0.95, 0.999, 1]) {
        for (const mult of [10, 30]) {
          const band = skewedBand(tick, share, mult, spacing, opts);
          const l = legs(tick, band);
          expect(l.lower).toBeGreaterThanOrEqual(opts.minLegTicks);
          expect(l.upper).toBeGreaterThanOrEqual(opts.minLegTicks);
          expect(band[0] % spacing === 0).toBe(true);
          expect(band[1] % spacing === 0).toBe(true);
          expect(band[0]).toBeLessThan(band[1]);
        }
      }
    }
  });

  it('rotates rather than widens: total width matches centeredBand within a spacing', () => {
    for (const tick of [0, 184517, -4321]) {
      for (const share of [0.05, 0.2, 0.5, 0.8, 0.95]) {
        const mult = 30;
        const skewed = skewedBand(tick, share, mult, spacing, opts);
        const even = centeredBand(tick, mult, spacing);
        const delta = Math.abs(skewed[1] - skewed[0] - (even[1] - even[0]));
        expect(delta).toBeLessThanOrEqual(spacing);
      }
    }
  });

  it('falls back to the symmetric band when the width cannot hold two floors', () => {
    // mult 3 ⇒ 360 ticks total, under 2 × 480.
    expect(skewedBand(184500, 0.9, 3, spacing, opts)).toEqual(centeredBand(184500, 3, spacing));
    expect(skewedBand(184500, Number.NaN, 10, spacing, opts)).toEqual(
      centeredBand(184500, 10, spacing),
    );
  });

  it('honours maxSkewRatio even when the leg floor would allow more', () => {
    const tight = { minLegTicks: spacing, maxSkewRatio: 1.5 };
    const band = skewedBand(0, 0.99, 30, spacing, tight);
    const l = legs(0, band);
    // The ratio the band actually wants, not the leg lengths, is what is capped.
    expect(legValueRatio(l.lower, l.upper)).toBeLessThan(1.5 * 1.1);
  });

  it('tracks share0/(1-share0) across a sweep of shares', () => {
    const tick = 184500;
    const mult = 30; // wide enough that both legs stay interior across the sweep
    for (const share of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
      const band = skewedBand(tick, share, mult, spacing, opts);
      const l = legs(tick, band);
      const realised = legValueRatio(l.lower, l.upper);
      const wanted = share / (1 - share);
      // Tolerance is the spacing grid: the legs are rounded to it, and at
      // spacing 60 one step is worth a few percent of the ratio.
      expect(Math.abs(realised - wanted) / wanted).toBeLessThan(0.08);
    }
  });
});

describe('clampBandWidth', () => {
  const spacing = 60;

  it('passes the target through when the width change is within the cap', () => {
    const target = centeredBand(0, 10, spacing); // width 1200
    const r = clampBandWidth(target, [-540, 540], 0, 300, spacing); // width 1080
    expect(r.clamped).toBe(false);
    expect(r.band).toEqual(target);
  });

  it('never steps the width by more than maxWidth, growing or shrinking', () => {
    const maxWidth = 300;
    for (const current of [[-600, 600], [-1800, 1800], [0, 60]] as [number, number][]) {
      for (const target of [centeredBand(184517, 30, spacing), centeredBand(184517, 2, spacing)]) {
        const r = clampBandWidth(target, current, 184517, maxWidth, spacing);
        const step = Math.abs(r.band[1] - r.band[0] - (current[1] - current[0]));
        expect(step).toBeLessThanOrEqual(maxWidth);
        expect(r.band[0] % spacing === 0).toBe(true);
        expect(r.band[1] % spacing === 0).toBe(true);
        expect(r.band[0]).toBeLessThan(r.band[1]);
      }
    }
  });

  it('converges on the target width over repeated rebalances', () => {
    const target = centeredBand(184517, 30, spacing);
    let band: [number, number] = [-600, 600];
    for (let i = 0; i < 50; i++) {
      const r = clampBandWidth(target, band, 184517, 300, spacing);
      expect(Math.abs(r.band[1] - r.band[0] - (band[1] - band[0]))).toBeLessThanOrEqual(300);
      band = r.band;
      if (!r.clamped) break;
    }
    expect(band).toEqual(target);
  });

  it('shrinks toward the target too, and converges', () => {
    const target = centeredBand(184517, 4, spacing);
    let band: [number, number] = centeredBand(184517, 30, spacing);
    for (let i = 0; i < 50; i++) {
      const r = clampBandWidth(target, band, 184517, 300, spacing);
      expect(Math.abs(r.band[1] - r.band[0] - (band[1] - band[0]))).toBeLessThanOrEqual(300);
      band = r.band;
      if (!r.clamped) break;
    }
    expect(band).toEqual(target);
  });

  it('keeps the skew direction while the width walks', () => {
    const tick = 184500;
    const target = skewedBand(tick, 0.85, 30, spacing, { minLegTicks: 8 * spacing, maxSkewRatio: 8 });
    const r = clampBandWidth(target, [tick - 600, tick + 600], tick, 300, spacing);
    expect(r.clamped).toBe(true);
    // Upper leg still the long one, measured against the price — and the price
    // is still inside the band, which is the property a shrink can break.
    expect(r.band[1] - tick).toBeGreaterThan(tick - r.band[0]);
    expect(r.band[0]).toBeLessThan(tick);
    expect(r.band[1]).toBeGreaterThan(tick);
  });

  it('refuses a cap smaller than one tick spacing', () => {
    const target = centeredBand(0, 30, spacing);
    expect(() => clampBandWidth(target, [-600, 600], 0, 59, spacing)).toThrow(/under one tick spacing/);
  });
});

describe('clampBandTranslation preserves the band it is given', () => {
  const spacing = 60;

  it('shifts a skewed band rigidly instead of re-centering it symmetrically', () => {
    const target = skewedBand(50000, 0.85, 10, spacing, { minLegTicks: 4 * spacing, maxSkewRatio: 8 });
    const r = clampBandTranslation(target, [-600, 600], 300, spacing);
    expect(r.clamped).toBe(true);
    // Same width and same leg asymmetry, only moved.
    expect(r.band[1] - r.band[0]).toBe(target[1] - target[0]);
    const tMid = bandMid(target[0], target[1]);
    const rMid = bandMid(r.band[0], r.band[1]);
    expect(r.band[0] - tMid).toBe(target[0] - tMid + (rMid - tMid));
    expect(rMid - 0).toBeGreaterThan(0);
    expect(Math.abs(rMid - 0)).toBeLessThanOrEqual(300);
  });
});
