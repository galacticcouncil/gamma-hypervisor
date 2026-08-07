import { ethers } from 'ethers';
import type { Ctx } from './chain';

export interface RebalanceArgs {
  baseLower: number;
  baseUpper: number;
  limitLower: number;
  limitUpper: number;
  feeRecipient: string;
  inMin: ethers.BigNumber[];
  outMin: ethers.BigNumber[];
}

export function toCallArgs(a: RebalanceArgs) {
  return [a.baseLower, a.baseUpper, a.limitLower, a.limitUpper, a.feeRecipient, a.inMin, a.outMin] as const;
}

export async function preflight(
  ctx: Ctx,
  a: RebalanceArgs,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (ctx.proxy) {
      await ctx.proxy.callStatic.rebalance(ctx.vault.address, ...toCallArgs(a));
    } else {
      await ctx.vault.callStatic.rebalance(...toCallArgs(a));
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.reason ?? e?.error?.message ?? e?.message ?? String(e) };
  }
}
