import { ethers } from 'ethers';
import { AGGREGATOR_V3_ABI, ERC20_ABI, HYPERVISOR_ABI, POOL_ABI, REBALANCE_PROXY_ABI } from './abis';
import type { Config } from './config';
import { log } from './log';

export interface Ctx {
  cfg: Config;
  provider: ethers.providers.JsonRpcProvider;
  signer: ethers.Wallet;
  vault: ethers.Contract;
  pool: ethers.Contract;
  proxy?: ethers.Contract; // ENTRYPOINT=proxy (Model B)
  oracle?: { feed0: ethers.Contract; feed1?: ethers.Contract }; // ORACLE_ENABLED
  tickSpacing: number;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
  owner: string;
  feeRecipient: string;
}

export async function createContext(cfg: Config): Promise<Ctx> {
  const provider = new ethers.providers.JsonRpcProvider(cfg.RPC_URL);
  provider.pollingInterval = cfg.POLL_INTERVAL_MS;
  const signer = new ethers.Wallet(cfg.PRIVATE_KEY, provider);

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
  // Symbols are cosmetic (banner only) — keep best-effort.
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

  return {
    cfg,
    provider,
    signer,
    vault,
    pool,
    proxy,
    oracle,
    tickSpacing,
    decimals0,
    decimals1,
    symbol0,
    symbol1,
    owner,
    feeRecipient: cfg.FEE_RECIPIENT ?? signer.address,
  };
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
export async function readLastRebalanceTs(ctx: Ctx): Promise<number> {
  if (ctx.proxy) {
    const ts: ethers.BigNumber = await ctx.proxy.lastRebalance(ctx.vault.address);
    return ts.toNumber();
  }
  try {
    const head = await ctx.provider.getBlockNumber();
    const fromBlock = Math.max(0, head - ctx.cfg.STARTUP_LOOKBACK_BLOCKS);
    const events = await ctx.vault.queryFilter(ctx.vault.filters.Rebalance(), fromBlock);
    if (events.length === 0) return 0;
    const block = await ctx.provider.getBlock(events[events.length - 1].blockNumber);
    return block.timestamp;
  } catch (e: any) {
    log(`warn: could not recover last Rebalance event (${e?.message ?? e}) — cooldown starts fresh`);
    return 0;
  }
}
