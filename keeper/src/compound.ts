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
export const ADMIN_COMPOUND_ABI = ['function compound(address _hypervisor) external'];

export interface CompoundInput {
  signer: ethers.Wallet;
  admin: string;
  vault: string;
  gasLimit: number;
  confirmations: number;
}

/** `true` if a compound landed, `false` if it was skipped or failed. Never throws. */
export async function compoundOnce(i: CompoundInput): Promise<boolean> {
  try {
    const admin = new ethers.Contract(i.admin, ADMIN_COMPOUND_ABI, i.signer);

    // Preflight as a call first: a revert here is informational (usually "only
    // advisor" or nothing to harvest) and must not cost gas or kill the loop.
    await admin.callStatic.compound(i.vault);

    const tx = await admin.compound(i.vault, { gasLimit: i.gasLimit });
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
