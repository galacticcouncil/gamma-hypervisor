import { centeredBand } from './ticks';

export interface TriggerInput {
  /** Spot tick — decides WHETHER to rebalance (has price left the band?). */
  spotTick: number;
  baseLower: number;
  baseUpper: number;
  tickSpacing: number;
  rebalanceThresholdMult: number;
}

export interface DecideInput extends TriggerInput {
  /**
   * Placement tick — decides WHERE the new band goes. In hardened mode this is
   * the pool TWAP tick, so a spot push can trigger a rebalance but cannot drag
   * the band to the pushed price; with TWAP off it falls back to spot.
   */
  placementTick: number;
  baseHalfWidthMult: number;
}

export interface Trigger {
  trigger: boolean;
  reason: string;
}

export interface Decision extends Trigger {
  newBaseLower: number;
  newBaseUpper: number;
}

/**
 * The trigger predicate alone. The keeper evaluates this every block before
 * spending calls on the gates, and only learns the placement tick (the TWAP)
 * once those gates have run — hence the split from `decide`.
 */
export function shouldRebalance(i: TriggerInput): Trigger {
  const mid = Math.trunc((i.baseLower + i.baseUpper) / 2);
  const outside = i.spotTick < i.baseLower || i.spotTick > i.baseUpper;
  const drift = Math.abs(i.spotTick - mid);
  const threshold = i.rebalanceThresholdMult * i.tickSpacing;
  const driftTrip = drift > threshold;

  const reason = outside
    ? `tick ${i.spotTick} outside base [${i.baseLower}, ${i.baseUpper}]`
    : driftTrip
      ? `drift ${drift} > threshold ${threshold}`
      : `in range (drift ${drift} <= ${threshold})`;

  return { trigger: outside || driftTrip, reason };
}

/** Trigger predicate plus the band it would place, centered on `placementTick`. */
export function decide(i: DecideInput): Decision {
  const [newBaseLower, newBaseUpper] = centeredBand(i.placementTick, i.baseHalfWidthMult, i.tickSpacing);
  return { ...shouldRebalance(i), newBaseLower, newBaseUpper };
}
