import { ethers } from 'ethers';
import type { Chain, ProxyCaps, VaultCtx } from './chain';
import { readLastRebalanceTs, readProxyCaps } from './chain';
import { shouldFold, shouldRebalance, shouldRefreshLimit, type Trigger } from './decide';
import { centeredBand, clampBandTranslation, limitRange } from './ticks';
import { oldestObservationAgeSecs, readSlot0, readTwapTick } from './pool';
import { readIdleBalances, readPositions, readTotalAmounts, surplusSide } from './vault';
import { computeCompoundMins, computeMins, splitForBand } from './mins';
import { readOracleTick } from './oracle';
import { priceFromSqrtX96, sqrtPriceFromTick, toFloat } from './price';
import { preflight, type RebalanceArgs } from './preflight';
import { txOverrides } from './chain';
import { submitRebalance } from './submit';
import { compoundOnce } from './compound';
import { vaultFees } from './feesOwed';
import { fetchVolBaseline } from './indexer';
import { isReservePaused } from './moneyMarket';
import { blankState, type KeeperState } from './state';
import { bandMultForRegime, nextRegime, type Regime } from './regime';
import { log } from './log';
import { status } from './status';

export type { KeeperState } from './state';

export async function initialState(ctx: VaultCtx): Promise<KeeperState> {
  const lastRebalanceTs = await readLastRebalanceTs(ctx);
  if (lastRebalanceTs > 0) ctx.log(`recovered last rebalance timestamp from chain: ${lastRebalanceTs}`);
  return { ...blankState(), lastRebalanceTs };
}

/**
 * The dwell gate for one vault, in wall-clock seconds.
 *
 * A single-block spike (flash-ish manipulation) must not fire a rebalance: the
 * condition has to hold CONTINUOUSLY for `ctx.dwellSecs`, which costs an
 * attacker real capital held against arbitrage for that whole time. The clock
 * resets only when the trigger clears — a gate blocking downstream leaves it
 * armed, since the trigger genuinely did persist.
 *
 * Seconds, not evaluated blocks: `evaluate` is skipped while another evaluation
 * is in flight, so a block count drifts with how long a cycle takes — and with
 * several vaults sharing the process, it drifts with how many pools there are.
 *
 * Exported because it is the whole gate, and because per-vault state isolation
 * is exactly what a test needs to pin down.
 */
export function stepDwell(
  ctx: Pick<VaultCtx, 'state' | 'dwellSecs' | 'log'>,
  field: 'dwellSince' | 'refreshDwellSince' | 'foldDwellSince',
  trigger: boolean,
  now: number,
  label: string,
): boolean {
  if (!trigger) {
    ctx.state[field] = 0;
    return false;
  }
  if (ctx.state[field] === 0) ctx.state[field] = now;
  const held = now - ctx.state[field];
  if (held >= ctx.dwellSecs) return true;
  ctx.log(`  arming ${label}: held ${held}s / ${ctx.dwellSecs}s`);
  return false;
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
  ctx: VaultCtx,
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
          provider: ctx.chain.provider,
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
      log: ctx.log,
    });
    if (baseline) {
      state.volBaseline = { median: baseline.median, fetchedAt: now };
      volRatio = baseline.current / baseline.median;
      ctx.log(
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
    ctx.log(`  *** REGIME -> ${decision.regime.toUpperCase()}: ${decision.reason} ***`);
  }
  return decision;
}

/**
 * One block subscription, N vaults, evaluated in order.
 *
 * `busy` is GLOBAL, not per vault: with one signer there is one nonce, and the
 * existing `tx.wait(CONFIRMATIONS)` inside a rebalance means the cycle already
 * serialises to one transaction in flight. That is the property we want, so no
 * concurrency and no nonce manager — a second vault simply waits its turn.
 *
 * The block is fetched ONCE: it is identical for every vault, and N round trips
 * for the same header would be pure latency.
 */
export async function startKeeper(chain: Chain, vaults: VaultCtx[]): Promise<void> {
  let busy = false;

  chain.provider.on('block', async (blockNumber: number) => {
    // the three status hooks are no-ops without a listener and never throw:
    // ethers dispatches this listener from a setTimeout with no catch, so a
    // throw here would be an unhandled rejection and a restart
    status.head(blockNumber, busy);
    if (busy) return; // never pipeline two rebalances; one confirms before the next block is evaluated
    busy = true;
    try {
      const block = await chain.provider.getBlock(blockNumber);
      status.cycleStart(blockNumber, block?.timestamp ?? null);
      for (const v of vaults) {
        // A runtime failure is per vault and non-fatal: one unhealthy pool must
        // not stop the others from being kept. (Config errors are the opposite
        // — they are fatal, at startup, in loadKeeperConfig.)
        try {
          await evaluate(v, blockNumber, block);
        } catch (e: any) {
          v.log(`#${blockNumber} error: ${e?.message ?? e}`);
        }
      }
    } catch (e: any) {
      log(`#${blockNumber} error: ${e?.message ?? e}`);
    } finally {
      busy = false;
      status.cycleEnd(blockNumber);
    }
  });

  log(`keeper started — watching blocks for ${vaults.length} vault${vaults.length === 1 ? '' : 's'}`);
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
async function checkPrice(ctx: VaultCtx, spotTick: number, now: number): Promise<PriceGate> {
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
      ctx.log(`  twap ok: spot ${spotTick} vs TWAP(${window}s) ${twapTick} (dev ${dev})`);
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
      ctx.log(`  oracle ok: pool ${ref} vs oracle ${o.tick} (dev ${dev}, age ${o.ageSecs}s)`);
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
  ctx: VaultCtx,
  sqrtPriceX96: ethers.BigNumber,
  base: [number, number],
): Promise<boolean> {
  const { cfg, vault } = ctx;
  const { signer } = ctx.chain;
  const [limitLower, limitUpper, [idle0, idle1], slot0] = await Promise.all([
    vault.limitLower(),
    vault.limitUpper(),
    readIdleBalances(ctx.token0, ctx.token1, vault.address),
    ctx.pool.slot0(),
  ]);

  // Gate on idle PLUS fees still owed inside the positions.
  //
  // Gating on the idle balance alone made the sweep unreachable in steady
  // state: fees accrue inside the Uniswap position and only become idle when
  // something burns or collects — and the only thing that does is this very
  // compound. Measured on mainnet: $25.19 of fees accrued while the keeper
  // logged `nothing idle to sweep` hourly for days.
  const [fees0, fees1] = await vaultFees(
    ctx.pool,
    vault.address,
    base,
    [Number(limitLower), Number(limitUpper)],
    Number(slot0.tick),
  );
  const sweep0 = idle0.add(fees0);
  const sweep1 = idle1.add(fees1);

  if (sweep0.isZero() && sweep1.isZero()) {
    ctx.log('  compound: nothing to sweep (no idle balance, no fees owed)');
    return false;
  }

  // Value the token0 leg in token1 so one threshold covers both sides.
  const sqrt = BigInt(sqrtPriceX96.toString());
  const value1 = BigInt(sweep1.toString()) + (BigInt(sweep0.toString()) * sqrt * sqrt) / (1n << 192n);
  if (value1 < BigInt(cfg.compoundMinFees1.toString())) {
    ctx.log(`  compound: ${value1} below COMPOUND_MIN_FEES1 ${cfg.compoundMinFees1.toString()}`);
    return false;
  }
  ctx.log(`  compound: sweeping idle ${idle0}/${idle1} + fees owed ${fees0}/${fees1}`);

  // Mins are derived from what the mint will actually consume — idle plus the
  // fees this call is about to collect — so they are never all-zero, which is
  // the only protection that binds at execution time.
  const inMin = computeCompoundMins({
    idle0: sweep0,
    idle1: sweep1,
    sqrtPriceX96,
    base,
    limit: [limitLower, limitUpper],
    toleranceBps: cfg.MINS_TOLERANCE_BPS,
  });
  ctx.log(
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
    gasPrice: (await txOverrides(ctx.chain)).gasPrice as ethers.BigNumber,
    confirmations: cfg.CONFIRMATIONS,
    log: ctx.log,
  });
}

/**
 * One vault, one block. The block is passed in rather than fetched: every vault
 * in a cycle sees the same header, and re-reading it per vault would be N round
 * trips for one answer.
 */
export async function evaluate(
  ctx: VaultCtx,
  blockNumber: number,
  block: ethers.providers.Block | null,
): Promise<void> {
  const { cfg, vault, pool, state } = ctx;
  const { provider, signer } = ctx.chain;

  const { sqrtPriceX96, tick: spotTick } = await readSlot0(pool);
  const [baseLower, baseUpper, limitLower0, limitUpper0, limitPos] = await Promise.all([
    vault.baseLower(),
    vault.baseUpper(),
    vault.limitLower(),
    vault.limitUpper(),
    vault.getLimitPosition(),
  ]);

  // Trigger on spot: has price actually left the band / drifted from its center?
  // WHERE the band goes is decided later, from the TWAP, once the gates have run.
  const decision = shouldRebalance({
    spotTick,
    baseLower,
    baseUpper,
    tickSpacing: ctx.tickSpacing,
    rebalanceThresholdMult: cfg.REBALANCE_THRESHOLD_MULT,
  });

  // Limit refresh: re-place a stranded limit next to the price, base unchanged.
  // Subordinate to the drift trigger — a full re-center re-places the limit
  // anyway, so refresh only fires when the band itself has no reason to move.
  // Requires an existing base: on a bootstrap vault there is nothing to keep.
  const refresh =
    cfg.LIMIT_REFRESH_ENABLED && baseUpper > baseLower && !decision.trigger
      ? shouldRefreshLimit({
          spotTick,
          limitLower: Number(limitLower0),
          limitUpper: Number(limitUpper0),
          limitLiquidity: BigInt(limitPos.liquidity.toString()),
          refreshTicks: cfg.LIMIT_REFRESH_TICKS,
        })
      : { trigger: false, reason: 'refresh disabled, no base, or drift trigger active' };

  // Fold at balance: a limit price has traded halfway through holds a
  // conversion the vault has been paid for but not banked — bank it with the
  // same zero-translation rebalance a refresh uses, before the second half
  // converts too and the position reflects. Subordinate to both triggers above
  // (a re-center or refresh re-places the limit anyway). NAV is read only when
  // the trigger might actually fire, so the common block costs no extra call.
  let fold: Trigger = { trigger: false, reason: 'fold disabled or superseded' };
  if (cfg.FOLD_ENABLED && baseUpper > baseLower && !decision.trigger && !refresh.trigger) {
    const spotPrice = priceFromSqrtX96(sqrtPriceX96);
    const shape = {
      limitValue0: toFloat(limitPos.amount0) * spotPrice,
      limitValue1: toFloat(limitPos.amount1),
      limitLiquidity: BigInt(limitPos.liquidity.toString()),
      foldMinShare: cfg.FOLD_MIN_SHARE,
      foldMinLimitShare: cfg.FOLD_MIN_LIMIT_SHARE,
    };
    // Composition test first, off the limit position already read above. This
    // block is evaluated on EVERY quiet block — enabled, base present, neither
    // other trigger armed, which is the steady state — so reading NAV here
    // unconditionally would buy one extra RPC call per block per vault, for a
    // floor that almost never changes the answer.
    fold = shouldFold(shape);
    if (fold.trigger && cfg.FOLD_MIN_LIMIT_SHARE > 0) {
      const [t0, t1] = await readTotalAmounts(vault);
      fold = shouldFold({ ...shape, navValue: toFloat(t0) * spotPrice + toFloat(t1) });
    }
  }

  const now = block?.timestamp ?? Math.trunc(Date.now() / 1000);

  const compoundDue =
    cfg.COMPOUND_ENABLED &&
    !!cfg.ADMIN_ADDRESS &&
    now - state.lastCompoundTs >= cfg.COMPOUND_INTERVAL_SECS;

  ctx.log(
    `#${blockNumber} tick=${spotTick} base=[${baseLower},${baseUpper}] ` +
      `${decision.trigger ? 'TRIGGER' : refresh.trigger ? 'REFRESH' : fold.trigger ? 'FOLD' : 'hold'}` +
      `${compoundDue ? ' +compound-due' : ''} — ${
        decision.trigger ? decision.reason : refresh.trigger ? refresh.reason : fold.trigger ? fold.reason : decision.reason
      }`,
  );

  // Dwell gates the REBALANCE and the refresh, never the compound: a sweep's
  // risk has nothing to do with whether the band moved. Placement is off the
  // TWAP regardless, so an armed counter cannot by itself move the band.  //
  // The refresh shares the discipline — a stranded limit is stranded for hours,
  // so waiting costs nothing and keeps a spot flick from buying a re-place.
  let rebalanceArmed = stepDwell(ctx, 'dwellSince', decision.trigger, now, 'trigger');
  let refreshArmed = stepDwell(ctx, 'refreshDwellSince', refresh.trigger, now, 'refresh');

  // And the fold: composition can only be moved by real trades through the
  // pool, but the dwell still makes a single-block push worthless.
  let foldArmed = stepDwell(ctx, 'foldDwellSince', fold.trigger, now, 'fold');

  // Cooldown — mirror the on-chain proxy interval (when present) to avoid
  // predictable reverts, and enforce our own floor either way. Checked before
  // the price gates so a cooled-down keeper does not pay for their RPC calls.
  let caps: ProxyCaps | undefined;
  if (rebalanceArmed || refreshArmed || foldArmed) {
    caps = ctx.proxy ? await readProxyCaps(ctx.proxy, vault.address) : undefined;
    const minInterval = Math.max(cfg.MIN_INTERVAL_SECS, caps?.minIntervalSecs ?? 0);
    const lastTs = Math.max(state.lastRebalanceTs, caps?.lastRebalanceTs ?? 0);
    if (lastTs > 0 && now - lastTs < minInterval) {
      ctx.log(`  skip: min interval (${now - lastTs}s < ${minInterval}s)`);
      rebalanceArmed = false;
      refreshArmed = false;
      foldArmed = false;
    }
  }

  if (!rebalanceArmed && !refreshArmed && !foldArmed && !compoundDue) return;

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
      ctx.log(`  regime elevated — widening band to mult ${bandMult} (from ${cfg.BASE_HALF_WIDTH_MULT})`);
    }
  } else if (!gate.feedHealthy) {
    ctx.log('  oracle unreadable and REGIME_ENABLED=false — refusing both actions');
    return;
  }

  // --- compound: same gates, plus execution-time bounds ------------------
  if (compoundDue) {
    const allowed = compoundAllowed(gate, regime);
    if (!allowed.run) {
      ctx.log(`  compound skipped: ${allowed.reason}`);
    } else {
      // Stamped whether or not the tx lands, so a persistently reverting sweep
      // backs off to the interval instead of retrying every block.
      state.lastCompoundTs = now;
      await runCompound(ctx, sqrtPriceX96, [baseLower, baseUpper]);
    }
  }

  if (!rebalanceArmed && !refreshArmed && !foldArmed) return;

  if (regime === 'extreme') {
    ctx.log(`  skip: regime EXTREME`);
    ctx.log(
      '  OPERATOR ACTION: the keeper cannot pull liquidity — Admin.pullLiquidity is\n' +
        '    onlyRebalancer and the RebalanceProxy holds that role. To pull, the Admin\n' +
        '    holder (governance) must: 1) Admin.setRebalancer(vault, <signer>)\n' +
        '    2) Admin.pullLiquidity(vault, ...) 3) Admin.setRebalancer(vault, <proxy>)',
    );
    return;
  }
  if (!gate.ok) {
    ctx.log(`  skip: ${gate.reason}`);
    return;
  }

  // Spot may only TRIGGER; the band is centered on the TWAP tick, so pushing
  // spot cannot drag the band beyond the deviation cap.
  const placementTick = gate.twapTick ?? spotTick;

  const gasBal = await provider.getBalance(signer.address);
  if (gasBal.lt(cfg.gasFloorWei)) {
    ctx.log(`  skip: gas (WETH) balance ${ethers.utils.formatEther(gasBal)} below floor`);
    return;
  }

  // New base band, centered on the placement tick; in proxy mode, walk toward it
  // within the on-chain translation cap and respect the width cap.
  //
  // A refresh — and a fold, which is the same action fired on the limit's
  // composition instead of its geometry — keeps the base EXACTLY as it is:
  // zero translation and zero width change satisfy the proxy caps by
  // construction. The fold's work happens in the re-mint itself: the base mint
  // is scarce-side constrained, so the now-pairable inventory lands in the base
  // and only the residual re-parks one-sided. (When several triggers arm on the
  // same block the re-center wins — it re-places the limit anyway.)
  let newBase: [number, number] = rebalanceArmed
    ? centeredBand(placementTick, bandMult, ctx.tickSpacing)
    : [Number(baseLower), Number(baseUpper)];
  if (rebalanceArmed && caps && !caps.exempted) {
    try {
      const c = clampBandTranslation(newBase, [baseLower, baseUpper], caps.maxTranslation, bandMult, ctx.tickSpacing);
      if (c.clamped) ctx.log(`  clamp: walking band toward target within maxTranslation ${caps.maxTranslation}`);
      newBase = c.band;
    } catch (e: any) {
      ctx.log(`  skip: ${e?.message ?? e}`);
      return;
    }
    const widthDelta = Math.abs((newBase[1] - newBase[0]) - (baseUpper - baseLower));
    if (widthDelta > caps.maxWidth) {
      ctx.log(`  skip: width delta ${widthDelta} exceeds proxy maxWidth ${caps.maxWidth} — align BASE_HALF_WIDTH_MULT with governance caps`);
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

  ctx.log(
    `  plan${rebalanceArmed ? '' : refreshArmed ? ' (limit refresh, base unchanged)' : ' (fold at balance, base unchanged)'}: ` +      `base=[${args.baseLower},${args.baseUpper}] limit=[${limitLower},${limitUpper}] surplus=${side} tol=${cfg.MINS_TOLERANCE_BPS}bps`,
  );

  if (cfg.DRY_RUN) {
    ctx.log('  DRY_RUN: not sending');
    return;
  }

  const pf = await preflight(ctx, args);
  if (!pf.ok) {
    ctx.log(`  skip: preflight revert — ${pf.error}`);
    return;
  }

  ctx.log(`  submitting rebalance via ${ctx.proxy ? 'RebalanceProxy' : 'Hypervisor (direct)'}…`);
  const hash = await submitRebalance(ctx, args);
  ctx.log(`  ✓ ${rebalanceArmed ? 'rebalanced' : refreshArmed ? 'limit refreshed' : 'folded at balance'} — ${hash}`);
  state.lastRebalanceTs = now;
  state.dwellSince = 0;
  state.refreshDwellSince = 0;
  state.foldDwellSince = 0;}
