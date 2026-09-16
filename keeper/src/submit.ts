import { txOverrides, type VaultCtx } from './chain';
import { toCallArgs, type RebalanceArgs } from './preflight';

export async function submitRebalance(ctx: VaultCtx, a: RebalanceArgs): Promise<string> {
  const { cfg } = ctx;
  const { signer } = ctx.chain;
  // Hydration retains pending nonces oddly; pin the 'pending' nonce explicitly and
  // wait for several confirmations to avoid the stale-pending "nonce too low" failure.
  const nonce = await signer.getTransactionCount('pending');
  const overrides = await txOverrides(ctx.chain, { nonce });
  const tx = ctx.proxy
    ? await ctx.proxy.rebalance(ctx.vault.address, ...toCallArgs(a), overrides)
    : await ctx.vault.rebalance(...toCallArgs(a), overrides);
  const receipt = await tx.wait(cfg.CONFIRMATIONS);
  return receipt.transactionHash;
}
