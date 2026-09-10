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
// toward it by (cap − 2×spacing) instead — the 2×spacing slack absorbs
// centeredBand's rounding so the post-rounding midpoint still clears the cap.
// Repeated rebalances (one per proxy minInterval) then converge on the target.
export function clampBandTranslation(
  target: [number, number],
  current: [number, number],
  maxTranslation: number,
  halfWidthMult: number,
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
  return { band: centeredBand(cMid + dir * step, halfWidthMult, spacing), clamped: true };
}
