import { ethers } from 'ethers';
import { loadConfig } from './config';
import { createContext, readProxyCaps, type Ctx } from './chain';
import { startKeeper } from './keeper';
import { log } from './log';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ctx = await createContext(cfg);

  const model = cfg.ENTRYPOINT === 'proxy' ? 'Model B (RebalanceProxy — bounded rebalancer key)' : 'Model A (signs as vault owner)';
  log(`Gamma keeper — ${model}`);
  log(`  rpc          ${cfg.RPC_URL}`);
  log(`  vault        ${cfg.VAULT}`);
  log(`  pool         ${ctx.pool.address}  (${ctx.symbol0}/${ctx.symbol1}, spacing ${ctx.tickSpacing})`);
  log(`  signer       ${ctx.signer.address}`);
  log(`  vault.owner  ${ctx.owner}`);
  log(`  feeRecipient ${ctx.feeRecipient}`);
  log(`  strategy     base ±${cfg.BASE_HALF_WIDTH_MULT}×spacing, trigger >${cfg.REBALANCE_THRESHOLD_MULT}×spacing, limit ${cfg.LIMIT_WIDTH_MULT}×spacing`);
  log(`  gates        twap ${cfg.TWAP_ENABLED ? `on (${cfg.TWAP_WINDOW_SECS}s, maxDev ${cfg.MAX_DEV_TICKS})` : 'OFF'}, dwell ${cfg.DWELL_BLOCKS} blocks, minInterval ${cfg.MIN_INTERVAL_SECS}s`);
  log(`  oracle       ${cfg.ORACLE_ENABLED ? `${cfg.ORACLE_FEED0}${cfg.ORACLE_FEED1 ? ` / ${cfg.ORACLE_FEED1}` : ' (token1 = USD side)'} (maxDev ${cfg.ORACLE_MAX_DEV_TICKS}, maxAge ${cfg.ORACLE_MAX_AGE_SECS}s)` : 'off'}`);
  log(`  mins         ${cfg.MINS_TOLERANCE_BPS} bps tolerance`);
  log(`  compound     ${cfg.COMPOUND_ENABLED ? `every ${cfg.COMPOUND_INTERVAL_SECS}s via Admin ${cfg.ADMIN_ADDRESS}, bounded` : 'off'}`);
  log(`  mode         ${cfg.DRY_RUN ? 'DRY_RUN (no tx)' : 'LIVE'}`);

  await validateRoles(ctx);

  if (!cfg.TWAP_ENABLED) {
    log('  ⚠ TWAP gate OFF — the band follows raw spot. Local/throwaway chains only.');
  }
  if (!cfg.ORACLE_ENABLED) {
    log('  ⚠ external oracle clamp OFF — the pool is its own only price reference.');
  }
  if (cfg.COMPOUND_ENABLED && cfg.COMPOUND_INTERVAL_SECS > 3600) {
    log(
      `  ⚠ COMPOUND_INTERVAL_SECS=${cfg.COMPOUND_INTERVAL_SECS} is long. Each sweep tips the whole\n` +
        '    idle balance into the pool at once, and what a sandwich can extract scales with\n' +
        '    that pile. Prefer minutes.',
    );
  }

  await startKeeper(ctx);
}

// Fail fast on a misconfigured access model: a keeper that can never land a tx
// should say so at startup, not silently log preflight reverts forever.
async function validateRoles(ctx: Ctx): Promise<void> {
  const signer = ctx.signer.address.toLowerCase();
  if (ctx.proxy) {
    const [rebalancer, admin] = await Promise.all([
      ctx.proxy.rebalancers(ctx.vault.address),
      ctx.proxy.admins(ctx.vault.address),
    ]);
    const caps = await readProxyCaps(ctx.proxy, ctx.vault.address);
    log(`  proxy        ${ctx.proxy.address}`);
    log(`  proxy caps   maxTranslation ${caps.maxTranslation}, maxWidth ${caps.maxWidth}, minInterval ${caps.minIntervalSecs}s${caps.exempted ? ' (vault EXEMPTED — caps not enforced)' : ''}`);
    if (rebalancer.toLowerCase() !== signer) {
      log(`  ⚠ signer is NOT the proxy's rebalancer for this vault (${rebalancer}) — every call will revert "only rebalancer".`);
    }
    if (admin === ethers.constants.AddressZero) {
      log('  ⚠ no Admin set on the proxy for this vault — RebalanceProxy.rebalance will revert.');
    } else if (admin.toLowerCase() !== ctx.owner.toLowerCase()) {
      log(`  ⚠ vault.owner (${ctx.owner}) is not the proxy's Admin (${admin}) — the Admin must own the vault.`);
    }
    if (caps.exempted) {
      log('  ⚠ vault is exempted on the proxy: translation/width caps are NOT enforced on-chain.');
    }

    // A configured band width the proxy's maxWidth can never accept would make
    // the keeper skip every block forever. Catch it here rather than in a log
    // line that scrolls past once a block.
    if (!caps.exempted) {
      const [lower, upper] = await Promise.all([ctx.vault.baseLower(), ctx.vault.baseUpper()]);
      const currentWidth = upper - lower;
      const targetWidth = 2 * ctx.cfg.BASE_HALF_WIDTH_MULT * ctx.tickSpacing + ctx.tickSpacing;
      const delta = Math.abs(targetWidth - currentWidth);
      if (delta > caps.maxWidth) {
        log(
          `  ⚠ DEADLOCK: band width ${currentWidth} -> ${targetWidth} is a change of ${delta}, ` +
            `over the proxy's maxWidth ${caps.maxWidth}. Every rebalance will be skipped.`,
        );
        log(
          `    Fix: set BASE_HALF_WIDTH_MULT to ~${Math.round((currentWidth - ctx.tickSpacing) / (2 * ctx.tickSpacing))}, ` +
            `or have governance raise maxWidth to >= ${delta} (RebalanceProxy.setCustomDiffWidth).`,
        );
      }
    }
  } else if (ctx.owner.toLowerCase() !== signer) {
    log('  ⚠ signer is NOT the vault owner — rebalance() is onlyOwner and will revert.');
    log('    Set PRIVATE_KEY to the owner key, or transferOwnership() to the signer.');
  }
}

main().catch((e) => {
  log(`fatal: ${e?.stack ?? e?.message ?? e}`);
  process.exit(1);
});
