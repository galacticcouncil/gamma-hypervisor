import { loadKeeperConfig, selectVault, vaultFlag } from './config';
import { createChain, createVaultContext, measureBlockTimeSecs } from './chain';
import { evaluate, initialState } from './keeper';
import { log } from './log';

async function main(): Promise<void> {
  const { global, vaults: cfgs } = loadKeeperConfig();
  // `--vault <address>`, else VAULT from the environment, else the only vault
  // configured. With several and no selector this throws with the list rather
  // than guessing which pool to touch.
  const cfg = selectVault(cfgs, vaultFlag(process.argv) ?? process.env.VAULT);

  const chain = createChain(global);
  const blockTimeSecs = await measureBlockTimeSecs(chain.provider);
  const ctx = await createVaultContext(chain, cfg, blockTimeSecs);

  log(`one-shot evaluate (${cfg.DRY_RUN ? 'DRY' : 'LIVE'}) on ${cfg.RPC_URL}`);
  ctx.log(`vault ${cfg.VAULT}`);
  if (!ctx.proxy && ctx.owner.toLowerCase() !== chain.signer.address.toLowerCase()) {
    ctx.log('  ⚠ signer is NOT the vault owner — rebalance() is onlyOwner and will revert.');
  }

  ctx.state = await initialState(ctx);
  // A one-shot run has no block history to build dwell from, so satisfy it up
  // front: the operator invoking this IS the confirmation. Timestamp 1 is
  // "held since the epoch", which clears any dwell window.
  ctx.state.dwellSince = 1;
  ctx.state.refreshDwellSince = 1;

  const blockNumber = await chain.provider.getBlockNumber();
  const block = await chain.provider.getBlock(blockNumber);
  await evaluate(ctx, blockNumber, block);
  process.exit(0);
}

main().catch((e) => {
  log(`fatal: ${e?.stack ?? e?.message ?? e}`);
  process.exit(1);
});
