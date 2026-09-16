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

export interface RefreshInput {
  spotTick: number;
  limitLower: number;
  limitUpper: number;
  /** Zero when the vault holds no limit position. */
  limitLiquidity: bigint;
  /** How far (in ticks) spot must sit outside the limit range before a refresh. */
  refreshTicks: number;
}

/**
 * Whether the one-sided limit range has been left behind and should be
 * re-placed next to the price — WITHOUT moving the base band.
 *
 * The limit is "working" while spot is inside or near it: fills and un-fills
 * happen in place and need no transaction. It is "stranded" once spot sits
 * more than `refreshTicks` outside it — either because price traded through it
 * (fully converted, now waiting on the far side) or because price fell away
 * from it. Both cases are the same geometric condition, so no position-amount
 * reads are needed.
 *
 * Deliberately NOT triggered by conversion alone: a fully-converted limit with
 * spot still adjacent re-fills on the next wiggle for free, and re-placing it
 * would just pay gas to end up in the same place.
 */
export function shouldRefreshLimit(i: RefreshInput): Trigger {
  if (i.limitLiquidity === 0n || i.limitUpper <= i.limitLower) {
    return { trigger: false, reason: 'no limit position' };
  }
  const away =
    i.spotTick < i.limitLower
      ? i.limitLower - i.spotTick
      : i.spotTick > i.limitUpper
        ? i.spotTick - i.limitUpper
        : 0;
  if (away > i.refreshTicks) {
    return {
      trigger: true,
      reason: `limit [${i.limitLower}, ${i.limitUpper}] is ${away} ticks from spot ${i.spotTick} (> ${i.refreshTicks})`,
    };
  }
  return {
    trigger: false,
    reason: away === 0 ? 'spot inside limit range' : `limit ${away} ticks from spot (<= ${i.refreshTicks})`,
  };
}

export interface FoldInput {
  /** Limit-position legs, BOTH valued in token1 terms (value0 = amount0 × price). */
  limitValue0: number;
  limitValue1: number;
  /** Zero when the vault holds no limit position. */
  limitLiquidity: bigint;
  /** Whole-vault value in the same token1 terms, for the worth-a-slot floor. */
  navValue: number;
  /** Fire when min(leg)/limit value reaches this. 0.4 = the limit is ≥40/60 mixed. */
  foldMinShare: number;
  /** Ignore limits worth under this fraction of NAV — not worth a cooldown slot. */
  foldMinLimitShare: number;
}

/**
 * Whether a half-traversed limit order should be FOLDED into the base.
 *
 * A one-sided limit starts 100% one token. When price trades into it, it
 * converts — and a limit that has reached a mixed composition is a conversion
 * the vault has been paid fees for but has not banked: left alone, the second
 * half converts too and the position comes out 100% the OTHER token (the
 * composition flip-flop; the limit carries 2X−1 of NAV at token0-share X, twice
 * what reaching 50/50 requires, so a full traversal reflects X → 1−X).
 *
 * The fold is the same zero-translation rebalance as a limit refresh — base
 * ticks unchanged, trivially inside the proxy caps — but triggered by the
 * limit's COMPOSITION instead of its geometry: the burn-and-remint lets the
 * base absorb the newly pairable inventory (the base mint is scarce-side
 * constrained, so pairable tokens go to the base first) and re-parks only the
 * residual one-sided. Idempotent by construction: the residual limit is
 * one-sided again, so its min-leg share is 0 and the trigger clears itself.
 *
 * Composition can only be moved by really trading through the pool (amounts
 * change with in-range price movement, which costs the fee), and the action
 * still sits behind the dwell, cooldown, TWAP and oracle gates — the same
 * posture as the refresh trigger.
 */
export function shouldFold(i: FoldInput): Trigger {
  if (i.limitLiquidity === 0n) return { trigger: false, reason: 'no limit position' };
  const lv = i.limitValue0 + i.limitValue1;
  if (!(lv > 0)) return { trigger: false, reason: 'limit has no value' };
  if (i.navValue > 0 && lv / i.navValue < i.foldMinLimitShare) {
    return {
      trigger: false,
      reason: `limit ${((lv / i.navValue) * 100).toFixed(1)}% of NAV < floor ${(i.foldMinLimitShare * 100).toFixed(0)}%`,
    };
  }
  const minShare = Math.min(i.limitValue0, i.limitValue1) / lv;
  if (minShare >= i.foldMinShare) {
    return {
      trigger: true,
      reason: `limit is ${(minShare * 100).toFixed(1)}/${((1 - minShare) * 100).toFixed(1)} mixed (>= ${(i.foldMinShare * 100).toFixed(0)}% min leg) — fold conversion into base`,
    };
  }
  return {
    trigger: false,
    reason: `limit min leg ${(minShare * 100).toFixed(1)}% < ${(i.foldMinShare * 100).toFixed(0)}%`,
  };
}

/** Trigger predicate plus the band it would place, centered on `placementTick`. */
export function decide(i: DecideInput): Decision {
  const [newBaseLower, newBaseUpper] = centeredBand(i.placementTick, i.baseHalfWidthMult, i.tickSpacing);
  return { ...shouldRebalance(i), newBaseLower, newBaseUpper };
}
