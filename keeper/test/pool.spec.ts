import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { twapTickFromCumulatives } from '../src/pool';

const bn = (x: string | number) => ethers.BigNumber.from(x);

// observe([window, 0]) returns cumulatives parallel to secondsAgos, so index 0 is
// the OLDER value. Mean tick = (newer - older) / window. The pre-hardening code
// subtracted the other way and returned the NEGATED tick, which perma-tripped the
// deviation gate on any pool not sitting at tick ~0.
describe('twapTickFromCumulatives', () => {
  it('returns a positive mean tick for a rising cumulative', () => {
    const window = 3600;
    const older = bn(1_000_000);
    const newer = older.add(bn(200 * window)); // mean tick 200
    expect(twapTickFromCumulatives(older, newer, window)).toBe(200);
  });

  it('returns a negative mean tick for a falling cumulative (sign is not flipped)', () => {
    const window = 3600;
    const older = bn(1_000_000);
    const newer = older.sub(bn(200 * window));
    expect(twapTickFromCumulatives(older, newer, window)).toBe(-200);
  });

  it('floors negative deltas like OracleLibrary.consult', () => {
    const window = 3600;
    const older = bn(0);
    // -1.5 ticks average: integer division truncates to -1, must floor to -2.
    const newer = bn(-1.5 * window);
    expect(twapTickFromCumulatives(older, newer, window)).toBe(-2);
  });

  it('does not adjust exact negative multiples', () => {
    const window = 3600;
    expect(twapTickFromCumulatives(bn(0), bn(-2 * window), window)).toBe(-2);
  });

  it('agrees with spot when the tick was constant across the window', () => {
    // A pool parked at tick 12345 for the whole window must yield exactly 12345,
    // so a healthy pool never trips the deviation gate.
    const window = 1800;
    const tick = 12345;
    expect(twapTickFromCumulatives(bn(500_000), bn(500_000 + tick * window), window)).toBe(tick);
  });
});
