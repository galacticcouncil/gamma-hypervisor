import { describe, it, expect } from 'vitest';
import { bandMultForRegime, nextRegime, type RegimeState } from '../src/regime';

const T = {
  volRatioElevated: 3,
  move15mElevated: 0.02,
  move1hExtreme: 0.08,
  reentrySecs: 7200,
};
const NOW = 1_800_000_000;
const calm: RegimeState = { regime: 'calm', since: NOW - 10_000 };
const healthy = { feedHealthy: true, reservePaused: false };

describe('regime', () => {
  it('stays calm when nothing is moving', () => {
    const d = nextRegime({ ...healthy, volRatio: 1.1, move15m: 0.001 }, T, calm, NOW);
    expect(d.regime).toBe('calm');
    expect(d.changed).toBe(false);
  });

  it('escalates to elevated on the vol ratio', () => {
    const d = nextRegime({ ...healthy, volRatio: 3.5 }, T, calm, NOW);
    expect(d.regime).toBe('elevated');
    expect(d.changed).toBe(true);
    expect(d.reason).toMatch(/3.50x/);
  });

  it('escalates to elevated on a 15m move even with no vol data', () => {
    // The indexer being down must not disable this trigger.
    const d = nextRegime({ ...healthy, volRatio: undefined, move15m: 0.025 }, T, calm, NOW);
    expect(d.regime).toBe('elevated');
  });

  it('escalates to extreme on a 1h move', () => {
    const d = nextRegime({ ...healthy, move1h: 0.09 }, T, calm, NOW);
    expect(d.regime).toBe('extreme');
  });

  it('escalates to extreme when the feed is unhealthy', () => {
    const d = nextRegime({ feedHealthy: false, reservePaused: false }, T, calm, NOW);
    expect(d.regime).toBe('extreme');
    expect(d.reason).toMatch(/feed/);
  });

  it('escalates to extreme when the reserve is paused', () => {
    const d = nextRegime({ feedHealthy: true, reservePaused: true }, T, calm, NOW);
    expect(d.regime).toBe('extreme');
    expect(d.reason).toMatch(/PAUSED/);
  });

  it('treats an UNREADABLE pause state as paused, not as fine', () => {
    const d = nextRegime({ feedHealthy: true, reservePaused: undefined }, T, calm, NOW);
    expect(d.regime).toBe('extreme');
    expect(d.reason).toMatch(/unreadable/);
  });

  describe('re-entry hysteresis', () => {
    const extreme: RegimeState = { regime: 'extreme', since: NOW - 100_000 };

    it('does not leave extreme the moment conditions clear', () => {
      const d = nextRegime(healthy, T, extreme, NOW);
      expect(d.regime).toBe('extreme');
      expect(d.reason).toMatch(/holding extreme/);
      expect(d.state.calmSince).toBe(NOW);
    });

    it('still holds just short of the re-entry window', () => {
      const armed = { ...extreme, calmSince: NOW - T.reentrySecs + 1 };
      expect(nextRegime(healthy, T, armed, NOW).regime).toBe('extreme');
    });

    it('re-enters once calm has held long enough', () => {
      const armed = { ...extreme, calmSince: NOW - T.reentrySecs };
      const d = nextRegime(healthy, T, armed, NOW);
      expect(d.regime).toBe('calm');
      expect(d.changed).toBe(true);
    });

    it('restarts the clock if conditions turn bad again mid-wait', () => {
      const armed = { ...extreme, calmSince: NOW - 3600 };
      const relapse = nextRegime({ feedHealthy: false, reservePaused: false }, T, armed, NOW);
      expect(relapse.regime).toBe('extreme');
      expect(relapse.state.calmSince).toBeUndefined();
    });
  });

  it('widens the band only outside calm', () => {
    expect(bandMultForRegime('calm', 16, 30)).toBe(16);
    expect(bandMultForRegime('elevated', 16, 30)).toBe(30);
    expect(bandMultForRegime('extreme', 16, 30)).toBe(30);
  });

  it('never narrows the band, even if misconfigured', () => {
    expect(bandMultForRegime('elevated', 40, 30)).toBe(40);
  });
});
