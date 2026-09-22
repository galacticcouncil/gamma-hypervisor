import { PriceHistory } from './priceHistory';
import type { RegimeState } from './regime';

/**
 * Everything the keeper remembers about ONE vault between blocks.
 *
 * Lives on the vault's context, never in a module-level variable: with several
 * vaults in one process, a shared counter would let a spike on one pool arm the
 * dwell gate on another.
 */
export interface KeeperState {
  lastRebalanceTs: number;
  /**
   * Block timestamp at which the rebalance trigger first held, or 0 when it is
   * not holding. Wall clock, not a block count — see resolveDwellSecs().
   */
  dwellSince: number;
  /** Same, for the limit-refresh trigger. */
  refreshDwellSince: number;
  /** Same, for the fold-at-balance trigger. */
  foldDwellSince: number;
  /** Volatility regime, and when it was entered. */
  regime: RegimeState;
  /** Feed price trail, for the "moved X% in Y minutes" checks. */
  prices: PriceHistory;
  /** Cached 30-day vol median: the one input that needs the indexer. */
  volBaseline?: { median: number; fetchedAt: number };
  lastCompoundTs: number;
}

/** A fresh, independent state. Never share one between vaults. */
export function blankState(): KeeperState {
  return {
    lastRebalanceTs: 0,
    dwellSince: 0,
    refreshDwellSince: 0,
    foldDwellSince: 0,
    // Start calm rather than extreme: the first evaluation re-derives it from
    // live inputs anyway, and booting into `extreme` would impose the full
    // re-entry wait on every restart.
    regime: { regime: 'calm', since: 0 },
    prices: new PriceHistory(2 * 60 * 60),
    lastCompoundTs: 0,
  };
}
