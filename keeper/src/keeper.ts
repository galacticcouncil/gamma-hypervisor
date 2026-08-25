import { ethers } from 'ethers';
import type { Ctx, ProxyCaps } from './chain';
import { readLastRebalanceTs, readProxyCaps } from './chain';
import { shouldRebalance } from './decide';
import { centeredBand, clampBandTranslation, limitRange } from './ticks';
import { oldestObservationAgeSecs, readSlot0, readTwapTick } from './pool';
import { readIdleBalances, readPositions, readTotalAmounts, surplusSide } from './vault';
import { computeCompoundMins, computeMins, splitForBand } from './mins';
import { readOracleTick } from './oracle';
import { sqrtPriceFromTick } from './price';
import { preflight, type RebalanceArgs } from './preflight';
import { submitRebalance } from './submit';
import { compoundOnce } from './compound';
import { fetchVolBaseline } from './indexer';
import { isReservePaused } from './moneyMarket';
import { PriceHistory } from './priceHistory';
import { bandMultForRegime, nextRegime, type Regime, type RegimeState } from './regime';
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

interface PriceGate {
  ok: boolean;
  reason: string;
  /** Where a rebalance would centre the band. Undefined when TWAP is disabled. */
  twapTick?: number;
  /** Feed price, for the regime machine's "moved X% in Y minutes" checks. */
  oraclePrice?: number;
  /** False only when the oracle could not be READ — drives regime escalation. */
  feedHealthy: boolean;
}

/**
 * Everything that must be true about the price before we touch the pool, in one
 * place, because both the rebalance and the compound sweep now depend on it.
 *
 * Compound used to fire above these checks on a bare timer. It re-mints the
 * vault's entire idle balance at spot, which is step 2 of the Arrakis sandwich
 * performed voluntarily on a public schedule — so it shares the same gates now,
 * and carries execution-time bounds on top (see computeCompoundMins, since
 * these gates only bind at decision time, one block before the tx lands).
 *
 * Every failure path is fail-closed. An unreadable oracle returns ok:false AND
 * feedHealthy:false so the caller can still escalate the regime on it.
 */
async function checkPrice(ctx: Ctx, spotTick: number, now: number): Promise<PriceGate> {
  const { cfg, pool } = ctx;
  let twapTick: number | undefined;

  if (cfg.TWAP_ENABLED) {
    try {
      const oldestAge = await oldestObservationAgeSecs(pool, now);
      const window = Math.min(cfg.TWAP_WINDOW_SECS, oldestAge);
      if (window < cfg.MIN_TWAP_WINDOW_SECS) {
        return { ok: false, feedHealthy: true,
          reason: `pool history ${oldestAge}s < MIN_TWAP_WINDOW_SECS ${cfg.MIN_TWAP_WINDOW_SECS}s — grow cardinality / wait` };
      }
      twapTick = await readTwapTick(pool, window);
      const dev = Math.abs(spotTick - twapTick);
      if (dev > cfg.MAX_DEV_TICKS) {
        return { ok: false, feedHealthy: true, twapTick,
          reason: `spot ${spotTick} vs TWAP(${window}s) ${twapTick} dev ${dev} > ${cfg.MAX_DEV_TICKS}` };
      }
      log(`  twap ok: spot ${spotTick} vs TWAP(${window}s) ${twapTick} (dev ${dev})`);
    } catch (e: any) {
      return { ok: false, feedHealthy: true,
        reason: `TWAP unavailable (${e?.reason ?? e?.message ?? e}) — fail-closed` };
    }
  } else if (!cfg.DRY_RUN && !cfg.ALLOW_UNSAFE_SPOT) {
    // loadConfig() already rejects this combination; belt and suspenders.
    return { ok: false, feedHealthy: true, reason: 'TWAP disabled without ALLOW_UNSAFE_SPOT' };
  }

  // External-truth clamp: the pool (spot AND its TWAP) can be walked over time,
  // but the exchanges these feeds aggregate cannot.
  if (ctx.oracle) {
    try {
      const o = await readOracleTick({
        feed0: ctx.oracle.feed0,
        feed1: ctx.oracle.feed1,
        feed0Side: cfg.ORACLE_FEED0_SIDE,
        decimals0: ctx.decimals0,
        decimals1: ctx.decimals1,
        nowTs: now,
      });
      if (o.ageSecs > cfg.ORACLE_MAX_AGE_SECS) {
        return { ok: false, feedHealthy: true, twapTick, oraclePrice: o.price,
          reason: `oracle stale (${o.ageSecs}s > ${cfg.ORACLE_MAX_AGE_SECS}s)` };
      }
      const ref = twapTick ?? spotTick;
      const dev = Math.abs(ref - o.tick);
      if (dev > cfg.ORACLE_MAX_DEV_TICKS) {
        return { ok: false, feedHealthy: true, twapTick, oraclePrice: o.price,
          reason: `pool ${ref} vs oracle ${o.tick} dev ${dev} > ${cfg.ORACLE_MAX_DEV_TICKS}` };
      }
      log(`  oracle ok: pool ${ref} vs oracle ${o.tick} (dev ${dev}, age ${o.ageSecs}s)`);
      return { ok: true, reason: 'ok', twapTick, oraclePrice: o.price, feedHealthy: true };
    } catch (e: any) {
      return { ok: false, feedHealthy: false, twapTick,
        reason: `oracle unreadable (${e?.reason ?? e?.message ?? e}) — fail-closed` };
    }
  }

  return { ok: true, reason: 'ok', twapTick, feedHealthy: true };
}

/**
 * Whether a due sweep may actually run.
 *
 * Kept pure and separate because it is the policy the Arrakis teardown produced:
 * `compound()` hands the pool a jump in depth, which is the one thing an
 * atomic sandwich needs, so it may only fire when the price agrees with its own
 * hourly average AND with the external feed AND the market is calm. Previously
 * it fired on a bare timer above all three.
 */
export function compoundAllowed(
  gate: { ok: boolean; reason: string },
  regime: Regime,
): { run: boolean; reason: string } {
  if (!gate.ok) return { run: false, reason: gate.reason };
  if (regime !== 'calm') {
    return { run: false, reason: `regime ${regime.toUpperCase()} — not sweeping into a disturbed pool` };
  }
  return { run: true, reason: 'ok' };
}

/**
 * Sweep the vault's idle balance into the existing ranges, with floors on what
 * the mint must consume. Never throws; returns whether a tx landed.
 */
async function runCompound(
  ctx: Ctx,
  sqrtPriceX96: ethers.BigNumber,
  base: [number, number],
): Promise<boolean> {
  const { cfg, vault, signer } = ctx;
  const [limitLower, limitUpper, [idle0, idle1]] = await Promise.all([
    vault.limitLower(),
    vault.limitUpper(),
    readIdleBalances(ctx.token0, ctx.token1, vault.address),
  ]);

  if (idle0.isZero() && idle1.isZero()) {
    log('  compound: nothing idle to sweep');
    return false;
  }

  const inMin = computeCompoundMins({
    idle0,
    idle1,
    sqrtPriceX96,
    base,
    limit: [limitLower, limitUpper],
    toleranceBps: cfg.MINS_TOLERANCE_BPS,
  });
  log(
    `  compound: sweeping idle ${idle0.toString()}/${idle1.toString()} ` +
      `into base=[${base[0]},${base[1]}] limit=[${limitLower},${limitUpper}] ` +
      `(inMin ${inMin.map((b) => b.toString()).join('/')}, tol ${cfg.MINS_TOLERANCE_BPS}bps)`,
  );

  return compoundOnce({
    signer,
    admin: cfg.ADMIN_ADDRESS!,
    vault: vault.address,
    inMin,
    gasLimit: cfg.GAS_LIMIT,
    confirmations: cfg.CONFIRMATIONS,
  });
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

  const block = await provider.getBlock(blockNumber);
  const now = block?.timestamp ?? Math.trunc(Date.now() / 1000);

  const compoundDue =
    cfg.COMPOUND_ENABLED &&
    !!cfg.ADMIN_ADDRESS &&
    now - state.lastCompoundTs >= cfg.COMPOUND_INTERVAL_SECS;

  log(
    `#${blockNumber} tick=${spotTick} base=[${baseLower},${baseUpper}] ` +
      `${decision.trigger ? 'TRIGGER' : 'hold'}${compoundDue ? ' +compound-due' : ''} — ${decision.reason}`,
  );

  if (!decision.trigger) state.dwell = 0;

  // Dwell: a single-block spike (flash-ish manipulation) cannot fire a rebalance;
  // the condition must hold across DWELL_BLOCKS consecutive evaluated blocks,
  // which costs an attacker real capital held against arbitrage. The counter
  // resets only when the trigger clears — a gate blocking downstream leaves it
  // armed, since the trigger genuinely did persist. Placement is off the TWAP
  // regardless, so an armed counter cannot by itself move the band.
  //
  // Dwell gates the REBALANCE only. A sweep that is due still runs the gates
  // below, because its own risk has nothing to do with whether the band moved.
  let rebalanceArmed = decision.trigger;
  if (decision.trigger) {
    state.dwell += 1;
    if (state.dwell < cfg.DWELL_BLOCKS) {
      log(`  arming: trigger ${state.dwell}/${cfg.DWELL_BLOCKS} consecutive blocks`);
      rebalanceArmed = false;
    }
  }

  // Cooldown — mirror the on-chain proxy interval (when present) to avoid
  // predictable reverts, and enforce our own floor either way. Checked before
  // the price gates so a cooled-down keeper does not pay for their RPC calls.
  let caps: ProxyCaps | undefined;
  if (rebalanceArmed) {
    caps = ctx.proxy ? await readProxyCaps(ctx.proxy, vault.address) : undefined;
    const minInterval = Math.max(cfg.MIN_INTERVAL_SECS, caps?.minIntervalSecs ?? 0);
    const lastTs = Math.max(state.lastRebalanceTs, caps?.lastRebalanceTs ?? 0);
    if (lastTs > 0 && now - lastTs < minInterval) {
      log(`  skip: min interval (${now - lastTs}s < ${minInterval}s)`);
      rebalanceArmed = false;
    }
  }

  if (!rebalanceArmed && !compoundDue) return;

  // --- price gates, shared by both actions -------------------------------
  const gate = await checkPrice(ctx, spotTick, now);

  // --- volatility regime -------------------------------------------------
  // v3 cannot raise its fee when the market turns, so the vault quotes wider or
  // stops quoting. Evaluated after the gates so it can see feed health.
  let bandMult = cfg.BASE_HALF_WIDTH_MULT;
  let regime: Regime = 'calm';
  if (cfg.REGIME_ENABLED) {
    const d = await evaluateRegime(ctx, state, now, gate.feedHealthy, gate.oraclePrice);
    regime = d.regime;
    bandMult = bandMultForRegime(regime, cfg.BASE_HALF_WIDTH_MULT, cfg.ELEVATED_HALF_WIDTH_MULT);
    if (regime === 'elevated') {
      log(`  regime elevated — widening band to mult ${bandMult} (from ${cfg.BASE_HALF_WIDTH_MULT})`);
    }
  } else if (!gate.feedHealthy) {
    log('  oracle unreadable and REGIME_ENABLED=false — refusing both actions');
    return;
  }

  // --- compound: same gates, plus execution-time bounds ------------------
  if (compoundDue) {
    const allowed = compoundAllowed(gate, regime);
    if (!allowed.run) {
      log(`  compound skipped: ${allowed.reason}`);
    } else {
      // Stamped whether or not the tx lands, so a persistently reverting sweep
      // backs off to the interval instead of retrying every block.
      state.lastCompoundTs = now;
      await runCompound(ctx, sqrtPriceX96, [baseLower, baseUpper]);
    }
  }

  if (!rebalanceArmed) return;

  if (regime === 'extreme') {
    log(`  skip: regime EXTREME`);
    log(
      '  OPERATOR ACTION: the keeper cannot pull liquidity — Admin.pullLiquidity is\n' +
        '    onlyRebalancer and the RebalanceProxy holds that role. To pull, the Admin\n' +
        '    holder (governance) must: 1) Admin.setRebalancer(vault, <signer>)\n' +
        '    2) Admin.pullLiquidity(vault, ...) 3) Admin.setRebalancer(vault, <proxy>)',
    );
    return;
  }
  if (!gate.ok) {
    log(`  skip: ${gate.reason}`);
    return;
  }

  // Spot may only TRIGGER; the band is centered on the TWAP tick, so pushing
  // spot cannot drag the band beyond the deviation cap.
  const placementTick = gate.twapTick ?? spotTick;

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
