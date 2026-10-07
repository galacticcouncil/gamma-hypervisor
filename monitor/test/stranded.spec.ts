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

describe('heldFor: rebalance-overdue waits out the keeper dwell from when drift started', () => {
  // 2026-10-07 aPAXG/HOLLAR: last rebalance 144h back, drift crossed 180 at ~12:25 UTC,
  // the monitor paged at 12:43, the keeper rebalanced at 13:09 after its ~45 min dwell
  const crossed = 0, paged = 18 * 60, rebalanced = 44 * 60;

  it('a dwell-length crossing stays under the 7200s grace', () => {
    const m = blankMemo();
    heldFor(m, 'driftSince', true, crossed);
    expect(heldFor(m, 'driftSince', true, paged)).toBeLessThan(7200);
    expect(heldFor(m, 'driftSince', true, rebalanced)).toBeLessThan(7200);
    expect(heldFor(m, 'driftSince', false, rebalanced + 60)).toBe(0);
    expect(m.driftSince).toBeNull();
  });

  it('drift the keeper never acts on is reported once it outlasts the grace', () => {
    const m = blankMemo();
    heldFor(m, 'driftSince', true, crossed);
    expect(heldFor(m, 'driftSince', true, 7201)).toBeGreaterThan(7200);
  });

  it('runs its own clock beside the stranded and divergence ones', () => {
    const m = blankMemo();
    heldFor(m, 'driftSince', true, 10);
    heldFor(m, 'divergedSince', true, 20);
    strandedFor(m, true, 30);
    expect([m.driftSince, m.divergedSince, m.strandedSince]).toEqual([10, 20, 30]);
  });
});
