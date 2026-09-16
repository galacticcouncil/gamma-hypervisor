export type LimitSide = 'above' | 'below';

export function truncToSpacing(tick: number, spacing: number): number {
  return Math.trunc(tick / spacing) * spacing;
}

export function floorToSpacing(tick: number, spacing: number): number {
  let mod = tick % spacing;
  if (mod < 0) mod += spacing;
  return tick - mod;
}

export function ceilToSpacing(tick: number, spacing: number): number {
  const f = floorToSpacing(tick, spacing);
  return f === tick ? f : f + spacing;
}

export function centeredBand(tick: number, halfWidthMult: number, spacing: number): [number, number] {
  const half = halfWidthMult * spacing;
  return [floorToSpacing(tick - half, spacing), ceilToSpacing(tick + half, spacing)];
}

// Mirrors AutoRebal.sol: a one-sided range placed strictly to one side of the
// current tick (uses trunc-toward-zero, like Solidity integer division).
export function limitRange(tick: number, spacing: number, side: LimitSide, widthMult: number): [number, number] {
  if (side === 'above') {
    let lower = truncToSpacing(tick, spacing) + spacing;
    if (lower === tick) lower += spacing;
    return [lower, lower + spacing * widthMult];
  }
  let upper = truncToSpacing(tick, spacing) - spacing;
  if (upper === tick) upper -= spacing;
  return [upper - spacing * widthMult, upper];
}

// RebalanceProxy.isWithinRange's midpoint: lower + trunc((upper - lower) / 2).
// Both of the contract's branches reduce to this formula.
export function bandMid(lower: number, upper: number): number {
  return lower + Math.trunc((upper - lower) / 2);
}

export interface ClampResult {
  band: [number, number];
  clamped: boolean;
}

// Respect RebalanceProxy's per-rebalance translation cap: if the target band's
// midpoint is further than `maxTranslation` ticks from the current band's, walk
// toward it by (cap − 2×spacing) instead — the 2×spacing slack absorbs the grid
// rounding so the post-rounding midpoint still clears the cap.
// Repeated rebalances (one per proxy minInterval) then converge on the target.
//
// The walk is a RIGID shift of the target band along the spacing grid, so the
// band's width and shape survive it. Rebuilding a fresh symmetric band at the
// walked midpoint (what this used to do) would discard that shape — and with
// BASE_SKEW_ENABLED the shape IS the skew, dropped on exactly the large moves
// that leave the inventory most lopsided.
export function clampBandTranslation(
  target: [number, number],
  current: [number, number],
  maxTranslation: number,
  spacing: number,
): ClampResult {
  const tMid = bandMid(target[0], target[1]);
  const cMid = bandMid(current[0], current[1]);
  if (Math.abs(tMid - cMid) <= maxTranslation) return { band: target, clamped: false };

  const step = maxTranslation - 2 * spacing;
  if (step <= 0) {
    throw new Error(
      `translation cap ${maxTranslation} is not workable with tick spacing ${spacing} (needs > 2×spacing); ` +
        `raise the cap on the RebalanceProxy`,
    );
  }
  const dir = tMid > cMid ? 1 : -1;
  // How far the target must be pulled BACK toward the current band, on the grid.
  const back = Math.round((Math.abs(tMid - cMid) - step) / spacing) * spacing;
  return { band: [target[0] - dir * back, target[1] - dir * back], clamped: true };
}

// --- inventory-skewed base band ------------------------------------------

export interface SkewOpts {
  /**
   * Floor on EACH leg, in ticks. Never let a leg collapse: with no lower leg
   * the pool has zero depth below spot, and ClearingV2 then rejects every
   * deposit with "price out of base range".
   */
  minLegTicks: number;
  /** Cap on the token0:token1 value ratio the band is asked to carry. */
  maxSkewRatio: number;
}

/**
 * The token0:token1 VALUE ratio a range [P−d, P+w] wants to hold at price P.
 *
 * A v3 position at price p over [pa, pb] holds
 *   amount1 = L·(√p − √pa)          → value1 = L·√p·(k_d − 1)/k_d
 *   amount0 = L·(1/√p − 1/√pb)      → value0 = L·√p·(k_w − 1)/k_w
 * with k_x = 1.0001^(x/2). The L·√p cancels, leaving a ratio that depends only
 * on the two leg LENGTHS — which is what makes the band's shape a lever on
 * inventory at all.
 */
export function legValueRatio(d: number, w: number): number {
  const kd = Math.pow(1.0001, d / 2);
  const kw = Math.pow(1.0001, w / 2);
  return (kw - 1) / kw / ((kd - 1) / kd);
}

/**
 * A base band whose SHAPE carries the vault's inventory.
 *
 * `centeredBand` always wants a 50/50 split by value, so everything the vault
 * holds beyond that has nowhere to go but the one-sided limit range — at
 * token0 share X the limit ends up holding 2X−1 of NAV, which is twice what
 * must actually be sold to reach 50/50. Traversing it therefore does not land
 * at 50/50, it REFLECTS X → (1−X): the observed flip-flop.
 *
 * Skewing the band instead keeps spot INSIDE the quoted range (so the pool
 * keeps quoting and deposits keep clearing) and converts gradually, with no
 * completion point to overshoot. The limit is left with a small residual.
 *
 * The skew is a ROTATION, not a widening: `d + w` is held at the symmetric
 * width `2·halfWidthMult·spacing`, so the resulting band is the same width as
 * `centeredBand` would have produced and the proxy's width-change cap stays out
 * of the way in the common case.
 *
 * `share0 === 0.5` reproduces `centeredBand` EXACTLY, so the existing behaviour
 * is the identity case of this function.
 */
export function skewedBand(
  tick: number,
  share0: number,
  halfWidthMult: number,
  spacing: number,
  opts: SkewOpts,
): [number, number] {
  const half = halfWidthMult * spacing;
  const total = 2 * half;
  const minLeg = Math.max(1, Math.trunc(opts.minLegTicks));

  // Too narrow to hold two legs at the floor, or a share we cannot read: the
  // symmetric band is the best available answer, not an error.
  if (!Number.isFinite(share0) || total < 2 * minLeg) {
    return centeredBand(tick, halfWidthMult, spacing);
  }

  const s = Math.min(Math.max(share0, 0), 1);
  const cap = Math.max(1, opts.maxSkewRatio);
  // The ratio the inventory asks for, capped so an extreme (or briefly absurd)
  // inventory cannot demand a degenerate band.
  const wanted = s >= 1 ? cap : Math.min(Math.max(s / (1 - s), 1 / cap), cap);

  // legValueRatio is strictly DECREASING in d at fixed total width: a longer
  // lower leg buys more token1 and, since d + w is fixed, leaves less room
  // above for token0. So bisect on d — clearer than inverting it in closed
  // form, and the monotonicity makes it exact enough to be boring.
  const lo = minLeg;
  const hi = total - minLeg;
  let d: number;
  if (wanted >= legValueRatio(lo, total - lo)) {
    d = lo;
  } else if (wanted <= legValueRatio(hi, total - hi)) {
    d = hi;
  } else {
    let a = lo;
    let b = hi;
    for (let i = 0; i < 80; i++) {
      const m = (a + b) / 2;
      if (legValueRatio(m, total - m) > wanted) a = m;
      else b = m;
    }
    d = (a + b) / 2;
  }

  // Round the leg to whole ticks BEFORE the spacing rounding: floor/ceil on a
  // fractional tick would land a whole spacing out, and at share0 = 0.5 this is
  // what makes d === w === half exactly, hence centeredBand exactly.
  const dTicks = Math.round(d);
  const wTicks = total - dTicks;
  return [floorToSpacing(tick - dTicks, spacing), ceilToSpacing(tick + wTicks, spacing)];
}

/**
 * Respect RebalanceProxy's per-rebalance WIDTH-change cap (isWidthChangeWithinRange,
 * contracts/RebalanceProxy.sol:77) the same way clampBandTranslation respects the
 * translation cap: walk toward the target instead of refusing to move.
 *
 * Skipping was the old behaviour, and a target the proxy can never accept in one
 * step meant skipping FOREVER — the keeper would log the same line every block
 * and never rebalance again. Stepping converges instead, one step per proxy
 * minInterval.
 *
 * Both bands are already on the spacing grid, so their widths are multiples of
 * spacing and the step can be a whole number of spacings — which makes the
 * realised width change exactly `steps·spacing`, never a rounding hair over the
 * cap.
 *
 * `anchor` is the placement tick. The legs are scaled about it, NOT about the
 * band's own midpoint: a skewed band shrunk about its midpoint can end up not
 * containing the price at all, which is the one thing the band must never do.
 * Anchoring keeps spot inside and keeps the leg ratio — the skew — intact,
 * while only the width moves.
 */
export function clampBandWidth(
  target: [number, number],
  current: [number, number],
  anchor: number,
  maxWidth: number,
  spacing: number,
): ClampResult {
  const currentWidth = current[1] - current[0];
  const targetWidth = target[1] - target[0];
  const delta = targetWidth - currentWidth;
  if (Math.abs(delta) <= maxWidth) return { band: target, clamped: false };

  const steps = Math.floor(maxWidth / spacing);
  if (steps < 1) {
    throw new Error(
      `width cap ${maxWidth} is under one tick spacing (${spacing}), so the band width can never ` +
        `change; raise the cap on the RebalanceProxy`,
    );
  }
  // Never shrink below one spacing: Hypervisor.rebalance requires lower < upper.
  // This can only make the step SMALLER than the cap allows, so it stays legal.
  const allowed = Math.max(spacing, currentWidth + Math.sign(delta) * steps * spacing);

  const f = targetWidth > 0 ? allowed / targetWidth : 0.5;
  const lower = floorToSpacing(anchor - (anchor - target[0]) * f, spacing);
  return { band: [lower, lower + allowed], clamped: true };
}
