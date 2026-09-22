import { ethers } from 'ethers';
import { AGGREGATOR_V3_ABI, ERC20_ABI, HYPERVISOR_ABI, POOL_ABI, REBALANCE_PROXY_ABI } from './abis';
import { resolveDwellSecs, type Config, type GlobalConfig } from './config';
import { blankState, type KeeperState } from './state';
import { log } from './log';

/**
 * The process-wide half: one RPC connection, one signer, one nonce.
 *
 * Deliberately NOT per vault. Sequential evaluation over a single signer is
 * what keeps transactions from racing each other's nonce; giving each vault its
 * own connection would only invite that race back.
 */
export interface Chain {
  cfg: GlobalConfig;
  provider: ethers.providers.JsonRpcProvider;
  signer: ethers.Wallet;
}

/** Everything scoped to ONE vault. N of these share a single `Chain`. */
export interface VaultCtx {
  chain: Chain;
  /** Global settings unioned with this vault's overrides, flat as before. */
  cfg: Config;
  vault: ethers.Contract;
  pool: ethers.Contract;
  token0: ethers.Contract;
  token1: ethers.Contract;
  proxy?: ethers.Contract; // ENTRYPOINT=proxy (Model B)
  oracle?: { feed0: ethers.Contract; feed1?: ethers.Contract }; // ORACLE_ENABLED
  tickSpacing: number;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
  owner: string;
  feeRecipient: string;
  /** Wall-clock dwell for this vault, resolved once at startup. */
  dwellSecs: number;
  state: KeeperState;
  /** Short human label, e.g. "aDOT/HOLLAR" — prefixes every log line. */
  tag: string;
  log: (msg: string) => void;
}

export function createChain(cfg: GlobalConfig): Chain {
  const provider = new ethers.providers.JsonRpcProvider(cfg.RPC_URL);
  provider.pollingInterval = cfg.POLL_INTERVAL_MS;
  const signer = new ethers.Wallet(cfg.PRIVATE_KEY, provider);
  return { cfg, provider, signer };
}

/**
 * Average seconds per block, from two recent blocks.
 *
 * Only used to translate the deprecated DWELL_BLOCKS into seconds, so a rough
 * figure is fine — but it must come from the chain: Hydration has already
 * changed its block time once (6s -> 2s), which silently cut every
 * block-counted dwell to a third of its intended length.
 */
export async function measureBlockTimeSecs(
  provider: ethers.providers.Provider,
  fallbackSecs = 2,
): Promise<number> {
  try {
    const head = await provider.getBlockNumber();
    const span = Math.min(100, head);
    if (span < 1) return fallbackSecs;
    const [a, b] = await Promise.all([provider.getBlock(head - span), provider.getBlock(head)]);
    const dt = (b.timestamp - a.timestamp) / span;
    return dt > 0 ? dt : fallbackSecs;
  } catch (e: any) {
    log(`warn: could not measure block time (${e?.message ?? e}) — assuming ${fallbackSecs}s`);
    return fallbackSecs;
  }
}

export async function createVaultContext(
  chain: Chain,
  cfg: Config,
  blockTimeSecs: number,
): Promise<VaultCtx> {
  const { provider, signer } = chain;

  const vault = new ethers.Contract(cfg.VAULT, HYPERVISOR_ABI, signer);
  const [poolAddr, token0, token1, tickSpacing, owner] = await Promise.all([
    vault.pool(),
    vault.token0(),
    vault.token1(),
    vault.tickSpacing(),
    vault.owner(),
  ]);

  const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const t0 = new ethers.Contract(token0, ERC20_ABI, provider);
  const t1 = new ethers.Contract(token1, ERC20_ABI, provider);

  let decimals0: number;
  let decimals1: number;
  if (cfg.ORACLE_ENABLED) {
    // The oracle clamp converts a human price to a raw pool tick via token
    // decimals — a silent 18-fallback would shift the expected tick by whole
    // orders of magnitude, so hard-fail instead.
    [decimals0, decimals1] = await Promise.all([t0.decimals(), t1.decimals()]);
  } else {
    [decimals0, decimals1] = await Promise.all([
      t0.decimals().catch(() => 18),
      t1.decimals().catch(() => 18),
    ]);
  }
  // Symbols are cosmetic (banner and log tag only) — keep best-effort.
  const [symbol0, symbol1] = await Promise.all([
    t0.symbol().catch(() => '?'),
    t1.symbol().catch(() => '?'),
  ]);

  const proxy =
    cfg.ENTRYPOINT === 'proxy'
      ? new ethers.Contract(cfg.REBALANCE_PROXY!, REBALANCE_PROXY_ABI, signer)
      : undefined;
  // One AggregatorV3 contract per pair, so the clamp needs one feed per token.
  // feed1 is optional: omit it when token1 is the USD-pegged side (HOLLAR), and
  // token0/USD is the pool price directly.
  const oracle = cfg.ORACLE_ENABLED
    ? {
        feed0: new ethers.Contract(cfg.ORACLE_FEED0!, AGGREGATOR_V3_ABI, provider),
        feed1: cfg.ORACLE_FEED1
          ? new ethers.Contract(cfg.ORACLE_FEED1, AGGREGATOR_V3_ABI, provider)
          : undefined,
      }
    : undefined;

  const ctx: VaultCtx = {
    chain,
    cfg,
    vault,
    pool,
    token0: t0,
    token1: t1,
    proxy,
    oracle,
    tickSpacing,
    decimals0,
    decimals1,
    symbol0,
    symbol1,
    owner,
    feeRecipient: cfg.FEE_RECIPIENT ?? signer.address,
    dwellSecs: resolveDwellSecs(cfg, blockTimeSecs).secs,
    state: blankState(),
    tag: `${symbol0}/${symbol1}`,
    // Reads ctx.tag late so disambiguation (below) applies to lines logged after it.
    log: (msg: string) => log(`[${ctx.tag}] ${msg}`),
  };
  return ctx;
}

/**
 * Make the log tags unique.
 *
 * Two pools on the same pair (different fee tiers) would otherwise produce two
 * identical prefixes, which is worse than no prefix at all — interleaved output
 * that looks attributable and is not.
 */
export function disambiguateTags(vaults: VaultCtx[]): void {
  const counts = new Map<string, number>();
  for (const v of vaults) counts.set(v.tag, (counts.get(v.tag) ?? 0) + 1);
  for (const v of vaults) {
    if ((counts.get(v.tag) ?? 0) > 1) v.tag = `${v.tag}@${v.vault.address.slice(2, 8)}`;
  }
}

// The RebalanceProxy's per-vault caps (falling back to its globals), read fresh
// each decision so governance changes apply without a keeper restart.
export interface ProxyCaps {
  maxTranslation: number;
  maxWidth: number;
  minIntervalSecs: number;
  lastRebalanceTs: number;
  exempted: boolean;
}

export async function readProxyCaps(proxy: ethers.Contract, vault: string): Promise<ProxyCaps> {
  const [gTrans, gWidth, gInt, cTrans, cWidth, cInt, last, exempted] = await Promise.all([
    proxy.maxTranslation(),
    proxy.maxWidth(),
    proxy.minInterval(),
    proxy.customDiff(vault),
    proxy.customWidth(vault),
    proxy.customInterval(vault),
    proxy.lastRebalance(vault),
    proxy.exempted(vault),
  ]);
  const pick = (custom: ethers.BigNumber, global: ethers.BigNumber) =>
    custom.isZero() ? global.toNumber() : custom.toNumber();
  return {
    maxTranslation: pick(cTrans, gTrans),
    maxWidth: pick(cWidth, gWidth),
    minIntervalSecs: pick(cInt, gInt),
    lastRebalanceTs: last.toNumber(),
    exempted,
  };
}

// Restart-safe cooldown: recover the last rebalance timestamp from chain state
// instead of trusting local memory. Proxy mode reads the proxy's mapping; direct
// mode scans back for the vault's last Rebalance event.
export async function readLastRebalanceTs(ctx: VaultCtx): Promise<number> {
  if (ctx.proxy) {
    const ts: ethers.BigNumber = await ctx.proxy.lastRebalance(ctx.vault.address);
    return ts.toNumber();
  }
  try {
    const { provider } = ctx.chain;
    const head = await provider.getBlockNumber();
    const fromBlock = Math.max(0, head - ctx.cfg.STARTUP_LOOKBACK_BLOCKS);
    const events = await ctx.vault.queryFilter(ctx.vault.filters.Rebalance(), fromBlock);
    if (events.length === 0) return 0;
    const block = await provider.getBlock(events[events.length - 1].blockNumber);
    return block.timestamp;
  } catch (e: any) {
    ctx.log(`warn: could not recover last Rebalance event (${e?.message ?? e}) — cooldown starts fresh`);
    return 0;
  }
}

/**
 * Transaction overrides with an EXPLICIT legacy gasPrice.
 *
 * Never leave pricing to ethers here — see GAS_PRICE_MARKUP_PCT in config.ts. Passing
 * `gasPrice` also keeps the transaction legacy-typed, so no 1.5 gwei tip is
 * attached. An under-priced transaction on Hydration is dropped at apply
 * without producing a receipt, which is why this is a multiple of the chain's
 * own quote rather than a constant.
 */
export async function txOverrides(
  chain: Pick<Chain, 'provider' | 'cfg'>,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const base = ethers.BigNumber.from(await chain.provider.send('eth_gasPrice', []));
  const gasPrice = base.mul(100 + chain.cfg.GAS_PRICE_MARKUP_PCT).div(100);
  return { gasPrice, gasLimit: chain.cfg.GAS_LIMIT, ...extra };
}
