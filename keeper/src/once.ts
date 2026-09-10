import { loadConfig } from './config';
import { createContext } from './chain';
import { evaluate, initialState } from './keeper';
import { log } from './log';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ctx = await createContext(cfg);
  log(`one-shot evaluate (${cfg.DRY_RUN ? 'DRY' : 'LIVE'}) on ${cfg.RPC_URL}`);
  if (!ctx.proxy && ctx.owner.toLowerCase() !== ctx.signer.address.toLowerCase()) {
    log('  ⚠ signer is NOT the vault owner — rebalance() is onlyOwner and will revert.');
  }
  const state = await initialState(ctx);
  // A one-shot run has no block history to build dwell from, so satisfy it up
  // front: the operator invoking this IS the confirmation.
  state.dwell = cfg.DWELL_BLOCKS - 1;
  const blockNumber = await ctx.provider.getBlockNumber();
  await evaluate(ctx, blockNumber, state);
  process.exit(0);
}

main().catch((e) => {
  log(`fatal: ${e?.stack ?? e?.message ?? e}`);
  process.exit(1);
});
