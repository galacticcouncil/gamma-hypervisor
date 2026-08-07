import { ethers } from 'ethers';

export interface Slot0 {
  sqrtPriceX96: ethers.BigNumber;
  tick: number;
  observationIndex: number;
  observationCardinality: number;
}

export async function readSlot0(pool: ethers.Contract): Promise<Slot0> {
  const s = await pool.slot0();
  return {
    sqrtPriceX96: s.sqrtPriceX96,
    tick: s.tick,
    observationIndex: s.observationIndex,
    observationCardinality: s.observationCardinality,
  };
}

// Arithmetic-mean tick over the window, mirroring Uniswap's OracleLibrary.consult:
// newer cumulative minus older, floored (not truncated) for negative deltas.
// observe()'s return arrays are parallel to secondsAgos, so with [window, 0] the
// index-0 entry is the OLDER cumulative.
export function twapTickFromCumulatives(
  cumOlder: ethers.BigNumber,
  cumNewer: ethers.BigNumber,
  windowSecs: number,
): number {
  const delta = cumNewer.sub(cumOlder);
  let tick = delta.div(windowSecs).toNumber();
  if (delta.isNegative() && !delta.mod(windowSecs).isZero()) tick -= 1;
  return tick;
}

export async function readTwapTick(pool: ethers.Contract, windowSecs: number): Promise<number> {
  if (windowSecs <= 0) throw new Error('TWAP window must be > 0');
  const res = await pool.observe([windowSecs, 0]);
  const cum: ethers.BigNumber[] = res.tickCumulatives ?? res[0];
  return twapTickFromCumulatives(cum[0], cum[1], windowSecs);
}

// Age of the pool's oldest stored observation. observe() reverts with 'OLD' for
// windows longer than this, so the keeper clamps its TWAP window to it (and
// refuses to act below a configured floor).
export async function oldestObservationAgeSecs(pool: ethers.Contract, nowTs: number): Promise<number> {
  const s = await pool.slot0();
  const next = (s.observationIndex + 1) % s.observationCardinality;
  let obs = await pool.observations(next);
  if (!obs.initialized) obs = await pool.observations(0);
  return Math.max(0, nowTs - obs.blockTimestamp);
}
