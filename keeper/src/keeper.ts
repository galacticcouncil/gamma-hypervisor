import { ethers } from 'ethers';
import type { Ctx, ProxyCaps } from './chain';
import { readLastRebalanceTs, readProxyCaps } from './chain';
import { shouldRebalance } from './decide';
import { centeredBand, clampBandTranslation, limitRange } from './ticks';
import { oldestObservationAgeSecs, readSlot0, readTwapTick } from './pool';
import { readPositions, readTotalAmounts, surplusSide } from './vault';
import { computeMins, splitForBand } from './mins';
import { readOracleTick } from './oracle';
import { sqrtPriceFromTick } from './price';
import { preflight, type RebalanceArgs } from './preflight';
import { submitRebalance } from './submit';
import { log } from './log';

export interface KeeperState {
  lastRebalanceTs: number;
  /** Consecutive triggering evaluations — a spike must persist across real blocks. */
  dwell: number;
}

export async function initialState(ctx: Ctx): Promise<KeeperState> {
  const lastRebalanceTs = await readLastRebalanceTs(ctx);
  if (lastRebalanceTs > 0) log(`recovered last rebalance timestamp from chain: ${lastRebalanceTs}`);
  return { lastRebalanceTs, dwell: 0 };
}

export async function startKeeper(ctx: Ctx): Promise<void> {
  const state = await initialState(ctx);
  let busy = false;

  ctx.provider.on('block', async (blockNumber: number) => {
    if (busy) return; // never pipeline two rebalances; one confirms before the next block is evaluated
    busy = true;
    try {
      await evaluate(ctx, blockNumber, state);
    } catch (e: any) {
      log(`#${blockNumber} error: ${e?.message ?? e}`);
    } finally {
      busy = false;
    }
  });

  log('keeper started — watching blocks');
}

export async function evaluate(ctx: Ctx, blockNumber: number, state: KeeperState): Promise<void> {
  const { cfg, vault, pool, provider, signer } = ctx;

  const { sqrtPriceX96, tick: spotTick } = await readSlot0(pool);
  const [baseLower, baseUpper] = await Promise.all([vault.baseLower(), vault.baseUpper()]);

  // Trigger on spot: has price actually left the band / drifted from its center?
  // WHERE the band goes is decided later, from the TWAP, once the gates have run.
  const decision = shouldRebalance({
    spotTick,
    baseLower,
    baseUpper,
    tickSpacing: ctx.tickSpacing,
    rebalanceThresholdMult: cfg.REBALANCE_THRESHOLD_MULT,
  });

  log(`#${blockNumber} tick=${spotTick} base=[${baseLower},${baseUpper}] ${decision.trigger ? 'TRIGGER' : 'hold'} — ${decision.reason}`);
  if (!decision.trigger) {
    state.dwell = 0;
    return;
  }

  // Dwell: a single-block spike (flash-ish manipulation) cannot fire a rebalance;
  // the condition must hold across DWELL_BLOCKS consecutive evaluated blocks,
  // which costs an attacker real capital held against arbitrage. The counter
  // resets only when the trigger clears — a gate blocking downstream (short TWAP
  // history, stale oracle) leaves it armed, since the trigger genuinely did
  // persist. Placement is off the TWAP regardless, so an armed counter cannot by
  // itself move the band to a manipulated price.
  state.dwell += 1;
  if (state.dwell < cfg.DWELL_BLOCKS) {
    log(`  arming: trigger ${state.dwell}/${cfg.DWELL_BLOCKS} consecutive blocks`);
    return;
  }

  const block = await provider.getBlock(blockNumber);
  const now = block?.timestamp ?? Math.trunc(Date.now() / 1000);

  // Cooldown — mirror the on-chain proxy interval (when present) to avoid
  // predictable reverts, and enforce our own floor either way.
  const caps: ProxyCaps | undefined = ctx.proxy
    ? await readProxyCaps(ctx.proxy, vault.address)
    : undefined;
  const minInterval = Math.max(cfg.MIN_INTERVAL_SECS, caps?.minIntervalSecs ?? 0);
  const lastTs = Math.max(state.lastRebalanceTs, caps?.lastRebalanceTs ?? 0);
  if (lastTs > 0 && now - lastTs < minInterval) {
    log(`  skip: min interval (${now - lastTs}s < ${minInterval}s)`);
    return;
  }

  // TWAP gate + placement price. Spot may only TRIGGER; the band is centered on
  // the TWAP tick, so pushing spot cannot drag the band beyond the deviation cap.
  let placementTick = spotTick;
  let twapTick: number | undefined;
  if (cfg.TWAP_ENABLED) {
    try {
      const oldestAge = await oldestObservationAgeSecs(pool, now);
      const window = Math.min(cfg.TWAP_WINDOW_SECS, oldestAge);
      if (window < cfg.MIN_TWAP_WINDOW_SECS) {
        log(`  skip: pool history ${oldestAge}s < MIN_TWAP_WINDOW_SECS ${cfg.MIN_TWAP_WINDOW_SECS}s — grow cardinality / wait`);
        return;
      }
      twapTick = await readTwapTick(pool, window);
      const dev = Math.abs(spotTick - twapTick);
      if (dev > cfg.MAX_DEV_TICKS) {
        log(`  skip: spot ${spotTick} vs TWAP(${window}s) ${twapTick} dev ${dev} > ${cfg.MAX_DEV_TICKS}`);
        return;
      }
      log(`  twap ok: spot ${spotTick} vs TWAP(${window}s) ${twapTick} (dev ${dev})`);
      placementTick = twapTick;
    } catch (e: any) {
      log(`  skip: TWAP unavailable (${e?.reason ?? e?.message ?? e}) — fail-closed`);
      return;
    }
  } else if (!cfg.DRY_RUN && !cfg.ALLOW_UNSAFE_SPOT) {
    // loadConfig() already rejects this combination; belt and suspenders.
    log('  skip: TWAP disabled without ALLOW_UNSAFE_SPOT');
    return;
  }

  // External-truth clamp: the pool (spot AND its TWAP) can be walked over time,
  // but Binance-fed DIA cannot. Fail closed on any oracle problem.
  if (ctx.oracle) {
    try {
      const o = await readOracleTick({
        feed0: ctx.oracle.feed0,
        feed1: ctx.oracle.feed1,
        decimals0: ctx.decimals0,
        decimals1: ctx.decimals1,
        nowTs: now,
      });
      if (o.ageSecs > cfg.ORACLE_MAX_AGE_SECS) {
        log(`  skip: oracle stale (${o.ageSecs}s > ${cfg.ORACLE_MAX_AGE_SECS}s)`);
        return;
      }
      const ref = twapTick ?? spotTick;
      const dev = Math.abs(ref - o.tick);
      if (dev > cfg.ORACLE_MAX_DEV_TICKS) {
        log(`  skip: pool ${ref} vs oracle ${o.tick} dev ${dev} > ${cfg.ORACLE_MAX_DEV_TICKS}`);
        return;
      }
      log(`  oracle ok: pool ${ref} vs oracle ${o.tick} (dev ${dev}, age ${o.ageSecs}s)`);
    } catch (e: any) {
      log(`  skip: oracle unreadable (${e?.reason ?? e?.message ?? e}) — fail-closed`);
      return;
    }
  }

  const gasBal = await provider.getBalance(signer.address);
  if (gasBal.lt(cfg.gasFloorWei)) {
    log(`  skip: gas (WETH) balance ${ethers.utils.formatEther(gasBal)} below floor`);
    return;
  }

  // New base band, centered on the placement tick; in proxy mode, walk toward it
  // within the on-chain translation cap and respect the width cap.
  let newBase = centeredBand(placementTick, cfg.BASE_HALF_WIDTH_MULT, ctx.tickSpacing);
  if (caps && !caps.exempted) {
    try {
      const c = clampBandTranslation(newBase, [baseLower, baseUpper], caps.maxTranslation, cfg.BASE_HALF_WIDTH_MULT, ctx.tickSpacing);
      if (c.clamped) log(`  clamp: walking band toward target within maxTranslation ${caps.maxTranslation}`);
      newBase = c.band;
    } catch (e: any) {
      log(`  skip: ${e?.message ?? e}`);
      return;
    }
    const widthDelta = Math.abs((newBase[1] - newBase[0]) - (baseUpper - baseLower));
    if (widthDelta > caps.maxWidth) {
      log(`  skip: width delta ${widthDelta} exceeds proxy maxWidth ${caps.maxWidth} — align BASE_HALF_WIDTH_MULT with governance caps`);
      return;
    }
  }

  // Predict what the new base range consumes; the leftover is what the one-sided
  // limit range parks, so the same split drives both the side choice and the
  // mint bounds. Side is valued at the placement price (economics); the limit
  // geometry is off spot so the range is strictly one-sided at execution.
  const [total0, total1] = await readTotalAmounts(vault);
  const positions = await readPositions(vault);
  const split = splitForBand(total0, total1, sqrtPriceX96, newBase);
  const placementPrice = Math.pow(sqrtPriceFromTick(placementTick), 2);
  const side = surplusSide(split, placementPrice);
  const [limitLower, limitUpper] = limitRange(spotTick, ctx.tickSpacing, side, cfg.LIMIT_WIDTH_MULT);

  const { inMin, outMin } = computeMins({
    split,
    base: positions.base,
    limit: positions.limit,
    side,
    toleranceBps: cfg.MINS_TOLERANCE_BPS,
  });

  const args: RebalanceArgs = {
    baseLower: newBase[0],
    baseUpper: newBase[1],
    limitLower,
    limitUpper,
    feeRecipient: ctx.feeRecipient,
    inMin,
    outMin,
  };

  log(`  plan: base=[${args.baseLower},${args.baseUpper}] limit=[${limitLower},${limitUpper}] surplus=${side} tol=${cfg.MINS_TOLERANCE_BPS}bps`);

  if (cfg.DRY_RUN) {
    log('  DRY_RUN: not sending');
    return;
  }

  const pf = await preflight(ctx, args);
  if (!pf.ok) {
    log(`  skip: preflight revert — ${pf.error}`);
    return;
  }

  log(`  submitting rebalance via ${ctx.proxy ? 'RebalanceProxy' : 'Hypervisor (direct)'}…`);
  const hash = await submitRebalance(ctx, args);
  log(`  ✓ rebalanced — ${hash}`);
  state.lastRebalanceTs = now;
  state.dwell = 0;
}
