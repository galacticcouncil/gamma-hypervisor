import { ethers } from 'ethers';
import { AGGREGATOR_V3_ABI, ERC20_ABI, HYPERVISOR_ABI, POOL_ABI, REBALANCE_PROXY_ABI } from '@keeper/abis';
import { oldestObservationAgeSecs, readSlot0, readTwapTick } from '@keeper/pool';
import { readIdleBalances, readPositions, readTotalAmounts } from '@keeper/vault';
import { vaultFees } from '@keeper/feesOwed';
import { readOracleTick } from '@keeper/oracle';
import { priceFromSqrtX96 } from '@keeper/price';
import { isReservePaused } from '@keeper/moneyMarket';
import type { GateFailedAt } from '@keeper/record';
import type { Db } from '../db/index';
import type { UiConfig } from '../config';
import type { Deposits, Head, KeeperConfig } from '../contract/types';
import { composition, human, nav1, nav1Incl, priceHuman, sharePrice } from '../derive/economics';
import { CLEARING_ABI, HYPERVISOR_EXTRA_ABI, POOL_EXTRA_ABI, UNIPROXY_ABI } from './abis';
import { descriptorEntry, listVaults, type VaultRow } from './descriptor';
import { intervalCollector, registerCollector, type Collector, type CollectorDeps, type LiveState } from './types';
import { bit, describeError, emitLive, flipSource, Loop, log, nowSec, rpcCall, tick } from './util';

// the 60s/vault sampler: one `samples` row read through the keeper's own
// signer-free leaf modules, so the "chain says" column cannot drift from what
// the keeper would have seen. own provider (RPC_URL, a different provider than
// the keeper's) plus the HEAD_FALLBACK_URL eth_blockNumber poll that gives the
// `stalled` rule a second head. thresholds come from the cached keeper /config,
// else the descriptor — never from a literal here.

export const HEAD_FALLBACK_SECS = 30;

// keeper chain.ts:192-198, copied: chain.ts imports config.ts, which pulls dotenv/config into the ui
export interface ProxyCaps {
  maxTranslation: number;
  maxWidth: number;
  minIntervalSecs: number;
  lastRebalanceTs: number;
  exempted: boolean;
}

// keeper chain.ts:200-220, copied verbatim for the same reason
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
  const pick = (custom: ethers.BigNumber, global: ethers.BigNumber) => (custom.isZero() ? global.toNumber() : custom.toNumber());
  return {
    maxTranslation: pick(cTrans, gTrans),
    maxWidth: pick(cWidth, gWidth),
    minIntervalSecs: pick(cInt, gInt),
    lastRebalanceTs: last.toNumber(),
    exempted,
  };
}

// --- thresholds ---------------------------------------------------------------

export interface VaultThresholds {
  entrypoint: 'direct' | 'proxy';
  proxy: string | null;
  admin: string | null;
  feeRecipient: string | null;
  clearing: string | null;
  twapEnabled: boolean;
  twapWindowSecs: number;
  minTwapWindowSecs: number;
  maxDevTicks: number;
  allowUnsafeSpot: boolean;
  oracleEnabled: boolean;
  oracleFeed0: string | null;
  oracleFeed1: string | null;
  oracleFeed0Side: 'token0' | 'token1';
  oracleMaxAgeSecs: number;
  oracleMaxDevTicks: number;
  foldMinShare: number;
  mmDataProvider: string | null;
  mmUnderlying: string | null;
  dryRun: boolean;
  // which layer answered: the running keeper, or the descriptor on disk
  source: 'keeper' | 'descriptor';
}

type Entry = Record<string, unknown>;

function num(e: Entry, k: string, d: number): number {
  const v = e[k];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return d;
}

// json carries real booleans; a hand-written descriptor may carry the env spelling
function flag(e: Entry, k: string, d: boolean): boolean {
  const v = e[k];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true' || v === '1' || v === 'yes';
  return d;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
function addrOf(e: Entry, k: string): string | null {
  const v = e[k];
  return typeof v === 'string' && ADDRESS_RE.test(v) ? v : null;
}

function definedOnly(e: Entry): Entry {
  const out: Entry = {};
  for (const [k, v] of Object.entries(e)) if (v !== undefined) out[k] = v;
  return out;
}

// the keeper's own /config entry for this vault, when it has one
export function keeperVaultEntry(cfg: KeeperConfig | null, id: string): Entry | null {
  if (!cfg) return null;
  for (const v of cfg.vaults) {
    const vault = v.VAULT;
    if (typeof vault === 'string' && vault.toLowerCase() === id) return v as Entry;
  }
  return null;
}

// defaults mirror keeper config.ts:39-211; the descriptor is the fallback layer
// and the running keeper's /config wins key by key wherever it carries one
export function thresholdsFor(db: Db, id: string, keeperCfg: KeeperConfig | null): VaultThresholds {
  const kv = keeperVaultEntry(keeperCfg, id);
  const e: Entry = { ...descriptorEntry(db, id), ...(kv ? definedOnly(kv) : {}) };
  const g: Entry = (keeperCfg?.global as Entry | undefined) ?? {};
  const side = e.ORACLE_FEED0_SIDE === 'token1' ? 'token1' : 'token0';
  return {
    entrypoint: e.ENTRYPOINT === 'proxy' ? 'proxy' : 'direct',
    proxy: addrOf(e, 'REBALANCE_PROXY'),
    admin: addrOf(e, 'ADMIN_ADDRESS'),
    feeRecipient: addrOf(e, 'FEE_RECIPIENT'),
    clearing: addrOf(e, 'MONITOR_CLEARING'),
    twapEnabled: flag(e, 'TWAP_ENABLED', true),
    twapWindowSecs: num(e, 'TWAP_WINDOW_SECS', 3600),
    minTwapWindowSecs: num(e, 'MIN_TWAP_WINDOW_SECS', 600),
    maxDevTicks: num(e, 'MAX_DEV_TICKS', 100),
    allowUnsafeSpot: flag(e, 'ALLOW_UNSAFE_SPOT', false),
    oracleEnabled: flag(e, 'ORACLE_ENABLED', false),
    oracleFeed0: addrOf(e, 'ORACLE_FEED0'),
    oracleFeed1: addrOf(e, 'ORACLE_FEED1'),
    oracleFeed0Side: side,
    oracleMaxAgeSecs: num(e, 'ORACLE_MAX_AGE_SECS', 600),
    oracleMaxDevTicks: num(e, 'ORACLE_MAX_DEV_TICKS', 200),
    foldMinShare: num(e, 'FOLD_MIN_SHARE', 0.4),
    mmDataProvider: addrOf(g, 'MM_DATA_PROVIDER'),
    mmUnderlying: addrOf(e, 'MM_UNDERLYING'),
    dryRun: flag(g, 'DRY_RUN', false),
    source: kv ? 'keeper' : 'descriptor',
  };
}

// --- gate + deposits ------------------------------------------------------------

export interface GateReading {
  ok: boolean;
  failedAt: GateFailedAt | null;
  reason: string;
}

export interface GateInput {
  th: VaultThresholds;
  spotTick: number;
  twapWindowSecs: number | null;
  twapTick: number | null;
  // the twap read itself threw (observe reverted)
  twapError: boolean;
  oracleTick: number | null;
  oracleAgeSecs: number | null;
  oracleError: boolean;
}

// keeper.ts checkPrice 208-267, same order and same precedence. the sampler
// reads the oracle even when the twap leg already failed (a monitor wants both
// readings); only the attribution below follows the keeper's short-circuit.
export function gateOf(i: GateInput): GateReading {
  const th = i.th;
  if (th.twapEnabled) {
    if (i.twapError) return { ok: false, failedAt: 'twap-unavailable', reason: 'TWAP unavailable — fail-closed' };
    if (i.twapWindowSecs !== null && i.twapWindowSecs < th.minTwapWindowSecs) {
      return { ok: false, failedAt: 'twap-history', reason: `pool history ${i.twapWindowSecs}s < MIN_TWAP_WINDOW_SECS ${th.minTwapWindowSecs}s` };
    }
    if (i.twapTick !== null) {
      const dev = Math.abs(i.spotTick - i.twapTick);
      if (dev > th.maxDevTicks) {
        return { ok: false, failedAt: 'twap-dev', reason: `spot ${i.spotTick} vs TWAP(${i.twapWindowSecs}s) ${i.twapTick} dev ${dev} > ${th.maxDevTicks}` };
      }
    }
  } else if (!th.dryRun && !th.allowUnsafeSpot) {
    return { ok: false, failedAt: 'spot-unsafe', reason: 'TWAP disabled without ALLOW_UNSAFE_SPOT' };
  }
  if (th.oracleEnabled && th.oracleFeed0) {
    if (i.oracleError || i.oracleTick === null) return { ok: false, failedAt: 'oracle-unreadable', reason: 'oracle unreadable — fail-closed' };
    if (i.oracleAgeSecs !== null && i.oracleAgeSecs > th.oracleMaxAgeSecs) {
      return { ok: false, failedAt: 'oracle-stale', reason: `oracle stale (${i.oracleAgeSecs}s > ${th.oracleMaxAgeSecs}s)` };
    }
    const ref = i.twapTick ?? i.spotTick;
    const dev = Math.abs(ref - i.oracleTick);
    if (dev > th.oracleMaxDevTicks) {
      return { ok: false, failedAt: 'oracle-dev', reason: `pool ${ref} vs oracle ${i.oracleTick} dev ${dev} > ${th.oracleMaxDevTicks}` };
    }
  }
  return { ok: true, failedAt: null, reason: 'ok' };
}

export interface DepositsInput {
  paused: boolean | null;
  whitelistedAddress: string | null;
  // `clearance()` of the whitelisted address when it is a UniProxy (UniProxy.sol:36)
  entryClearance?: string | null;
  clearing: string | null;
  supply: bigint | null;
  maxTotalSupply: bigint | null;
  twapCheck: boolean | null;
  threshold: number | null;
  // max(P/Ptwap, Ptwap/P) over the clearing's own twap interval, raw pool prices
  ratio: number | null;
  inBaseRange: boolean | null;
}

// every threshold is read live, never a literal: 10_100 today means 1% deviation,
// the contract default 10_000 would mean 0%
export function depositsOf(i: DepositsInput): Deposits {
  // mainnet whitelists the UniProxy and the UniProxy holds the clearing, so one
  // hop through clearance() counts as whitelisted too
  const same = (a: string | null | undefined, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  const whitelisted =
    i.clearing === null || i.whitelistedAddress === null ? null : same(i.whitelistedAddress, i.clearing) || same(i.entryClearance, i.clearing);
  const deviationBps = i.ratio === null ? null : (i.ratio - 1) * 10_000;
  // the contract compares floor(price × 10_000 / priceBefore) both ways
  const twapFails = i.twapCheck === true && i.ratio !== null && i.threshold !== null && Math.floor(i.ratio * 10_000) > i.threshold;
  const note = i.inBaseRange === false ? 'out of base range' : null;
  const capped = i.maxTotalSupply !== null && i.maxTotalSupply > 0n && i.supply !== null && i.supply >= i.maxTotalSupply;
  const reason = i.paused === true
    ? 'clearing paused'
    : whitelisted === false
      ? 'vault does not whitelist the configured clearing'
      : capped
        ? 'supply at maxTotalSupply'
        : twapFails
          ? `spot ${deviationBps === null ? '?' : deviationBps.toFixed(0)}bps from the clearing twap (threshold ${i.threshold})`
          : null;
  return {
    state: reason === null ? 'open' : 'blocked',
    reason,
    threshold: i.threshold,
    deviationBps,
    twapCheck: i.twapCheck,
    whitelisted,
    note,
  };
}

// --- sampler ---------------------------------------------------------------------

// the parts of a sample the `samples` row has no column for, cached for the serialiser
export interface VaultReading {
  at: number;
  block: number;
  blockTs: number;
  caps: ProxyCaps | null;
  deposits: Deposits;
  gate: GateReading;
  twap: { windowSecs: number | null; tick: number | null } | null;
  oracle: { tick: number; ageSecs: number; price: number } | null;
  fees: { fees0: string; fees1: string; block: number; ts: number } | null;
  idle: { idle0: string; idle1: string; block: number; ts: number } | null;
  whitelistedAddress: string | null;
  directDeposit: boolean | null;
  thresholdSource: VaultThresholds['source'];
}

export interface ChainSamplerOpts {
  db: Db;
  cfg: UiConfig;
  live: LiveState;
  provider?: ethers.providers.JsonRpcProvider;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Wiring {
  sig: string;
  th: VaultThresholds;
  vault: ethers.Contract;
  pool: ethers.Contract;
  token0: ethers.Contract;
  token1: ethers.Contract;
  proxy: ethers.Contract | null;
  clearing: ethers.Contract | null;
  oracle: { feed0: ethers.Contract; feed1?: ethers.Contract } | null;
}

// the fields of ClearingV2's Position struct the deposits gate needs (:32-48)
interface ClearingPosition {
  twapOverride: boolean;
  twapInterval: number;
  priceThreshold: ethers.BigNumber;
}

const safe = <T>(p: Promise<T>): Promise<T | null> => p.then((v) => v, () => null);
const bigOf = (x: ethers.BigNumber | null | undefined): string | null => (x === null || x === undefined ? null : x.toString());

const INSERT_SAMPLE = `INSERT OR REPLACE INTO samples (vault_id, ts, block, spot_tick, sqrt_price_x96, price_human, total0, total1, supply,
  max_total_supply, nav1, share_price, x, base_lower, base_upper, limit_lower, limit_upper, in_base, in_limit, base_liq, base_amt0, base_amt1,
  limit_liq, limit_amt0, limit_amt1, fees0, fees1, fees1_value, idle0, idle1, oracle_tick, oracle_price, oracle_age, twap_tick, twap_window,
  gate_ok, gate_failed_at, proxy_last_rebalance_ts, gas_wei, pool_liq, fee_divisor, fee_protocol, reserve_paused, clearing_twap_check,
  clearing_threshold, clearing_dev_bps, deposits_open)
VALUES (:vault_id, :ts, :block, :spot_tick, :sqrt_price_x96, :price_human, :total0, :total1, :supply,
  :max_total_supply, :nav1, :share_price, :x, :base_lower, :base_upper, :limit_lower, :limit_upper, :in_base, :in_limit, :base_liq, :base_amt0, :base_amt1,
  :limit_liq, :limit_amt0, :limit_amt1, :fees0, :fees1, :fees1_value, :idle0, :idle1, :oracle_tick, :oracle_price, :oracle_age, :twap_tick, :twap_window,
  :gate_ok, :gate_failed_at, :proxy_last_rebalance_ts, :gas_wei, :pool_liq, :fee_divisor, :fee_protocol, :reserve_paused, :clearing_twap_check,
  :clearing_threshold, :clearing_dev_bps, :deposits_open)`;

export class ChainSampler {
  private readonly db: Db;
  private readonly cfg: UiConfig;
  private readonly live: LiveState;
  // shared with the descriptor's identity read (`provider()` below)
  readonly rpc: ethers.providers.JsonRpcProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private fallback: Loop | null = null;
  private readonly wirings = new Map<string, Wiring>();
  private readonly counts = new Map<string, number>();
  private readonly readings = new Map<string, VaultReading>();
  private readonly entries = new Map<string, string | null>();
  private rpcOk: boolean | null = null;
  private fallbackOk: boolean | null = null;

  constructor(o: ChainSamplerOpts) {
    this.db = o.db;
    this.cfg = o.cfg;
    this.live = o.live;
    this.rpc = o.provider ?? new ethers.providers.JsonRpcProvider(o.cfg.RPC_URL);
    this.fetchImpl = o.fetch ?? fetch;
    this.now = o.now ?? nowSec;
  }

  startFallback(): void {
    if (!this.cfg.HEAD_FALLBACK_URL || this.fallback) return;
    this.fallback = new Loop('collect/chain-fallback', HEAD_FALLBACK_SECS * 1000, () => this.pollFallbackHead());
    this.fallback.start();
  }

  stopFallback(): void {
    this.fallback?.stop();
    this.fallback = null;
  }

  reading(id: string): VaultReading | null {
    return this.readings.get(id) ?? null;
  }

  // second head source for the `stalled` rule: eth_blockNumber only, never a contract read
  async pollFallbackHead(): Promise<void> {
    const url = this.cfg.HEAD_FALLBACK_URL;
    if (!url) return;
    const at = this.now();
    try {
      const hex = await rpcCall(this.fetchImpl, url, 'eth_blockNumber', [], 5000);
      const number = Number(hex);
      if (!Number.isInteger(number) || number < 0) throw new Error('bad head');
      this.live.chain.fallbackHead = { number, ts: null, at: new Date(at * 1000).toISOString() } satisfies Head;
      if (this.fallbackOk !== true) {
        this.fallbackOk = true;
        flipSource(this.db, 'rpc-fallback', true, null, at);
      }
    } catch (e) {
      const detail = describeError(e);
      if (this.fallbackOk !== false) {
        this.fallbackOk = false;
        flipSource(this.db, 'rpc-fallback', false, detail, at);
      }
    }
  }

  // one pass over every vault the descriptor knows
  async sampleAll(): Promise<void> {
    const at = this.now();
    let head: ethers.providers.Block;
    try {
      head = await this.rpc.getBlock('latest');
    } catch (e) {
      this.fail(describeError(e), at);
      return;
    }
    this.live.chain.head = { number: head.number, ts: head.timestamp, at: new Date(at * 1000).toISOString() } satisfies Head;
    // the head read is the rpc's liveness proof: `ok` tracks the provider, not
    // whether a particular vault answered
    this.live.chain.ok = true;
    if (this.rpcOk !== true) {
      this.rpcOk = true;
      flipSource(this.db, 'rpc', true, null, at);
    }
    await this.sampleGasPrice();
    let sampled = 0;
    let failed = 0;
    for (const row of listVaults(this.db)) {
      if (!row.pool || !row.token0 || !row.token1 || row.dec0 === null || row.dec1 === null) continue; // identity not read yet
      try {
        await this.sampleVault(row, head, at);
        sampled++;
      } catch (e) {
        failed++;
        log('collect/chain', `${row.label}: sample failed (${describeError(e)})`);
      }
    }
    if (sampled > 0) this.live.chain.lastSampleAtMs = Date.now();
    this.live.chain.detail = failed === 0 ? null : `${failed} vault(s) not sampled`;
    tick('chain', failed === 0, at);
  }

  private fail(detail: string, at: number): void {
    this.live.chain.ok = false;
    this.live.chain.detail = detail;
    tick('chain', false, at);
    if (this.rpcOk !== false) {
      this.rpcOk = false;
      flipSource(this.db, 'rpc', false, detail, at);
    }
  }

  // the whitelisted entrypoint's own clearing, read once per address (it is set by a tx, not a block)
  private async entryClearance(entry: string | null): Promise<string | null> {
    if (!entry) return null;
    const key = entry.toLowerCase();
    const cached = this.entries.get(key);
    if (cached !== undefined) return cached;
    const found = await safe<string>(new ethers.Contract(entry, UNIPROXY_ABI, this.rpc).clearance().then(String));
    this.entries.set(key, found);
    return found;
  }

  private wiringFor(row: VaultRow): Wiring {
    const th = thresholdsFor(this.db, row.id, this.live.keeper.config);
    const sig = [row.pool, th.proxy, th.clearing, th.oracleFeed0, th.oracleFeed1, th.oracleEnabled, th.source].join('|');
    const cached = this.wirings.get(row.id);
    if (cached && cached.sig === sig) return cached;
    const p = this.rpc;
    const w: Wiring = {
      sig,
      th,
      vault: new ethers.Contract(row.id, [...HYPERVISOR_ABI, ...HYPERVISOR_EXTRA_ABI], p),
      pool: new ethers.Contract(row.pool as string, [...POOL_ABI, ...POOL_EXTRA_ABI], p),
      token0: new ethers.Contract(row.token0 as string, ERC20_ABI, p),
      token1: new ethers.Contract(row.token1 as string, ERC20_ABI, p),
      proxy: th.entrypoint === 'proxy' && th.proxy ? new ethers.Contract(th.proxy, REBALANCE_PROXY_ABI, p) : null,
      clearing: th.clearing ? new ethers.Contract(th.clearing, CLEARING_ABI, p) : null,
      oracle:
        th.oracleEnabled && th.oracleFeed0
          ? {
              feed0: new ethers.Contract(th.oracleFeed0, AGGREGATOR_V3_ABI, p),
              feed1: th.oracleFeed1 ? new ethers.Contract(th.oracleFeed1, AGGREGATOR_V3_ABI, p) : undefined,
            }
          : null,
    };
    this.wirings.set(row.id, w);
    return w;
  }

  async sampleVault(row: VaultRow, head: ethers.providers.Block, at: number): Promise<void> {
    const w = this.wiringFor(row);
    const th = w.th;
    const d = { d0: row.dec0 as number, d1: row.dec1 as number };
    const n = (this.counts.get(row.id) ?? 0) + 1;
    this.counts.set(row.id, n);
    const withFees = n % Math.max(1, this.cfg.FEES_EVERY_N) === 1 || this.cfg.FEES_EVERY_N === 1;

    const [slot0, feeProtocol] = await Promise.all([
      readSlot0(w.pool),
      // readSlot0 drops feeProtocol (keeper pool.ts:10-18); the raw tuple carries it (abis.ts:20)
      safe<number>(w.pool.slot0().then((s: { feeProtocol: number }) => Number(s.feeProtocol))),
    ]);
    const spot = Number(slot0.tick);

    const [baseLower, baseUpper, limitLower, limitUpper, positions, totals, supply, maxSupply, feeDivisor, whitelistedAddress, directDeposit, poolLiq] =
      await Promise.all([
        w.vault.baseLower().then(Number),
        w.vault.baseUpper().then(Number),
        w.vault.limitLower().then(Number),
        w.vault.limitUpper().then(Number),
        readPositions(w.vault),
        readTotalAmounts(w.vault),
        w.vault.totalSupply() as Promise<ethers.BigNumber>,
        safe(w.vault.maxTotalSupply() as Promise<ethers.BigNumber>),
        safe<number>(w.vault.fee().then(Number)),
        safe<string>(w.vault.whitelistedAddress().then(String)),
        safe(w.vault.directDeposit() as Promise<boolean>),
        safe(w.pool.liquidity() as Promise<ethers.BigNumber>),
      ]);

    const nowTs = head.timestamp;
    const twap = await this.readTwap(w, nowTs);
    const oracle = w.oracle
      ? await safe(
          readOracleTick({
            feed0: w.oracle.feed0,
            feed1: w.oracle.feed1,
            feed0Side: th.oracleFeed0Side,
            decimals0: d.d0,
            decimals1: d.d1,
            nowTs,
          }),
        )
      : null;

    const gate = gateOf({
      th,
      spotTick: spot,
      twapWindowSecs: twap.windowSecs,
      twapTick: twap.tick,
      twapError: twap.error,
      oracleTick: oracle?.tick ?? null,
      oracleAgeSecs: oracle?.ageSecs ?? null,
      oracleError: w.oracle !== null && oracle === null,
    });

    const [caps, reservePaused, gasWei, clearing] = await Promise.all([
      w.proxy ? safe(readProxyCaps(w.proxy, row.id)) : Promise.resolve(null),
      th.mmDataProvider && th.mmUnderlying
        ? isReservePaused({ provider: this.rpc, dataProvider: th.mmDataProvider, underlying: th.mmUnderlying })
        : Promise.resolve(undefined),
      this.signerBalance(),
      this.readClearing(w, row.id, slot0.sqrtPriceX96),
    ]);

    let fees: [ethers.BigNumber, ethers.BigNumber] | null = null;
    let idle: [ethers.BigNumber, ethers.BigNumber] | null = null;
    if (withFees) {
      [fees, idle] = await Promise.all([
        safe(vaultFees(w.pool, row.id, [baseLower, baseUpper], [limitLower, limitUpper], spot)),
        safe(readIdleBalances(w.token0, w.token1, row.id)),
      ]);
    }

    const P = priceHuman(spot, d);
    const nav = nav1(totals[0].toString(), totals[1].toString(), P, d);
    const navIncl = fees ? nav1Incl(nav, fees[0].toString(), fees[1].toString(), P, d) : nav;
    const comp = composition(
      {
        total0: totals[0].toString(),
        total1: totals[1].toString(),
        baseAmt0: positions.base.amount0.toString(),
        baseAmt1: positions.base.amount1.toString(),
        limitAmt0: positions.limit.amount0.toString(),
        limitAmt1: positions.limit.amount1.toString(),
      },
      P,
      d,
    );
    const f0 = fees ? human(fees[0].toString(), d.d0) : null;
    const f1 = fees ? human(fees[1].toString(), d.d1) : null;
    const inBase = baseUpper > baseLower ? spot >= baseLower && spot < baseUpper : null;
    const inLimit = limitUpper > limitLower ? spot >= limitLower && spot < limitUpper : null;

    const deposits = depositsOf({
      paused: clearing.paused,
      whitelistedAddress,
      entryClearance: await this.entryClearance(whitelistedAddress),
      clearing: th.clearing,
      supply: BigInt(supply.toString()),
      maxTotalSupply: maxSupply === null ? null : BigInt(maxSupply.toString()),
      twapCheck: clearing.twapCheck,
      threshold: clearing.threshold,
      ratio: clearing.ratio,
      inBaseRange: inBase,
    });

    this.db.run(INSERT_SAMPLE, {
      vault_id: row.id,
      ts: at,
      block: head.number,
      spot_tick: spot,
      sqrt_price_x96: slot0.sqrtPriceX96.toString(),
      price_human: P,
      total0: totals[0].toString(),
      total1: totals[1].toString(),
      supply: supply.toString(),
      max_total_supply: bigOf(maxSupply),
      nav1: nav,
      share_price: sharePrice(navIncl, supply.toString()),
      x: comp?.x ?? null,
      base_lower: baseLower,
      base_upper: baseUpper,
      limit_lower: limitLower,
      limit_upper: limitUpper,
      in_base: bit(inBase),
      in_limit: bit(inLimit),
      base_liq: positions.base.liquidity.toString(),
      base_amt0: positions.base.amount0.toString(),
      base_amt1: positions.base.amount1.toString(),
      limit_liq: positions.limit.liquidity.toString(),
      limit_amt0: positions.limit.amount0.toString(),
      limit_amt1: positions.limit.amount1.toString(),
      fees0: fees ? fees[0].toString() : null,
      fees1: fees ? fees[1].toString() : null,
      fees1_value: f0 !== null && f1 !== null ? f0 * P + f1 : null,
      idle0: idle ? idle[0].toString() : null,
      idle1: idle ? idle[1].toString() : null,
      oracle_tick: oracle?.tick ?? null,
      oracle_price: oracle?.price ?? null,
      oracle_age: oracle?.ageSecs ?? null,
      twap_tick: twap.tick,
      twap_window: twap.windowSecs,
      gate_ok: bit(gate.ok),
      gate_failed_at: gate.failedAt,
      proxy_last_rebalance_ts: caps?.lastRebalanceTs ?? null,
      gas_wei: gasWei,
      pool_liq: bigOf(poolLiq),
      fee_divisor: feeDivisor,
      fee_protocol: feeProtocol,
      reserve_paused: bit(reservePaused),
      clearing_twap_check: bit(clearing.twapCheck),
      clearing_threshold: clearing.threshold,
      clearing_dev_bps: deposits.deviationBps,
      deposits_open: bit(deposits.state === 'open'),
    });

    const prev = this.readings.get(row.id);
    const reading: VaultReading = {
      at,
      block: head.number,
      blockTs: head.timestamp,
      caps,
      deposits,
      gate,
      twap: { windowSecs: twap.windowSecs, tick: twap.tick },
      oracle: oracle ? { tick: oracle.tick, ageSecs: oracle.ageSecs, price: oracle.price } : null,
      fees: fees ? { fees0: fees[0].toString(), fees1: fees[1].toString(), block: head.number, ts: at } : (prev?.fees ?? null),
      idle: idle ? { idle0: idle[0].toString(), idle1: idle[1].toString(), block: head.number, ts: at } : (prev?.idle ?? null),
      whitelistedAddress,
      directDeposit,
      thresholdSource: th.source,
    };
    this.readings.set(row.id, reading);
    this.db.metaSetJson(`chain:reading:${row.id}`, reading);
    emitLive(
      'sample',
      row.id,
      { block: head.number, spotTick: spot, price: P, nav1: nav, gateOk: gate.ok, deposits: deposits.state },
      at,
    );
  }

  // the same clamp checkPrice uses (keeper.ts:214-216): the window is the
  // configured one or the pool's whole history, whichever is shorter
  private async readTwap(w: Wiring, nowTs: number): Promise<{ windowSecs: number | null; tick: number | null; error: boolean }> {
    if (!w.th.twapEnabled) return { windowSecs: null, tick: null, error: false };
    try {
      const oldest = await oldestObservationAgeSecs(w.pool, nowTs);
      const windowSecs = Math.min(w.th.twapWindowSecs, oldest);
      if (windowSecs < w.th.minTwapWindowSecs) return { windowSecs, tick: null, error: false };
      return { windowSecs, tick: await readTwapTick(w.pool, windowSecs), error: false };
    } catch {
      return { windowSecs: null, tick: null, error: true };
    }
  }

  // one call per pass: the only source for the cost-per-tx estimate until a
  // recenter receipt exists (derive/economics.ts costPerTx)
  private async sampleGasPrice(): Promise<void> {
    try {
      const gp = await this.rpc.getGasPrice();
      if (gp) this.db.metaSet('chain:gasPriceWei', gp.toString());
    } catch {
      // keep the last sampled price; the estimate is itself a fallback
    }
  }

  private async signerBalance(): Promise<string | null> {
    const signer = this.db.metaGet('keeper:signer');
    if (!signer) return null;
    const b = await safe(this.rpc.getBalance(signer));
    return bigOf(b);
  }

  // ClearingV2 state for the deposits gate; every threshold read live (:26/:27/:30/:137)
  private async readClearing(
    w: Wiring,
    id: string,
    sqrtPriceX96: ethers.BigNumber,
  ): Promise<{ paused: boolean | null; twapCheck: boolean | null; threshold: number | null; ratio: number | null }> {
    if (!w.clearing) return { paused: null, twapCheck: null, threshold: null, ratio: null };
    const [paused, twapCheck, globalInterval, globalThreshold, pos] = await Promise.all([
      safe(w.clearing.paused() as Promise<boolean>),
      safe(w.clearing.twapCheck() as Promise<boolean>),
      safe<number>(w.clearing.twapInterval().then(Number)),
      safe<number>(w.clearing.priceThreshold().then(Number)),
      safe<ClearingPosition>(w.clearing.positions(id)),
    ]);
    const override = pos?.twapOverride === true;
    const interval = override ? Number(pos.twapInterval) : globalInterval;
    const threshold = override ? Number(pos.priceThreshold.toString()) : globalThreshold;
    const effective = twapCheck === null && !override ? null : twapCheck === true || override;
    let ratio: number | null = null;
    if (interval !== null) {
      const sqrtTwap = await safe(w.clearing.getSqrtTwapX96(id, interval) as Promise<ethers.BigNumber>);
      if (sqrtTwap) {
        const p = priceFromSqrtX96(sqrtPriceX96);
        const before = priceFromSqrtX96(sqrtTwap);
        if (p > 0 && before > 0) ratio = Math.max(p / before, before / p);
      }
    }
    return { paused, twapCheck: effective, threshold, ratio };
  }
}

let current: ChainSampler | null = null;

// the running sampler, for readers that want the fields `samples` has no column for
export function sampler(): ChainSampler | null {
  return current;
}

// the sampler's provider, so the descriptor's identity read shares one connection
export function provider(): ethers.providers.JsonRpcProvider | null {
  return current?.rpc ?? null;
}

// the same reading through meta, for a module instance that never started one
export function lastReading(db: Db, id: string): VaultReading | null {
  return current?.reading(id) ?? db.metaGetJson<VaultReading>(`chain:reading:${id}`);
}

export function start(deps: CollectorDeps): Collector {
  const sampler = new ChainSampler({ db: deps.db, cfg: deps.cfg, live: deps.live });
  current = sampler;
  const inner = intervalCollector('chain', deps.cfg.SAMPLE_SECS * 1000, () => sampler.sampleAll());
  return registerCollector({
    name: inner.name,
    start() {
      inner.start();
      sampler.startFallback();
    },
    stop() {
      inner.stop();
      sampler.stopFallback();
    },
    lastTickAt: () => inner.lastTickAt(),
  });
}
