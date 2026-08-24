import { describe, it, expect } from 'vitest';
import { median, parkinson } from '../src/indexer';

describe('parkinson', () => {
  it('is zero for a flat candle', () => {
    expect(parkinson({ intervalStart: 0, open: 1, high: 1, low: 1, close: 1 })).toBe(0);
  });

  it('grows with the high/low range', () => {
    const narrow = parkinson({ intervalStart: 0, open: 1, high: 1.01, low: 0.99, close: 1 })!;
    const wide = parkinson({ intervalStart: 0, open: 1, high: 1.1, low: 0.9, close: 1 })!;
    expect(wide).toBeGreaterThan(narrow);
  });

  it('matches the closed form', () => {
    // sqrt(ln(H/L)^2 / (4 ln2))
    const v = parkinson({ intervalStart: 0, open: 1, high: 1.1, low: 0.9, close: 1 })!;
    const expected = Math.sqrt(Math.log(1.1 / 0.9) ** 2 / (4 * Math.LN2));
    expect(v).toBeCloseTo(expected, 12);
  });

  it('rejects nonsense candles rather than returning a number', () => {
    expect(parkinson({ intervalStart: 0, open: 1, high: 0, low: 1, close: 1 })).toBeUndefined();
    expect(parkinson({ intervalStart: 0, open: 1, high: 0.9, low: 1.0, close: 1 })).toBeUndefined();
  });

  it('accepts the string amounts the API actually returns', () => {
    expect(parkinson({ intervalStart: 0, open: '1', high: '1.1', low: '0.9', close: '1' })).toBeGreaterThan(0);
  });
});

describe('median', () => {
  it('handles odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it('is undefined for an empty series', () => {
    expect(median([])).toBeUndefined();
  });
  it('is unmoved by a single outlier — the point of using it', () => {
    expect(median([1, 1, 1, 1, 1000])).toBe(1);
  });
});
