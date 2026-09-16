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
  log(
    `  base skew    ${
      cfg.BASE_SKEW_ENABLED
        ? `ON — band rotated by inventory (min leg ${cfg.BASE_SKEW_MIN_LEG_MULT}×spacing, max ratio ${cfg.BASE_SKEW_MAX_RATIO}:1, total width unchanged)`
        : 'off — symmetric base, the whole surplus goes to the one-sided limit'
    }`,
  );
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
  // A leg floor at or above the half-width leaves both legs on the floor, so the
  // band can never rotate and the feature is silently a no-op. Say so.
  if (cfg.BASE_SKEW_ENABLED && cfg.BASE_SKEW_MIN_LEG_MULT >= cfg.BASE_HALF_WIDTH_MULT) {
    log(
      `  ⚠ BASE_SKEW_ENABLED but BASE_SKEW_MIN_LEG_MULT=${cfg.BASE_SKEW_MIN_LEG_MULT} is not under\n` +
        `    BASE_HALF_WIDTH_MULT=${cfg.BASE_HALF_WIDTH_MULT}: both legs sit on the floor, so every band\n` +
        '    comes out symmetric. Lower the floor or widen the base.',
    );
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

    // A configured band width the proxy's maxWidth cannot accept in one step.
    // This used to be a hard deadlock — the keeper skipped every block forever —
    // and clampBandWidth now walks the width there instead, so the common case
    // is SLOW, not stuck. The one remaining deadlock is a cap under a single
    // tickSpacing, where no step exists at all. Both are caught here rather than
    // in a log line that scrolls past once a block.
    if (!caps.exempted) {
      const [lower, upper] = await Promise.all([ctx.vault.baseLower(), ctx.vault.baseUpper()]);
      const currentWidth = upper - lower;
      const targetWidth = 2 * ctx.cfg.BASE_HALF_WIDTH_MULT * ctx.tickSpacing + ctx.tickSpacing;
      const delta = Math.abs(targetWidth - currentWidth);
      const step = Math.floor(caps.maxWidth / ctx.tickSpacing) * ctx.tickSpacing;
      if (step < ctx.tickSpacing) {
        log(
          `  ⚠ DEADLOCK: the proxy's maxWidth ${caps.maxWidth} is under one tickSpacing ` +
            `${ctx.tickSpacing}, so the band width can never change. Every width-changing ` +
            'rebalance will be skipped.',
        );
        log(
          `    Fix: have governance raise maxWidth to >= ${ctx.tickSpacing} ` +
            '(RebalanceProxy.setCustomDiffWidth).',
        );
      } else if (delta > caps.maxWidth) {
        const rebalances = Math.ceil(delta / step);
        log(
          `  ⚠ band width ${currentWidth} -> ${targetWidth} is a change of ${delta}, over the ` +
            `proxy's maxWidth ${caps.maxWidth}. The keeper will WALK it in ${step}-tick steps: ` +
            `~${rebalances} rebalances (≥ ${rebalances * caps.minIntervalSecs}s) before the band ` +
            'reaches its configured width.',
        );
        log(
          `    To land it in one step instead: set BASE_HALF_WIDTH_MULT to ~${Math.round((currentWidth - ctx.tickSpacing) / (2 * ctx.tickSpacing))}, ` +
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
