import { ethers } from 'ethers';
import { log } from './log';

/**
 * Harvest accrued swap fees and re-mint them into THE SAME ticks.
 *
 * Separate from rebalancing, and deliberately on a different clock. Compounding
 * does not move the band, so it is not bound by the proxy's `minInterval` — and
 * its cadence is what sets how often the fee recipient actually receives
 * anything, because the vault's cut is taken at each harvest.
 *
 * Reached through `Admin.compound`, which is `onlyAdvisor` — a different role
 * from the rebalancer. The deploy scripts set the keeper as the advisor
 * (KEEPER_ADDRESS); without that this call reverts with "only advisor" and
 * compounding is simply unavailable.
 */
/**
 * SLIPPAGE. `compound()` re-mints the vault's entire idle balance at whatever
 * price the pool quotes when the tx lands — one block after the keeper looked.
 * That gap is front-runnable: shove the price, let our mint land against the
 * distorted composition, shove it back. `inMin` is the only protection that
 * binds at EXECUTION time, so we always call the bounded overload and never
 * fall back to the unbounded one. If the deployed Admin predates that overload
 * the preflight reverts and we skip, which is the correct failure direction.
 */
export const ADMIN_COMPOUND_ABI = [
  'function compound(address _hypervisor) external',
  'function compound(address _hypervisor, uint256[4] inMin) external',
];

/** Explicit signature: ethers needs it to pick between the two overloads. */
const BOUNDED = 'compound(address,uint256[4])';

export interface CompoundInput {
  signer: ethers.Wallet;
  admin: string;
  vault: string;
  /** Floors on what the base and limit mints must consume. Never all-zero. */
  inMin: ethers.BigNumber[];
  gasLimit: number;
  /** Explicit legacy gasPrice; see config.ts GAS_PRICE_MARKUP_PCT. */
  gasPrice: ethers.BigNumber;
  confirmations: number;
}

/** `true` if a compound landed, `false` if it was skipped or failed. Never throws. */
export async function compoundOnce(i: CompoundInput): Promise<boolean> {
  try {
    const admin = new ethers.Contract(i.admin, ADMIN_COMPOUND_ABI, i.signer);

    // Preflight as a call first: a revert here is informational (usually "only
    // advisor" or nothing to harvest) and must not cost gas or kill the loop.
    await admin.callStatic[BOUNDED](i.vault, i.inMin);

    const tx = await admin[BOUNDED](i.vault, i.inMin, { gasLimit: i.gasLimit, gasPrice: i.gasPrice });
    log(`  compound submitted ${tx.hash}`);
    await tx.wait(i.confirmations);
    log('  ✓ compounded');
    return true;
  } catch (e: any) {
    const reason = e?.reason ?? e?.error?.message ?? e?.message ?? e;
    log(`  compound skipped: ${reason}`);
    return false;
  }
}
