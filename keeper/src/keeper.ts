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
import { compoundOnce } from './compound';
import { fetchVolBaseline } from './indexer';
import { isReservePaused } from './moneyMarket';
import { PriceHistory } from './priceHistory';
import { bandMultForRegime, nextRegime, type RegimeState } from './regime';
import { log } from './log';

export interface KeeperState {
  lastRebalanceTs: number;
  /** Consecutive triggering evaluations — a spike must persist across real blocks. */
  dwell: number;
  /** Volatility regime, and when it was entered. */
  regime: RegimeState;
  /** Feed price trail, for the "moved X% in Y minutes" checks. */
  prices: PriceHistory;
  /** Cached 30-day vol median: the one input that needs the indexer. */
  volBaseline?: { median: number; fetchedAt: number };
  lastCompoundTs: number;
}

export async function initialState(ctx: Ctx): Promise<KeeperState> {
  const lastRebalanceTs = await readLastRebalanceTs(ctx);
  if (lastRebalanceTs > 0) log(`recovered last rebalance timestamp from chain: ${lastRebalanceTs}`);
  return {
    lastRebalanceTs,
    dwell: 0,
    // Start calm rather than extreme: the first evaluation re-derives it from
    // live inputs anyway, and booting into `extreme` would impose the full
    // re-entry wait on every restart.
    regime: { regime: 'calm', since: 0 },
    prices: new PriceHistory(2 * 60 * 60),
    lastCompoundTs: 0,
  };
}

/**
 * Work out the volatility regime for this evaluation.
 *
 * Three inputs, deliberately unequal in how they fail:
 *  - reserve pause: unreadable counts as paused (fail closed)
 *  - feed health: already fail-closed upstream, passed in here
 *  - vol ratio: needs the indexer, so it is OPTIONAL — an indexer outage drops
 *    this one trigger and the feed-move triggers carry on
 */
async function evaluateRegime(
  ctx: Ctx,
  state: KeeperState,
  now: number,
  feedHealthy: boolean,
  feedPrice?: number,
) {
  const { cfg } = ctx;
  if (feedPrice !== undefined) state.prices.push(now, feedPrice);

  const reservePaused =
    cfg.MM_DATA_PROVIDER && cfg.MM_UNDERLYING
      ? await isReservePaused({
          provider: ctx.provider,
          dataProvider: cfg.MM_DATA_PROVIDER,
          underlying: cfg.MM_UNDERLYING,
        })
      : false;

  // Refresh the 30-day median at most hourly — it is a slow-moving number and
  // the indexer should not be polled every block.
  const stale =
    !state.volBaseline || now - state.volBaseline.fetchedAt >= cfg.VOL_BASELINE_REFRESH_SECS;
  let volRatio: number | undefined;
  if (cfg.INDEXER_URL && stale) {
    const baseline = await fetchVolBaseline({
      baseUrl: cfg.INDEXER_URL,
      baseId: cfg.INDEXER_BASE_ASSET,
      quoteId: cfg.INDEXER_QUOTE_ASSET,
      days: cfg.VOL_BASELINE_DAYS,
      timeoutMs: cfg.INDEXER_TIMEOUT_MS,
      nowTs: now,
    });
    if (baseline) {
      state.volBaseline = { median: baseline.median, fetchedAt: now };
      volRatio = baseline.current / baseline.median;
      log(
        `  vol: 1h ${(baseline.current * 100).toFixed(3)}% vs 30d median ` +
          `${(baseline.median * 100).toFixed(3)}% (${volRatio.toFixed(2)}x, n=${baseline.samples})`,
      );
    }
    // No else: fetchVolBaseline already logged, and a miss is not fatal.
  }

  const decision = nextRegime(
    {
      volRatio,
      move15m: state.prices.moveOver(15 * 60, now),
      move1h: state.prices.moveOver(60 * 60, now),
      feedHealthy,
      reservePaused,
    },
    {
      volRatioElevated: cfg.VOL_RATIO_ELEVATED,
      move15mElevated: cfg.MOVE_15M_ELEVATED,
      move1hExtreme: cfg.MOVE_1H_EXTREME,
      reentrySecs: cfg.REGIME_REENTRY_SECS,
    },
    state.regime,
    now,
  );
  state.regime = decision.state;

  // Regime transitions dominate annual LVR — they are the record that explains
  // the P&L, so they are logged loudly whether or not anything else happens.
  if (decision.changed) {
    log(`  *** REGIME -> ${decision.regime.toUpperCase()}: ${decision.reason} ***`);
  }
  return decision;
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

  // Compounding is independent of the rebalance decision — it does not move the
  // band, so it is not gated by the trigger, the dwell or the proxy interval.
  if (cfg.COMPOUND_ENABLED && cfg.ADMIN_ADDRESS) {
    const block = await provider.getBlock(blockNumber);
    const ts = block?.timestamp ?? Math.trunc(Date.now() / 1000);
    if (ts - state.lastCompoundTs >= cfg.COMPOUND_INTERVAL_SECS) {
      state.lastCompoundTs = ts;
      await compoundOnce({
        signer,
        admin: cfg.ADMIN_ADDRESS,
        vault: vault.address,
        gasLimit: cfg.GAS_LIMIT,
        confirmations: cfg.CONFIRMATIONS,
      });
    }
  }

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
  let feedHealthy = true;
  let oraclePrice: number | undefined;
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
      oraclePrice = o.price;
    } catch (e: any) {
      log(`  skip: oracle unreadable (${e?.reason ?? e?.message ?? e}) — fail-closed`);
      feedHealthy = false;
      // Fall through rather than returning: the regime machine needs to see an
      // unhealthy feed so it can escalate to `extreme`, and an operator needs
      // that logged. The rebalance is refused below regardless.
    }
  }

  // --- volatility regime -------------------------------------------------
  // v3 cannot raise its fee when the market turns, so the vault quotes wider or
  // stops quoting. Evaluated after the gates so it can see feed health.
  let bandMult = cfg.BASE_HALF_WIDTH_MULT;
  if (cfg.REGIME_ENABLED) {
    const decision = await evaluateRegime(ctx, state, now, feedHealthy, oraclePrice);
    if (decision.regime === 'extreme') {
      log(`  skip: regime EXTREME — ${decision.reason}`);
      log(
        '  OPERATOR ACTION: the keeper cannot pull liquidity — Admin.pullLiquidity is\n' +
          '    onlyRebalancer and the RebalanceProxy holds that role. To pull, the Admin\n' +
          '    holder (governance) must: 1) Admin.setRebalancer(vault, <signer>)\n' +
          '    2) Admin.pullLiquidity(vault, ...) 3) Admin.setRebalancer(vault, <proxy>)',
      );
      return;
    }
    bandMult = bandMultForRegime(decision.regime, cfg.BASE_HALF_WIDTH_MULT, cfg.ELEVATED_HALF_WIDTH_MULT);
    if (decision.regime === 'elevated') {
      log(`  regime elevated — widening band to mult ${bandMult} (from ${cfg.BASE_HALF_WIDTH_MULT})`);
    }
  } else if (!feedHealthy) {
    log('  skip: oracle unreadable and REGIME_ENABLED=false');
    return;
  }

  const gasBal = await provider.getBalance(signer.address);
  if (gasBal.lt(cfg.gasFloorWei)) {
    log(`  skip: gas (WETH) balance ${ethers.utils.formatEther(gasBal)} below floor`);
    return;
  }

  // New base band, centered on the placement tick; in proxy mode, walk toward it
  // within the on-chain translation cap and respect the width cap.
  let newBase = centeredBand(placementTick, bandMult, ctx.tickSpacing);
  if (caps && !caps.exempted) {
    try {
      const c = clampBandTranslation(newBase, [baseLower, baseUpper], caps.maxTranslation, bandMult, ctx.tickSpacing);
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
