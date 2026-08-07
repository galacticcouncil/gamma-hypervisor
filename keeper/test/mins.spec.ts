import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { computeMins, splitForBand } from '../src/mins';
import { surplusSide } from '../src/vault';
import { centeredBand } from '../src/ticks';

const bn = (x: string | number) => ethers.BigNumber.from(x.toString());
const E18 = bn('1000000000000000000');
const Q96 = ethers.BigNumber.from(2).pow(96); // sqrtPriceX96 at price 1.0 (tick 0)

const pos = (a0: ethers.BigNumber, a1: ethers.BigNumber) => ({ liquidity: bn(1), amount0: a0, amount1: a1 });

const SYMMETRIC = centeredBand(0, 10, 60) as [number, number];

const minsFor = (
  band: [number, number],
  opts: { total0?: ethers.BigNumber; total1?: ethers.BigNumber; toleranceBps?: number } = {},
) => {
  const total0 = opts.total0 ?? E18;
  const total1 = opts.total1 ?? E18;
  const split = splitForBand(total0, total1, Q96, band);
  const side = surplusSide(split, 1);
  return computeMins({
    split,
    base: pos(E18.div(2), E18.div(2)),
    limit: pos(bn(0), bn(0)),
    side,
    toleranceBps: opts.toleranceBps ?? 1000,
  });
};

describe('splitForBand', () => {
  it('splits a band symmetric around spot into roughly equal legs', () => {
    const s = splitForBand(E18, E18, Q96, SYMMETRIC);
    expect(Math.abs(s.base0 - s.base1) / Math.max(s.base0, s.base1)).toBeLessThan(0.01);
  });

  it('never consumes more than the vault holds', () => {
    const s = splitForBand(E18, E18, Q96, SYMMETRIC);
    expect(s.base0).toBeLessThanOrEqual(Number(E18.toString()) * 1.000001);
    expect(s.base1).toBeLessThanOrEqual(Number(E18.toString()) * 1.000001);
    expect(s.residual0).toBeGreaterThanOrEqual(0);
    expect(s.residual1).toBeGreaterThanOrEqual(0);
  });

  it('takes only token0 when the band sits entirely above spot', () => {
    const s = splitForBand(E18, E18, Q96, [6000, 7200]);
    expect(s.base1).toBe(0);
    expect(s.residual1).toBe(Number(E18.toString()));
    expect(s.base0).toBeGreaterThan(0);
  });

  it('takes only token1 when the band sits entirely below spot', () => {
    const s = splitForBand(E18, E18, Q96, [-7200, -6000]);
    expect(s.base0).toBe(0);
    expect(s.residual0).toBe(Number(E18.toString()));
    expect(s.base1).toBeGreaterThan(0);
  });

  it('handles an empty vault without producing NaN', () => {
    const s = splitForBand(bn(0), bn(0), Q96, SYMMETRIC);
    for (const v of [s.base0, s.base1, s.residual0, s.residual1]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBe(0);
    }
  });
});

// The limit range must land on the side that actually holds the leftovers. A
// band offset from spot (the normal case: placement is off the TWAP, and proxy
// mode clamps translation) makes raw totals disagree with post-base residuals —
// this is what the AutoRebal reference compares.
describe('surplusSide follows the residuals, not the raw totals', () => {
  it('picks "above" when the band is below spot and leaves token0 over', () => {
    // Balanced vault, band 600 ticks BELOW spot: the base absorbs token1, so
    // essentially all of token0 is left over and the limit belongs above.
    const band = centeredBand(-600, 10, 60) as [number, number];
    const split = splitForBand(E18, E18, Q96, band);
    expect(split.residual0).toBeGreaterThan(split.residual1);
    expect(surplusSide(split, 1)).toBe('above');
  });

  it('picks "below" when the band is above spot and leaves token1 over', () => {
    const band = centeredBand(600, 10, 60) as [number, number];
    const split = splitForBand(E18, E18, Q96, band);
    expect(split.residual1).toBeGreaterThan(split.residual0);
    expect(surplusSide(split, 1)).toBe('below');
  });

  it('puts the mint bound on the chosen side and zero on the other', () => {
    const band = centeredBand(-600, 10, 60) as [number, number];
    const { inMin } = minsFor(band);
    expect(inMin[3]).toEqual(bn(0)); // no token1 expected in an above-tick range
    expect(Number(inMin[2].toString())).toBeGreaterThan(0);
  });
});

describe('computeMins', () => {
  it('never returns all-zero mins (the pre-hardening behaviour)', () => {
    const { inMin, outMin } = minsFor(SYMMETRIC);
    expect(outMin.some((x) => !x.isZero())).toBe(true);
    expect(inMin.some((x) => !x.isZero())).toBe(true);
  });

  it('bounds the burn at the current position amounts less tolerance', () => {
    const { outMin } = minsFor(SYMMETRIC);
    // 10% tolerance on 0.5e18
    expect(outMin[0]).toEqual(bn('450000000000000000'));
    expect(outMin[1]).toEqual(bn('450000000000000000'));
    expect(outMin[2]).toEqual(bn(0));
    expect(outMin[3]).toEqual(bn(0));
  });

  it('never demands more than the vault actually holds', () => {
    const { inMin } = minsFor(SYMMETRIC);
    expect(inMin[0].add(inMin[2]).lte(E18)).toBe(true);
    expect(inMin[1].add(inMin[3]).lte(E18)).toBe(true);
  });

  it('scales bounds down as tolerance widens', () => {
    const tight = minsFor(SYMMETRIC, { toleranceBps: 100 });
    const loose = minsFor(SYMMETRIC, { toleranceBps: 5000 });
    expect(loose.outMin[0].lt(tight.outMin[0])).toBe(true);
    expect(loose.inMin[0].lt(tight.inMin[0])).toBe(true);
  });

  it('puts the surplus in the limit leg when the vault is lopsided', () => {
    // All token0, none of token1: the base absorbs token0 down to spot and the
    // remainder parks one-sided above.
    const { inMin } = minsFor(SYMMETRIC, { total1: bn(0) });
    expect(inMin[3]).toEqual(bn(0));
    expect(Number(inMin[2].toString())).toBeGreaterThan(0);
  });

  it('demands no token1 when the new band sits entirely above spot', () => {
    const { inMin } = minsFor([6000, 7200]);
    expect(inMin[1]).toEqual(bn(0));
    expect(Number(inMin[0].toString())).toBeGreaterThan(0);
  });

  it('handles an empty vault without producing NaN bounds', () => {
    const split = splitForBand(bn(0), bn(0), Q96, SYMMETRIC);
    const { inMin, outMin } = computeMins({
      split,
      base: pos(bn(0), bn(0)),
      limit: pos(bn(0), bn(0)),
      side: 'above',
      toleranceBps: 1000,
    });
    for (const x of [...inMin, ...outMin]) expect(x.isZero()).toBe(true);
  });
});
