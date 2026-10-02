import { describe, it, expect } from 'vitest';
import { blankMemo, strandedFor } from '../src/checks';

describe('strandedFor: how long the limit has sat past the refresh threshold', () => {
  it('starts the clock on the first sighting, not before', () => {
    const m = blankMemo();
    expect(strandedFor(m, false, 1000)).toBe(0);
    expect(strandedFor(m, true, 1300)).toBe(0);
    expect(strandedFor(m, true, 1300 + 1890)).toBe(1890);
  });

  it('resets once the keeper refreshes or price comes back', () => {
    const m = blankMemo();
    strandedFor(m, true, 0);
    expect(strandedFor(m, true, 5000)).toBe(5000);
    expect(strandedFor(m, false, 5300)).toBe(0);
    expect(m.strandedSince).toBeNull();
    expect(strandedFor(m, true, 9000)).toBe(0);
  });

  it('keeps a dwell-length crossing under the 7200s grace', () => {
    // the keeper holds a refresh for ~1890s before acting; the alert must wait longer
    const m = blankMemo();
    strandedFor(m, true, 0);
    expect(strandedFor(m, true, 1890 + 300)).toBeLessThan(7200);
    expect(strandedFor(m, true, 7201)).toBeGreaterThan(7200);
  });
});
