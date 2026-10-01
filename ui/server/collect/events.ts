import { ethers } from 'ethers';
import { HYPERVISOR_ABI, REBALANCE_PROXY_ABI } from '@keeper/abis';
import { priceFromSqrtX96 } from '@keeper/price';
import type { Db } from '../db/index';
import type { UiConfig } from '../config';
import type { Backfill } from '../contract/types';
import type { ChainEventKind, EventKind, TxKind } from '../contract/enums';
import { FULL_RANGE_LOWER, FULL_RANGE_UPPER, HYPERVISOR_EVENTS_ABI } from './abis';
import { thresholdsFor } from './chain';
import { listVaults, type VaultRow } from './descriptor';
import { intervalCollector, registerCollector, type Collector, type CollectorDeps, type LiveState } from './types';
import { appendEvent, describeError, log, nowSec, sleep, tick } from './util';

// eth_getLogs indexer: Rebalance / ZeroBurn / Deposit / Withdraw per vault from
// UI_START_BLOCK in BACKFILL_CHUNK_BLOCKS chunks, then head-follow. ONE call in
// flight for the whole process; on -32603 / timeout the chunk halves (floor 250)
// and retries behind a 5s->60s backoff; the per-vault cursor {from,to,done} is
// written to meta after every successful chunk, so a restart resumes.
//
// event signatures verified against contracts/Hypervisor.sol:50-56 (Deposit),
// :58-64 (Withdraw), :66-73 (Rebalance), :75 (ZeroBurn) on 2026-09-18 — the
// field order in collect/abis.ts HYPERVISOR_EVENTS_ABI is theirs.

export const CHUNK_FLOOR = 250;
export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 60_000;
// how long one tick may keep chunking before it yields to the next interval
export const BUDGET_MS = 20_000;
// consecutive refusals of one vault's range before the tick gives up on it
export const MAX_REFUSALS = 6;

export interface BackfillCursor {
  from: number;
  to: number;
  done: boolean;
}

export interface LogLike {
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  address: string;
  topics: string[];
  data: string;
}

export interface TxLike {
  from: string;
  to?: string | null;
  data: string;
  gasPrice?: ethers.BigNumber | null;
}

export interface ReceiptLike {
  status?: number;
  gasUsed: ethers.BigNumber;
  effectiveGasPrice?: ethers.BigNumber;
  from: string;
  to?: string | null;
  blockNumber: number;
  transactionIndex: number;
}

// the provider surface the indexer uses; ethers' JsonRpcProvider satisfies it
export interface EventsProvider {
  getBlockNumber(): Promise<number>;
  getLogs(filter: { address: string; fromBlock: number; toBlock: number; topics: Array<string | string[] | null> }): Promise<LogLike[]>;
  getBlock(block: number): Promise<{ timestamp: number } | null>;
  getTransaction(hash: string): Promise<TxLike | null>;
  getTransactionReceipt(hash: string): Promise<ReceiptLike | null>;
}

const events = new ethers.utils.Interface(HYPERVISOR_EVENTS_ABI);
const hypervisor = new ethers.utils.Interface(HYPERVISOR_ABI);
const proxy = new ethers.utils.Interface(REBALANCE_PROXY_ABI);

export const EVENT_TOPICS: string[] = ['Rebalance', 'ZeroBurn', 'Deposit', 'Withdraw'].map((n) => events.getEventTopic(n));

const STREAM_KIND: Record<ChainEventKind, EventKind> = {
  Rebalance: 'tx',
  ZeroBurn: 'zero-burn',
  Deposit: 'deposit',
  Withdraw: 'withdraw',
};

function prop(e: unknown, k: string): unknown {
  return e !== null && typeof e === 'object' ? (e as Record<string, unknown>)[k] : undefined;
}

// a range the node refused: -32603 (`query timeout of 10 seconds exceeded`) or a plain timeout
export function isChunkError(e: unknown): boolean {
  const codes = [prop(e, 'rpcCode'), prop(e, 'code'), prop(prop(e, 'error'), 'code'), prop(prop(e, 'data'), 'code')];
  if (codes.some((c) => c === -32603 || c === -32005 || c === '-32603')) return true;
  const name = String(prop(e, 'name') ?? '');
  if (name === 'TimeoutError' || name === 'AbortError' || prop(e, 'code') === 'TIMEOUT') return true;
  return /timeout|timed out|too many results|response size|query returned more than/i.test(String(prop(e, 'message') ?? ''));
}

const big = (x: ethers.BigNumber | null | undefined): string | null => (x === null || x === undefined ? null : x.toString());

// decoded event args as json: BigNumber -> decimal string, addresses lowercase
export function argsOf(kind: ChainEventKind, args: ethers.utils.Result): Record<string, string | number> {
  switch (kind) {
    case 'Rebalance':
      return {
        tick: Number(args.tick),
        totalAmount0: args.totalAmount0.toString(),
        totalAmount1: args.totalAmount1.toString(),
        feeAmount0: args.feeAmount0.toString(),
        feeAmount1: args.feeAmount1.toString(),
        totalSupply: args.totalSupply.toString(),
      };
    case 'ZeroBurn':
      return { fee: Number(args.fee), fees0: args.fees0.toString(), fees1: args.fees1.toString() };
    default:
      return {
        sender: String(args.sender).toLowerCase(),
        to: String(args.to).toLowerCase(),
        shares: args.shares.toString(),
        amount0: args.amount0.toString(),
        amount1: args.amount1.toString(),
      };
  }
}

export interface DecodedCall {
  base: [number, number];
  limit: [number, number];
  feeRecipient: string;
}

// the rebalance call behind a Rebalance log: direct (HYPERVISOR_ABI) or through the proxy
export function decodeRebalanceCall(data: string, vault: string): DecodedCall | null {
  for (const iface of [proxy, hypervisor]) {
    try {
      const tx = iface.parseTransaction({ data });
      if (tx.name !== 'rebalance') continue;
      const a = tx.args;
      if (a.hypervisor !== undefined && String(a.hypervisor).toLowerCase() !== vault) continue;
      return {
        base: [Number(a._baseLower), Number(a._baseUpper)],
        limit: [Number(a._limitLower), Number(a._limitUpper)],
        feeRecipient: String(a._feeRecipient).toLowerCase(),
      };
    } catch {
      // not this abi
    }
  }
  return null;
}

export interface PriorSample {
  base: [number, number] | null;
  limitAmt0: string | null;
  limitAmt1: string | null;
  sqrtPriceX96: string | null;
}

// keeper.ts:423-428: both legs in token1 terms, valued at the raw pool price
export function limitMinLegShare(s: PriorSample): number | null {
  if (s.limitAmt0 === null || s.limitAmt1 === null || s.sqrtPriceX96 === null) return null;
  let price: number;
  try {
    price = priceFromSqrtX96(ethers.BigNumber.from(s.sqrtPriceX96));
  } catch {
    return null;
  }
  const v0 = Number(s.limitAmt0) * price;
  const v1 = Number(s.limitAmt1);
  const total = v0 + v1;
  if (!(total > 0) || !Number.isFinite(total)) return null;
  return Math.min(v0, v1) / total;
}

// base ticks unchanged ? (prior sample's limit min-leg >= FOLD_MIN_SHARE ? fold : refresh) : recenter
export function rebalanceKind(prior: PriorSample | null, newBase: [number, number] | null, foldMinShare: number): TxKind {
  if (!prior?.base || !newBase) return 'unknown';
  if (prior.base[0] !== newBase[0] || prior.base[1] !== newBase[1]) return 'recenter';
  const share = limitMinLegShare(prior);
  if (share === null) return 'refresh';
  return share >= foldMinShare ? 'fold' : 'refresh';
}

export interface EventsIndexerOpts {
  db: Db;
  cfg: UiConfig;
  live: LiveState;
  provider?: EventsProvider;
  now?: () => number;
  budgetMs?: number;
  // tests replace the backoff wait
  sleepImpl?: (ms: number) => Promise<void>;
}

interface TxGroup {
  hash: string;
  block: number;
  logs: Array<{ kind: ChainEventKind; log: LogLike; args: Record<string, string | number> }>;
}

const INSERT_EVENT = `INSERT OR IGNORE INTO chain_events (tx_hash, log_index, vault_id, block, ts, kind, args_json)
VALUES (:hash, :log_index, :vault, :block, :ts, :kind, :args)`;

const INSERT_TX = `INSERT OR REPLACE INTO txs (hash, vault_id, kind, block, ts, from_addr, gas_used, gas_price_wei, cost_wei, status,
  tick, total0, total1, supply, base_lower, base_upper, limit_lower, limit_upper, fee_recipient, full_range, foreign_recipient, plan_json, receipt_json)
VALUES (:hash, :vault, :kind, :block, :ts, :from_addr, :gas_used, :gas_price_wei, :cost_wei, :status,
  :tick, :total0, :total1, :supply, :base_lower, :base_upper, :limit_lower, :limit_upper, :fee_recipient, :full_range, :foreign_recipient, :plan_json, :receipt_json)`;

export class EventsIndexer {
  private readonly db: Db;
  private readonly cfg: UiConfig;
  private readonly live: LiveState;
  private readonly provider: EventsProvider;
  private readonly now: () => number;
  private readonly budgetMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  private chunk: number;
  private backoffMs = 0;
  private readonly cursors = new Map<string, BackfillCursor>();
  private readonly blockTs = new Map<number, number>();

  constructor(o: EventsIndexerOpts) {
    this.db = o.db;
    this.cfg = o.cfg;
    this.live = o.live;
    this.provider = o.provider ?? new ethers.providers.JsonRpcProvider(o.cfg.RPC_URL);
    this.now = o.now ?? nowSec;
    this.budgetMs = o.budgetMs ?? BUDGET_MS;
    this.sleep = o.sleepImpl ?? sleep;
    this.chunk = o.cfg.BACKFILL_CHUNK_BLOCKS;
  }

  // current chunk size; only ever shrinks within a process
  get chunkBlocks(): number {
    return this.chunk;
  }

  get backoff(): number {
    return this.backoffMs;
  }

  cursor(vault: string): BackfillCursor | null {
    return this.cursors.get(vault) ?? this.db.metaGetJson<BackfillCursor>(`backfill:${vault}`);
  }

  private saveCursor(vault: string, c: BackfillCursor): void {
    this.cursors.set(vault, c);
    this.db.metaSetJson(`backfill:${vault}`, c);
  }

  async tickOnce(): Promise<void> {
    let head: number;
    try {
      head = await this.provider.getBlockNumber();
    } catch (e) {
      tick('events', false, this.now());
      throw e;
    }
    const deadline = Date.now() + this.budgetMs;
    for (const row of listVaults(this.db)) {
      try {
        await this.indexVault(row, head, deadline);
      } catch (e) {
        log('collect/events', `${row.label}: indexing failed (${describeError(e)})`);
      }
    }
    this.publish();
    tick('events', true, this.now());
  }

  // the whole fleet's progress as one backfill: the vault furthest behind
  private publish(): void {
    let agg: Backfill | null = null;
    for (const row of listVaults(this.db)) {
      const c = this.cursor(row.id);
      if (!c) continue;
      agg = agg === null ? { ...c } : { from: Math.min(agg.from, c.from), to: Math.min(agg.to, c.to), done: agg.done && c.done };
    }
    this.live.chain.backfill = agg;
  }

  private async indexVault(row: VaultRow, head: number, deadline: number): Promise<void> {
    // no UI_START_BLOCK: start at the head rather than walking from genesis
    const start = row.start_block ?? head;
    let cur = this.cursor(row.id);
    if (!cur) {
      // say it once, or a descriptor that never got a real start block looks healthy with no history
      if (row.start_block === null) log('collect/events', `${row.label}: no UI_START_BLOCK, following from head ${head} — no history is backfilled`);
      cur = { from: start, to: start - 1, done: false };
    }
    let refusals = 0;
    while (Date.now() < deadline) {
      const from = cur.to + 1;
      if (from > head) {
        if (!cur.done) this.saveCursor(row.id, { ...cur, done: true });
        return;
      }
      const to = Math.min(head, from + this.chunk - 1);
      let logs: LogLike[];
      try {
        // one call in flight for the whole process: every caller awaits here
        logs = await this.provider.getLogs({ address: row.id, fromBlock: from, toBlock: to, topics: [EVENT_TOPICS] });
      } catch (e) {
        if (!isChunkError(e)) throw e;
        this.shrink();
        log('collect/events', `${row.label}: chunk ${to - from + 1} refused, retrying ${this.chunk} blocks in ${this.backoffMs}ms`);
        if (++refusals >= MAX_REFUSALS) return;
        await this.sleep(Math.min(this.backoffMs, Math.max(0, deadline - Date.now())));
        continue;
      }
      this.backoffMs = 0;
      refusals = 0;
      await this.ingest(row, logs, cur.done);
      cur = { from: cur.from, to, done: to >= head };
      this.saveCursor(row.id, cur);
    }
  }

  private shrink(): void {
    this.chunk = Math.max(CHUNK_FLOOR, Math.floor(this.chunk / 2));
    this.backoffMs = this.backoffMs === 0 ? BACKOFF_MIN_MS : Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
  }

  // decode, resolve timestamps and receipts, then write the chunk in one transaction
  async ingest(row: VaultRow, logs: LogLike[], live: boolean): Promise<number> {
    if (logs.length === 0) return 0;
    const groups = new Map<string, TxGroup>();
    for (const l of logs) {
      let kind: ChainEventKind;
      let args: Record<string, string | number>;
      try {
        const parsed = events.parseLog(l);
        kind = parsed.name as ChainEventKind;
        args = argsOf(kind, parsed.args);
      } catch {
        continue; // an event this abi does not carry
      }
      const g = groups.get(l.transactionHash) ?? { hash: l.transactionHash, block: l.blockNumber, logs: [] };
      g.logs.push({ kind, log: l, args });
      groups.set(l.transactionHash, g);
    }

    for (const g of groups.values()) await this.timestampOf(g.block);
    const th = thresholdsFor(this.db, row.id, this.live.keeper.config);
    const signer = this.db.metaGet('keeper:signer');
    const rows: Array<Record<string, string | number | null>> = [];
    for (const g of groups.values()) {
      const built = await this.buildTx(row, g, th.foldMinShare, th.admin, th.feeRecipient, signer);
      if (built) rows.push(built);
    }

    let n = 0;
    this.db.transaction(() => {
      for (const g of groups.values()) {
        const ts = this.blockTs.get(g.block) ?? this.now();
        for (const e of g.logs) {
          const r = this.db.run(INSERT_EVENT, {
            hash: g.hash,
            log_index: e.log.logIndex,
            vault: row.id,
            block: g.block,
            ts,
            kind: e.kind,
            args: JSON.stringify(e.args),
          });
          if (r.changes === 0) continue;
          n++;
          if (live) appendEvent(this.db, STREAM_KIND[e.kind], row.id, `${g.hash}:${e.log.logIndex}`, { kind: e.kind, block: g.block, ...e.args }, ts);
        }
      }
      for (const t of rows) {
        this.db.run(INSERT_TX, t);
        if (live) appendEvent(this.db, 'tx', row.id, String(t.hash), { hash: t.hash, kind: t.kind, block: t.block, status: t.status }, Number(t.ts));
      }
    });
    return n;
  }

  private async timestampOf(block: number): Promise<number> {
    const hit = this.blockTs.get(block);
    if (hit !== undefined) return hit;
    const b = await this.provider.getBlock(block).catch(() => null);
    const ts = b?.timestamp ?? this.now();
    this.blockTs.set(block, ts);
    if (this.blockTs.size > 4096) for (const k of [...this.blockTs.keys()].slice(0, 1024)) this.blockTs.delete(k);
    return ts;
  }

  // one txs row per tx that carried a Rebalance or a ZeroBurn; receipts give cost_wei
  private async buildTx(
    row: VaultRow,
    g: TxGroup,
    foldMinShare: number,
    admin: string | null,
    feeRecipient: string | null,
    signer: string | null,
  ): Promise<Record<string, string | number | null> | null> {
    const reb = g.logs.find((e) => e.kind === 'Rebalance');
    const zero = g.logs.find((e) => e.kind === 'ZeroBurn');
    if (!reb && !zero) return null;
    if (this.db.get('SELECT hash FROM txs WHERE hash = :h', { h: g.hash })) return null;

    const ts = await this.timestampOf(g.block);
    const [tx, receipt] = await Promise.all([
      this.provider.getTransaction(g.hash).catch(() => null),
      this.provider.getTransactionReceipt(g.hash).catch(() => null),
    ]);
    const call = tx ? decodeRebalanceCall(tx.data, row.id) : null;
    const prior = this.priorSample(row.id, ts);
    const newBase = call?.base ?? this.nextSampleBase(row.id, ts);
    const compound = !reb && admin !== null && (tx?.to ?? '').toLowerCase() === admin.toLowerCase() && (!signer || tx?.from?.toLowerCase() === signer);
    let kind: TxKind = reb ? rebalanceKind(prior, newBase, foldMinShare) : compound ? 'compound' : 'unknown';
    // backfilled history has no sample to compare against, but the base the
    // previous indexed rebalance set still proves the band moved. fold vs
    // refresh stays 'unknown': that needs the limit amounts only a sample has
    if (kind === 'unknown' && reb && newBase) {
      const prev = this.priorTxBase(row.id, ts);
      if (prev && (prev[0] !== newBase[0] || prev[1] !== newBase[1])) kind = 'recenter';
    }

    const gasPrice = receipt?.effectiveGasPrice ?? tx?.gasPrice ?? null;
    const gasUsed = receipt?.gasUsed ?? null;
    const cost = gasUsed && gasPrice ? gasUsed.mul(gasPrice) : null;
    const ticks = call ? [...call.base, ...call.limit] : [];
    const fullRange = ticks.length > 0 ? ticks.some((t) => t <= FULL_RANGE_LOWER || t >= FULL_RANGE_UPPER) : null;
    const foreign = call && feeRecipient ? call.feeRecipient !== feeRecipient.toLowerCase() : null;
    const plan = this.planOf(g.hash);

    return {
      hash: g.hash,
      vault: row.id,
      kind,
      block: g.block,
      ts,
      from_addr: (tx?.from ?? receipt?.from ?? null)?.toLowerCase() ?? null,
      gas_used: gasUsed ? Number(gasUsed.toString()) : null,
      gas_price_wei: big(gasPrice),
      cost_wei: big(cost),
      status: receipt?.status ?? null,
      tick: reb ? Number(reb.args.tick) : null,
      total0: reb ? String(reb.args.totalAmount0) : null,
      total1: reb ? String(reb.args.totalAmount1) : null,
      supply: reb ? String(reb.args.totalSupply) : null,
      base_lower: call?.base[0] ?? null,
      base_upper: call?.base[1] ?? null,
      limit_lower: call?.limit[0] ?? null,
      limit_upper: call?.limit[1] ?? null,
      fee_recipient: call?.feeRecipient ?? null,
      full_range: fullRange === null ? null : fullRange ? 1 : 0,
      foreign_recipient: foreign === null ? null : foreign ? 1 : 0,
      plan_json: plan,
      receipt_json: receipt
        ? JSON.stringify({
            status: receipt.status ?? null,
            gasUsed: big(receipt.gasUsed),
            effectiveGasPrice: big(receipt.effectiveGasPrice ?? null),
            blockNumber: receipt.blockNumber,
            transactionIndex: receipt.transactionIndex,
          })
        : null,
    };
  }

  private priorSample(vault: string, ts: number): PriorSample | null {
    const s = this.db.get<{ base_lower: number | null; base_upper: number | null; limit_amt0: string | null; limit_amt1: string | null; sqrt_price_x96: string | null }>(
      'SELECT base_lower, base_upper, limit_amt0, limit_amt1, sqrt_price_x96 FROM samples WHERE vault_id = :v AND ts <= :ts ORDER BY ts DESC LIMIT 1',
      { v: vault, ts },
    );
    if (!s) return null;
    return {
      base: s.base_lower === null || s.base_upper === null ? null : [s.base_lower, s.base_upper],
      limitAmt0: s.limit_amt0,
      limitAmt1: s.limit_amt1,
      sqrtPriceX96: s.sqrt_price_x96,
    };
  }

  // the base the previous indexed rebalance set: a backfill predates every sample
  private priorTxBase(vault: string, ts: number): [number, number] | null {
    const s = this.db.get<{ base_lower: number | null; base_upper: number | null }>(
      'SELECT base_lower, base_upper FROM txs WHERE vault_id = :v AND ts < :ts AND base_lower IS NOT NULL ORDER BY ts DESC LIMIT 1',
      { v: vault, ts },
    );
    return !s || s.base_lower === null || s.base_upper === null ? null : [s.base_lower, s.base_upper];
  }

  // fallback for an undecodable call: where the base sat once the tx had landed
  private nextSampleBase(vault: string, ts: number): [number, number] | null {
    const s = this.db.get<{ base_lower: number | null; base_upper: number | null }>(
      'SELECT base_lower, base_upper FROM samples WHERE vault_id = :v AND ts > :ts ORDER BY ts LIMIT 1',
      { v: vault, ts },
    );
    return !s || s.base_lower === null || s.base_upper === null ? null : [s.base_lower, s.base_upper];
  }

  // the keeper's own plan for this hash, when its record landed first
  private planOf(hash: string): string | null {
    const row = this.db.get<{ record_json: string | null }>('SELECT record_json FROM cycles WHERE tx_hash = :h ORDER BY id DESC LIMIT 1', { h: hash });
    if (!row?.record_json) return null;
    try {
      const plan = (JSON.parse(row.record_json) as { plan?: unknown }).plan;
      return plan ? JSON.stringify(plan) : null;
    } catch {
      return null;
    }
  }
}

export function start(deps: CollectorDeps): Collector {
  const indexer = new EventsIndexer({ db: deps.db, cfg: deps.cfg, live: deps.live });
  return registerCollector(intervalCollector('events', deps.cfg.EVENTS_SECS * 1000, () => indexer.tickOnce()));
}
