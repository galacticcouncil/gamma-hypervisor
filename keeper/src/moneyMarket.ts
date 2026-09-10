import { ethers } from 'ethers';
import { withRetry } from './retry';

/**
 * Is the money-market reserve backing our aToken paused?
 *
 * This is the failure the spec calls out by name. A PAUSED reserve (not frozen —
 * frozen still allows transfers) makes aToken transfers revert, so the pool
 * seizes: every swap fails, and every rebalance the keeper attempts fails too,
 * burning gas on transactions that were never going to land.
 *
 * The check is against the Aave protocol data provider, using the UNDERLYING
 * asset's address (DOT), not the aToken's.
 */
export const DATA_PROVIDER_ABI = [
  'function getPaused(address asset) view returns (bool)',
];

export interface ReservePauseInput {
  provider: ethers.providers.Provider;
  dataProvider: string;
  /** Underlying reserve asset, e.g. the DOT precompile behind aDOT. */
  underlying: string;
}

/**
 * `true` / `false` when known, `undefined` when the check itself failed.
 *
 * The three are different and callers must treat them differently: `undefined`
 * is "we could not tell", which is not the same as "not paused". Refusing to act
 * on `undefined` keeps the keeper fail-closed.
 */
export async function isReservePaused(i: ReservePauseInput): Promise<boolean | undefined> {
  try {
    const dp = new ethers.Contract(i.dataProvider, DATA_PROVIDER_ABI, i.provider);
    return await withRetry(() => dp.getPaused(i.underlying) as Promise<boolean>, {
      attempts: 3,
      baseDelayMs: 300,
    });
  } catch {
    return undefined;
  }
}
