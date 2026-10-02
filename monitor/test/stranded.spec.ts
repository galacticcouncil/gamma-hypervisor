import { describe, it, expect } from 'vitest';
import { blankMemo, heldFor, strandedFor } from '../src/checks';

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

describe('heldFor: divergence must outlast its grace before it is reported', () => {
  it('a 20-minute pool vs feed gap stays under the default 3600s grace', () => {
    const m = blankMemo();
    heldFor(m, 'divergedSince', true, 0);
    expect(heldFor(m, 'divergedSince', true, 1200)).toBeLessThan(3600);
    expect(heldFor(m, 'divergedSince', false, 1500)).toBe(0);
    expect(m.divergedSince).toBeNull();
  });

  it('a gap that persists past the grace is reported', () => {
    const m = blankMemo();
    heldFor(m, 'divergedSince', true, 0);
    expect(heldFor(m, 'divergedSince', true, 6000)).toBeGreaterThan(3600);
  });

  it('keeps the stranded and divergence clocks independent', () => {
    const m = blankMemo();
    heldFor(m, 'divergedSince', true, 100);
    strandedFor(m, true, 500);
    expect(m.divergedSince).toBe(100);
    expect(m.strandedSince).toBe(500);
  });
});
