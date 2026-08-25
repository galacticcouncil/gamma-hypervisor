import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { computeCompoundMins, splitForBand } from '../src/mins';
import { compoundAllowed } from '../src/keeper';
import { ADMIN_COMPOUND_ABI } from '../src/compound';

const E18 = ethers.BigNumber.from('1000000000000000000');
const Q96 = ethers.BigNumber.from(2).pow(96); // price 1.0 (tick 0)
const tok = (n: number) => E18.mul(n);
const f = (b: ethers.BigNumber) => Number(b.toString()) / 1e18;
/** sqrtPriceX96 for a raw price. Float-precise, which is plenty for these bounds. */
const sqrtAt = (p: number) =>
  ethers.BigNumber.from(BigInt(Math.floor(Math.sqrt(p) * Math.pow(2, 96))).toString());

const BASE: [number, number] = [-600, 600];   // straddles spot
const LIMIT: [number, number] = [600, 1200];  // entirely above spot -> token0 only

describe('computeCompoundMins', () => {
  it('floors sit a tolerance below what a fair mint would consume', () => {
    const fair = splitForBand(tok(1000), tok(1000), Q96, BASE);
    const m = computeCompoundMins({
      idle0: tok(1000), idle1: tok(1000), sqrtPriceX96: Q96,
      base: BASE, limit: LIMIT, toleranceBps: 1000,
    });
    expect(f(m[0])).toBeCloseTo(fair.base0 / 1e18 * 0.9, 3);
    expect(f(m[1])).toBeCloseTo(fair.base1 / 1e18 * 0.9, 3);
    // a fair execution clears its own floor
    expect(fair.base0).toBeGreaterThan(f(m[0]) * 1e18);
    expect(fair.base1).toBeGreaterThan(f(m[1]) * 1e18);
  });

  it('zero tolerance floors equal the predicted split exactly', () => {
    const fair = splitForBand(tok(1000), tok(1000), Q96, BASE);
    const m = computeCompoundMins({
      idle0: tok(1000), idle1: tok(1000), sqrtPriceX96: Q96,
      base: BASE, limit: LIMIT, toleranceBps: 0,
    });
    expect(f(m[0])).toBeCloseTo(fair.base0 / 1e18, 6);
  });

  it('a lopsided pot puts a real floor on the limit mint too', () => {
    // token1 binds the base, so the surplus token0 is what the limit range parks
    const m = computeCompoundMins({
      idle0: tok(2000), idle1: tok(1000), sqrtPriceX96: Q96,
      base: BASE, limit: LIMIT, toleranceBps: 1000,
    });
    expect(f(m[2])).toBeGreaterThan(0);   // limit consumes token0
    expect(f(m[3])).toBe(0);              // an above-spot range holds no token1
  });

  it('an empty vault produces all-zero floors rather than throwing', () => {
    const m = computeCompoundMins({
      idle0: ethers.constants.Zero, idle1: ethers.constants.Zero, sqrtPriceX96: Q96,
      base: BASE, limit: LIMIT, toleranceBps: 1000,
    });
    expect(m.every((x) => x.isZero())).toBe(true);
  });

  // The reason this function exists: the keeper's TWAP and oracle gates bind at
  // decision time, one block before the tx lands. If someone pushes the price in
  // between, the mint consumes a different mix — and must revert.
  it.each([1.01, 1.05, 1.2, 0.99, 0.95])('a front-run to price x%s falls under the floor', (shove) => {
    const m = computeCompoundMins({
      idle0: tok(1000), idle1: tok(1000), sqrtPriceX96: Q96,
      base: BASE, limit: LIMIT, toleranceBps: 1000,
    });
    const shoved = splitForBand(tok(1000), tok(1000), sqrtAt(shove), BASE);
    const trips = shoved.base0 < f(m[0]) * 1e18 || shoved.base1 < f(m[1]) * 1e18;
    expect(trips).toBe(true); // Hypervisor._mintLiquidity reverts 'PSC'
  });
});

describe('compoundAllowed', () => {
  const ok = { ok: true, reason: 'ok' };
  const bad = { ok: false, reason: 'spot vs TWAP dev 140 > 100' };

  it('runs only when the price gates pass and the market is calm', () => {
    expect(compoundAllowed(ok, 'calm').run).toBe(true);
  });

  it('refuses when the price gate failed, and says why', () => {
    const r = compoundAllowed(bad, 'calm');
    expect(r.run).toBe(false);
    expect(r.reason).toContain('TWAP');
  });

  it.each(['elevated', 'extreme'] as const)('refuses in %s regime even with a clean price', (regime) => {
    expect(compoundAllowed(ok, regime).run).toBe(false);
  });
});

describe('ADMIN_COMPOUND_ABI', () => {
  it('carries the bounded overload and can encode a call against it', () => {
    const iface = new ethers.utils.Interface(ADMIN_COMPOUND_ABI);
    const data = iface.encodeFunctionData('compound(address,uint256[4])', [
      ethers.constants.AddressZero,
      [1, 2, 3, 4],
    ]);
    expect(data.startsWith('0x')).toBe(true);
    // the unbounded overload must remain distinguishable, never accidentally called
    expect(iface.getFunction('compound(address,uint256[4])').inputs).toHaveLength(2);
  });
});
