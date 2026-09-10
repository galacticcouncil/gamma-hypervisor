/**
 * Volatility regime — the vault's stand-in for a dynamic fee.
 *
 * Uniswap v3 cannot raise its fee when the market turns, so the vault withdraws
 * the offer instead: quote wider, or stop quoting. Thresholds are from the garden
 * spec (note-gamma-adot-hollar-alm-spec §D3).
 */
export type Regime = 'calm' | 'elevated' | 'extreme';

export interface RegimeInput {
  /** Current 1h vol / its 30-day median. Undefined when the indexer is unusable. */
  volRatio?: number;
  /** Absolute fractional price move over ~15 minutes, e.g. 0.02 = 2%. */
  move15m?: number;
  /** Absolute fractional price move over ~1 hour. */
  move1h?: number;
  /** False when the price feed is stale, unreadable or disagrees with the pool. */
  feedHealthy: boolean;
  /** Undefined = the check failed, which is NOT the same as "not paused". */
  reservePaused?: boolean;
}

export interface RegimeThresholds {
  volRatioElevated: number;
  move15mElevated: number;
  move1hExtreme: number;
  /** Seconds of continuous calm before leaving `extreme`. */
  reentrySecs: number;
}

export interface RegimeState {
  regime: Regime;
  /** When the current regime was entered (unix seconds). */
  since: number;
  /** First time conditions looked calm again while in `extreme`. */
  calmSince?: number;
}

export interface RegimeDecision {
  regime: Regime;
  reason: string;
  /** True on the evaluation where the regime changed — the line worth alerting on. */
  changed: boolean;
  state: RegimeState;
}

/** The regime the raw inputs imply, before any re-entry hysteresis. */
function rawRegime(i: RegimeInput, t: RegimeThresholds): { regime: Regime; reason: string } {
  // --- extreme ---
  // An unknown pause state counts as extreme: if we cannot tell whether the
  // reserve is live, we must not assume it is.
  if (i.reservePaused !== false) {
    return {
      regime: 'extreme',
      reason:
        i.reservePaused === true
          ? 'money-market reserve is PAUSED — aToken transfers revert, the pool is seized'
          : 'money-market pause state unreadable — treating as paused',
    };
  }
  if (!i.feedHealthy) {
    return { regime: 'extreme', reason: 'price feed stale, unreadable or diverging from the pool' };
  }
  if (i.move1h !== undefined && i.move1h >= t.move1hExtreme) {
    return {
      regime: 'extreme',
      reason: `price moved ${(i.move1h * 100).toFixed(2)}% in 1h (>= ${(t.move1hExtreme * 100).toFixed(0)}%)`,
    };
  }

  // --- elevated ---
  if (i.volRatio !== undefined && i.volRatio >= t.volRatioElevated) {
    return {
      regime: 'elevated',
      reason: `1h vol is ${i.volRatio.toFixed(2)}x its 30d median (>= ${t.volRatioElevated}x)`,
    };
  }
  if (i.move15m !== undefined && i.move15m >= t.move15mElevated) {
    return {
      regime: 'elevated',
      reason: `price moved ${(i.move15m * 100).toFixed(2)}% in 15m (>= ${(t.move15mElevated * 100).toFixed(0)}%)`,
    };
  }

  return { regime: 'calm', reason: 'vol and price moves within normal bounds' };
}

/**
 * Advance the regime state machine.
 *
 * Entering `extreme` is immediate; leaving it is not. The vault has to see
 * `reentrySecs` of continuous calm first, so a market that is oscillating across
 * the threshold cannot make the keeper add and pull liquidity repeatedly — each
 * of those round trips costs real money.
 */
export function nextRegime(
  i: RegimeInput,
  t: RegimeThresholds,
  prev: RegimeState,
  nowTs: number,
): RegimeDecision {
  const raw = rawRegime(i, t);

  if (prev.regime === 'extreme' && raw.regime !== 'extreme') {
    const calmSince = prev.calmSince ?? nowTs;
    const calmFor = nowTs - calmSince;
    if (calmFor < t.reentrySecs) {
      return {
        regime: 'extreme',
        reason: `holding extreme — calm for ${calmFor}s of ${t.reentrySecs}s required before re-entry`,
        changed: false,
        state: { ...prev, calmSince },
      };
    }
    return {
      regime: raw.regime,
      reason: `re-entering after ${calmFor}s calm — ${raw.reason}`,
      changed: true,
      state: { regime: raw.regime, since: nowTs },
    };
  }

  const changed = raw.regime !== prev.regime;
  return {
    regime: raw.regime,
    reason: raw.reason,
    changed,
    state: changed
      ? { regime: raw.regime, since: nowTs }
      : { ...prev, calmSince: raw.regime === 'extreme' ? undefined : prev.calmSince },
  };
}

/** Band half-width to use in a given regime, as a multiple of tickSpacing. */
export function bandMultForRegime(regime: Regime, baseMult: number, elevatedMult: number): number {
  return regime === 'calm' ? baseMult : Math.max(baseMult, elevatedMult);
}
