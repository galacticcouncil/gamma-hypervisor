import { describe, it, expect } from 'vitest';
import { PriceHistory } from '../src/priceHistory';

const NOW = 1_800_000_000;

describe('PriceHistory', () => {
  it('returns undefined before the trail reaches back far enough', () => {
    const h = new PriceHistory(7200);
    h.push(NOW, 1.0);
    // Cold start: no 15m-ago sample, so no answer rather than a made-up one.
    expect(h.moveOver(900, NOW)).toBeUndefined();
  });

  it('measures an absolute move in either direction', () => {
    const up = new PriceHistory(7200);
    up.push(NOW - 1000, 1.0);
    up.push(NOW, 1.05);
    expect(up.moveOver(900, NOW)).toBeCloseTo(0.05, 6);

    const down = new PriceHistory(7200);
    down.push(NOW - 1000, 1.0);
    down.push(NOW, 0.95);
    expect(down.moveOver(900, NOW)).toBeCloseTo(0.05, 6);
  });

  it('compares against the newest sample that is old enough', () => {
    const h = new PriceHistory(7200);
    h.push(NOW - 3600, 2.0); // older than needed
    h.push(NOW - 1000, 1.0); // the one to use
    h.push(NOW, 1.1);
    expect(h.moveOver(900, NOW)).toBeCloseTo(0.1, 6);
  });

  it('drops samples past its window', () => {
    const h = new PriceHistory(1000);
    h.push(NOW - 5000, 1.0);
    h.push(NOW, 1.0);
    expect(h.size).toBe(1);
  });

  it('ignores unusable prices and out-of-order samples', () => {
    const h = new PriceHistory(7200);
    h.push(NOW, 1.0);
    h.push(NOW + 10, 0);
    h.push(NOW + 10, NaN);
    h.push(NOW - 50, 5.0);
    expect(h.size).toBe(1);
  });
});
