import { loadKeeperConfig, vaultFlag } from './config';
import {
  createChain,
  createVaultContext,
  disambiguateTags,
  measureBlockTimeSecs,
  readProxyCaps,
  type Chain,
  type VaultCtx,
} from './chain';
import { oldestObservationAgeSecs, readSlot0, readTwapTick } from './pool';
import { readTotalAmounts, surplusSide } from './vault';
import { splitForBand } from './mins';
import { readOracleTick } from './oracle';
import { priceFromSqrtX96, sqrtPriceFromTick } from './price';
import { decide } from './decide';
import { limitRange } from './ticks';
import { log } from './log';

// Read-only preflight of the whole gate stack: what the keeper would see and
// which gate would stop it. Sends nothing. Covers every configured vault, or
// just the one named by `--vault <address>`.
async function main(): Promise<void> {
  const { global, vaults: cfgs } = loadKeeperConfig();
  const only = vaultFlag(process.argv);
  const chain = createChain(global);
  const blockTimeSecs = await measureBlockTimeSecs(chain.provider);

  const picked = only ? cfgs.filter((c) => c.VAULT.toLowerCase() === only.toLowerCase()) : cfgs;
  if (picked.length === 0) throw new Error(`no configured vault matches ${only}`);

  const ctxs: VaultCtx[] = [];
  for (const cfg of picked) ctxs.push(await createVaultContext(chain, cfg, blockTimeSecs));
  disambiguateTags(ctxs);

  for (const ctx of ctxs) await smokeVault(chain, ctx);
  process.exit(0);
}

async function smokeVault(chain: Chain, ctx: VaultCtx): Promise<void> {
  const { cfg } = ctx;
  const log = ctx.log;

  const { sqrtPriceX96, tick, observationCardinality } = await readSlot0(ctx.pool);
  const [baseLower, baseUpper] = await Promise.all([ctx.vault.baseLower(), ctx.vault.baseUpper()]);
  const [total0, total1] = await readTotalAmounts(ctx.vault);
  const nowTs = (await chain.provider.getBlock('latest')).timestamp;

  log(`pool   ${ctx.pool.address}  ${ctx.symbol0}/${ctx.symbol1}  spacing=${ctx.tickSpacing}  decimals=${ctx.decimals0}/${ctx.decimals1}`);
  log(`owner  ${ctx.owner}  signer=${chain.signer.address}  isOwner=${ctx.owner.toLowerCase() === chain.signer.address.toLowerCase()}`);
  log(`slot0  tick=${tick}  price=${priceFromSqrtX96(sqrtPriceX96)}  obsCardinality=${observationCardinality}`);
  log(`vault  base=[${baseLower},${baseUpper}]  totalAmounts=(${total0.toString()}, ${total1.toString()})`);

  if (ctx.proxy) {
    const [rebalancer, admin] = await Promise.all([
      ctx.proxy.rebalancers(ctx.vault.address),
      ctx.proxy.admins(ctx.vault.address),
    ]);
    const caps = await readProxyCaps(ctx.proxy, ctx.vault.address);
    log(`proxy  ${ctx.proxy.address}  rebalancer=${rebalancer} admin=${admin}`);
    log(`caps   maxTranslation=${caps.maxTranslation} maxWidth=${caps.maxWidth} minInterval=${caps.minIntervalSecs}s last=${caps.lastRebalanceTs} exempted=${caps.exempted}`);
  }

  let placementTick = tick;
  if (cfg.TWAP_ENABLED) {
    try {
      const oldest = await oldestObservationAgeSecs(ctx.pool, nowTs);
      const window = Math.min(cfg.TWAP_WINDOW_SECS, oldest);
      log(`twap   pool history ${oldest}s (window would be ${window}s, floor ${cfg.MIN_TWAP_WINDOW_SECS}s)`);
      if (window >= cfg.MIN_TWAP_WINDOW_SECS) {
        const twap = await readTwapTick(ctx.pool, window);
        placementTick = twap;
        log(`twap   tick=${twap}  dev from spot=${Math.abs(tick - twap)} (max ${cfg.MAX_DEV_TICKS})`);
      } else {
        log('twap   TOO SHORT — keeper would skip (grow observation cardinality, or wait for history)');
      }
    } catch (e: any) {
      log(`twap   UNAVAILABLE (${e?.reason ?? e?.message ?? e}) — keeper would skip`);
    }
  } else {
    log('twap   disabled');
  }

  if (ctx.oracle) {
    try {
      const o = await readOracleTick({
        feed0: ctx.oracle.feed0,
        feed1: ctx.oracle.feed1,
        feed0Side: cfg.ORACLE_FEED0_SIDE,
        decimals0: ctx.decimals0,
        decimals1: ctx.decimals1,
        nowTs,
      });
      log(`oracle tick=${o.tick}  age=${o.ageSecs}s (max ${cfg.ORACLE_MAX_AGE_SECS}s)  dev from pool=${Math.abs(placementTick - o.tick)} (max ${cfg.ORACLE_MAX_DEV_TICKS})`);
    } catch (e: any) {
      log(`oracle UNREADABLE (${e?.reason ?? e?.message ?? e}) — keeper would skip`);
    }
  } else {
    log('oracle disabled');
  }

  const d = decide({
    spotTick: tick,
    placementTick,
    baseLower,
    baseUpper,
    tickSpacing: ctx.tickSpacing,
    baseHalfWidthMult: cfg.BASE_HALF_WIDTH_MULT,
    rebalanceThresholdMult: cfg.REBALANCE_THRESHOLD_MULT,
  });
  const split = splitForBand(total0, total1, sqrtPriceX96, [d.newBaseLower, d.newBaseUpper]);
  const side = surplusSide(split, Math.pow(sqrtPriceFromTick(placementTick), 2));
  const [ll, lu] = limitRange(tick, ctx.tickSpacing, side, cfg.LIMIT_WIDTH_MULT);

  log(`decide ${d.trigger ? 'TRIGGER' : 'hold'} — ${d.reason}`);
  log(`plan   base=[${d.newBaseLower},${d.newBaseUpper}]  limit=[${ll},${lu}]  surplus=${side}`);
}

main().catch((e) => {
  log(`smoke failed: ${e?.stack ?? e?.message ?? e}`);
  process.exit(1);
});
