import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import type { CycleRecord } from '@keeper/record';
import { Db, openDb } from '../server/db/index';
import { loadConfig, type UiConfig } from '../server/config';
import { KeeperCollector, parseSse, type StateLost } from '../server/collect/keeper';
import { EventsIndexer, decodeRebalanceCall, isChunkError, limitMinLegShare, rebalanceKind, type EventsProvider, type LogLike } from '../server/collect/events';
import { depositsOf, gateOf, thresholdsFor, type VaultThresholds } from '../server/collect/chain';
import { MonitorCollector } from '../server/collect/monitor';
import { MonitorStatus } from '../server/contract/types';
import { HYPERVISOR_EVENTS_ABI } from '../server/collect/abis';
import { REBALANCE_PROXY_ABI } from '@keeper/abis';
import { emptyLive } from '../server/collect/types';
import { listVaults } from '../server/collect/descriptor';

// the keeper collector against a realistic /status + /events fixture, and the
// events indexer against a node that refuses wide ranges.

const VAULT = '0xa206d0959813f17c17c87147271c49065438648a';
const POOL = '0x' + '22'.repeat(20);
const SIGNER = '0x' + '11'.repeat(20);
const PROXY = '0x8b7dd119b7edb85d9cf166129dbec5d88dc78c94';
const ADMIN = '0x8fc8a0d7cb9c6b2366ec08f1bf03067d54b67bc5';
const FEE_RECIPIENT = '0x6d6f646c70792f74727372790000000000000000';
const BOOT_A = '2026-09-18T03:00:00.000Z';
const BOOT_B = '2026-09-18T05:00:00.000Z';
const T0 = 1789700000;

const dbs: Db[] = [];
function fresh(): Db {
  const d = openDb(':memory:');
  dbs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function cfgFor(over: Record<string, string> = {}): UiConfig {
  return loadConfig({ RPC_URL: 'http://rpc.example/', DB_PATH: ':memory:', ...over } as NodeJS.ProcessEnv);
}

// --- fixtures ------------------------------------------------------------------

const leg = (heldSecs = 0, armed = false) => ({ sinceTs: heldSecs ? T0 : 0, heldSecs, requiredSecs: 2025, armed });

function rec(o: { seq: number; blockTs: number; bootAt?: string } & Partial<CycleRecord>): CycleRecord {
  const { seq, blockTs, bootAt = BOOT_A, ...rest } = o;
  return {
    v: 1,
    bootAt,
    seq,
    vault: { id: VAULT, label: 'aDOT/HOLLAR' },
    block: 8_400_000 + seq,
    blockTs,
    tsSource: 'block',
    evaluatedAt: new Date(blockTs * 1000).toISOString(),
    durationMs: 41,
    reads: {
      spotTick: -13800,
      sqrtPriceX96: '39614081257132168796771975168',
      base: [-14400, -13200],
      limit: [-13200, -13140],
      limitLiquidity: '124500000000',
    },
    triggers: {
      rebalance: { trigger: false, reason: 'in range (drift 0 <= 660)', drift: 0, thresholdTicks: 660, outside: false },
      refresh: { trigger: false, reason: 'spot inside limit range', awayTicks: 0 },
      fold: { trigger: false, reason: 'limit min leg 2.0% < 40%', minLegShare: 0.02 },
    },
    winner: 'hold',
    compoundDue: false,
    dwell: { rebalance: leg(), refresh: leg(), fold: leg() },
    cooldown: null,
    gate: null,
    regime: { regime: 'calm', changed: false, reason: null, sinceTs: T0 - 7200 },
    compound: null,
    plan: null,
    tx: null,
    outcome: { code: 'hold', stage: 'triggers', detail: 'in range (drift 0 <= 660)' },
    source: 'recorded',
    ...rest,
  } as CycleRecord;
}

const oracleDevGate = (via: 'skip' | 'compound-skipped') => ({
  evaluated: true,
  ok: false,
  failedAt: 'oracle-dev' as const,
  reason: 'pool -13800 vs oracle -13690 dev 110 > 50',
  via,
  twap: { windowSecs: 3600, tick: -13798, devTicks: 2, maxDevTicks: 50 },
  oracle: { tick: -13690, ageSecs: 240, devTicks: 110, maxDevTicks: 50 },
});

function statusBody(bootAt: string, last: CycleRecord | null, fingerprint = 'fp-1'): unknown {
  return {
    v: 1,
    generatedAt: new Date((last?.blockTs ?? T0) * 1000).toISOString(),
    keeper: {
      version: '0.9.0',
      bootAt,
      mode: 'LIVE',
      signer: SIGNER,
      rpcHost: 'hdx.example',
      pollMs: 2000,
      blockTimeSecs: 2,
      head: { number: 8_400_010, ts: T0 + 200, at: new Date((T0 + 200) * 1000).toISOString() },
      busy: false,
      busySinceAt: null,
      skippedWhileBusy: 3,
      cyclesTotal: 120,
      errorsTotal: 0,
      hookErrors: 0,
      listener: { requests: 44, slowResponses: 0, clients: 1 },
      configFingerprint: fingerprint,
    },
    vaults: [
      {
        id: VAULT,
        label: 'aDOT/HOLLAR',
        tag: 'aDOT/HOLLAR',
        pool: POOL,
        token0: { address: '0x' + '33'.repeat(20), symbol: 'aDOT', decimals: 10 },
        token1: { address: '0x' + '44'.repeat(20), symbol: 'HOLLAR', decimals: 18 },
        tickSpacing: 60,
        entrypoint: 'proxy',
        proxy: PROXY,
        admin: ADMIN,
        feeRecipient: FEE_RECIPIENT,
        owner: '0x' + '55'.repeat(20),
        dwellSecs: 2025,
        roles: { rebalancerOk: true, adminOk: true, exempted: false, deadlock: false, warnings: [] },
        state: {
          lastRebalanceTs: T0 - 40000,
          dwell: {
            rebalance: { sinceTs: 0, heldSecs: 0, met: false },
            refresh: { sinceTs: 0, heldSecs: 0, met: false },
            fold: { sinceTs: 0, heldSecs: 0, met: false },
          },
          regime: { regime: 'calm', sinceTs: T0 - 7200, calmSinceTs: T0 - 7200 },
          priceTrail: { size: 900, move15mFrac: 0.001, move1hFrac: 0.004 },
          volBaseline: { median: 0.012, fetchedAtTs: T0 - 600 },
          lastCompoundTs: T0 - 300,
        },
        standing: last
          ? { code: last.outcome.code, subcode: last.gate?.failedAt ?? null, sinceTs: last.blockTs, seq: last.seq }
          : { code: 'hold', subcode: null, sinceTs: T0, seq: 0 },
        last,
        ring: { size: last?.seq ?? 0, firstSeq: last ? 1 : 0, lastSeq: last?.seq ?? 0 },
      },
    ],
  };
}

const CONFIG_BODY = {
  v: 1,
  source: 'VAULTS_FILE',
  descriptorSha256: 'abc123',
  global: { RPC_URL: { host: 'hdx.example' }, DRY_RUN: false, MM_DATA_PROVIDER: '0x' + '66'.repeat(20) },
  vaults: [{ VAULT, LABEL: 'aDOT/HOLLAR', FOLD_MIN_SHARE: 0.4, MAX_DEV_TICKS: 50, ORACLE_MAX_DEV_TICKS: 50 }],
  fingerprint: 'fp-1',
};

interface Fake {
  status: unknown;
  cycles: CycleRecord[];
  log: string;
  fetch: typeof fetch;
}

function fakeKeeper(): Fake {
  const state: Fake = {
    status: statusBody(BOOT_A, null),
    cycles: [],
    log: '',
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/status')) return json(state.status);
      if (url.includes('/cycles')) return json(state.cycles.splice(0));
      if (url.includes('/log')) return new Response(state.log, { status: 200, headers: { 'content-type': 'text/plain' } });
      if (url.endsWith('/config')) return json(CONFIG_BODY);
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
  };
  return state;
}

function sseText(frames: Array<{ id: string; data: unknown }>): string {
  return frames.map((f) => `id: ${f.id}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
}

// --- keeper collector ---------------------------------------------------------------

describe('keeper collector against a /status + /events fixture', () => {
  it('projects cycles, episodes and keeper_runs from one poll', async () => {
    const db = fresh();
    const fake = fakeKeeper();
    const hold = rec({ seq: 1, blockTs: T0 });
    const blocked = rec({
      seq: 2,
      blockTs: T0 + 60,
      gate: oracleDevGate('skip'),
      dwell: { rebalance: leg(2100, true), refresh: leg(), fold: leg() },
      winner: 'TRIGGER',
      outcome: { code: 'gate-blocked', stage: 'gate', detail: 'pool -13800 vs oracle -13690 dev 110 > 50' },
    });
    fake.status = statusBody(BOOT_A, blocked);
    fake.cycles = [hold, blocked];
    fake.log = `[${new Date(T0 * 1000).toISOString()}] #8400001 tick=-13800 base=[-14400,-13200] hold — in range (drift 0 <= 660)\n[${new Date(
      (T0 + 60) * 1000,
    ).toISOString()}] skip: pool -13800 vs oracle -13690 dev 110 > 50\n`;

    const c = new KeeperCollector({ db, baseUrl: 'http://keeper.example', fetch: fake.fetch, now: () => T0 + 120 });
    await c.pollOnce();

    const run = db.get<{ boot_at: string; signer: string; dry_run: number; config_fingerprint: string; public_config_json: string | null }>(
      'SELECT boot_at, signer, dry_run, config_fingerprint, public_config_json FROM keeper_runs',
    );
    expect(run?.boot_at).toBe(BOOT_A);
    expect(run?.signer).toBe(SIGNER);
    expect(run?.dry_run).toBe(0);
    expect(run?.public_config_json).toContain('aDOT/HOLLAR');
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM keeper_status')?.n).toBe(1);

    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cycles_raw')?.n).toBe(2);
    const cycles = db.all<{ seq: number; outcome_code: string; gate_failed_at: string | null; is_transition: number; armed_mask: number }>(
      'SELECT seq, outcome_code, gate_failed_at, is_transition, armed_mask FROM cycles ORDER BY seq',
    );
    expect(cycles.map((r) => [r.seq, r.outcome_code, r.gate_failed_at])).toEqual([
      [1, 'hold', null],
      [2, 'gate-blocked', 'oracle-dev'],
    ]);
    expect(cycles[1].armed_mask).toBe(1);
    expect(cycles.every((r) => r.is_transition === 1)).toBe(true);
    expect(c.cursor(VAULT)).toEqual({ bootAt: BOOT_A, seq: 2 });
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM keeper_lines')?.n).toBe(2);
    expect(db.get<{ line: string }>('SELECT line FROM keeper_lines ORDER BY id')?.line).not.toMatch(/^\[/);
  });

  it('folds a gate lockout spanning compound-only cycles into ONE gate-blocked episode', async () => {
    const db = fresh();
    const fake = fakeKeeper();
    const blocked = (seq: number, blockTs: number) =>
      rec({
        seq,
        blockTs,
        gate: oracleDevGate('skip'),
        dwell: { rebalance: leg(2100, true), refresh: leg(), fold: leg() },
        winner: 'TRIGGER',
        outcome: { code: 'gate-blocked', stage: 'gate', detail: 'pool -13800 vs oracle -13690 dev 110 > 50' },
      });
    // the same lockout, seen on a compound-due block: the only line is `compound skipped:`
    const compoundOnly = (seq: number, blockTs: number) =>
      rec({
        seq,
        blockTs,
        compoundDue: true,
        gate: oracleDevGate('compound-skipped'),
        compound: { allowed: false, reason: 'pool -13800 vs oracle -13690 dev 110 > 50', submitted: null, landed: false },
        outcome: { code: 'compound-only', stage: 'compound', detail: 'compound skipped: pool -13800 vs oracle -13690 dev 110 > 50' },
      });

    fake.cycles = [rec({ seq: 1, blockTs: T0 }), blocked(2, T0 + 60), compoundOnly(3, T0 + 120), compoundOnly(4, T0 + 180), blocked(5, T0 + 240)];
    fake.status = statusBody(BOOT_A, fake.cycles[fake.cycles.length - 1]);
    const c = new KeeperCollector({ db, baseUrl: 'http://keeper.example', fetch: fake.fetch, now: () => T0 + 300, logLines: false });
    await c.pollOnce();

    const eps = db.all<{ code: string; subcode: string | null; since_ts: number; until_ts: number | null; cycles: number }>(
      'SELECT code, subcode, since_ts, until_ts, cycles FROM episodes ORDER BY id',
    );
    expect(eps).toEqual([
      { code: 'hold', subcode: null, since_ts: T0, until_ts: T0 + 60, cycles: 1 },
      { code: 'gate-blocked', subcode: 'oracle-dev', since_ts: T0 + 60, until_ts: null, cycles: 4 },
    ]);

    // the lockout clears on the stream: a landed rebalance closes the run
    const landed = rec({
      seq: 6,
      blockTs: T0 + 300,
      winner: 'TRIGGER',
      gate: { ...oracleDevGate('skip'), ok: true, failedAt: null, via: null, reason: 'ok' },
      tx: { hash: '0x' + 'ab'.repeat(32), kind: 'recenter' },
      outcome: { code: 'landed', stage: 'submit', detail: 'rebalanced' },
    });
    for (const f of parseSse(sseText([{ id: `${BOOT_A}:6`, data: landed }]))) c.dispatch(f, T0 + 301);
    const after = db.all<{ code: string; until_ts: number | null }>('SELECT code, until_ts FROM episodes ORDER BY id');
    expect(after).toHaveLength(3);
    expect(after[1]).toEqual({ code: 'gate-blocked', until_ts: T0 + 300 });
    expect(after[2]).toEqual({ code: 'landed', until_ts: null });
    expect(db.get<{ tx_hash: string | null }>('SELECT tx_hash FROM cycles ORDER BY id DESC LIMIT 1')?.tx_hash).toBe('0x' + 'ab'.repeat(32));
  });

  it('resets every cursor and reports state-lost when bootAt changes', async () => {
    const db = fresh();
    const fake = fakeKeeper();
    const lost: StateLost[] = [];
    const first = rec({ seq: 4, blockTs: T0 + 180 });
    fake.cycles = [first];
    fake.status = statusBody(BOOT_A, first);
    const c = new KeeperCollector({
      db,
      baseUrl: 'http://keeper.example',
      fetch: fake.fetch,
      now: () => T0 + 200,
      logLines: false,
      onStateLost: (i) => lost.push(i),
    });
    await c.pollOnce();
    expect(c.cursor(VAULT)).toEqual({ bootAt: BOOT_A, seq: 4 });
    expect(lost).toHaveLength(0);

    fake.status = statusBody(BOOT_B, null, 'fp-2');
    await c.pollOnce();
    expect(lost).toEqual([{ prevBootAt: BOOT_A, bootAt: BOOT_B, at: T0 + 200 }]);
    // seq restarts at 1 on the new boot, so the cursor must be back at 0
    expect(c.cursor(VAULT)).toEqual({ bootAt: BOOT_B, seq: 0 });
    expect(c.lastEventId()).toBeNull();
    expect(db.metaGetJson(`keeper:cursor:${VAULT}`)).toEqual({ bootAt: BOOT_B, seq: 0 });
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM keeper_runs')?.n).toBe(2);
    expect(db.get<{ payload_json: string }>("SELECT payload_json FROM events_log WHERE kind = 'source' ORDER BY id DESC LIMIT 1")?.payload_json).toContain('restart');

    // a seq the old boot had already delivered is new again after the reset
    const afterBoot = rec({ seq: 1, blockTs: T0 + 400, bootAt: BOOT_B });
    expect(c.ingestRecord(afterBoot, T0 + 401).reason).toBe('ok');
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cycles_raw WHERE boot_at = :b', { b: BOOT_B })?.n).toBe(1);
  });
});

// --- events indexer ------------------------------------------------------------------

const eventsIface = new ethers.utils.Interface(HYPERVISOR_EVENTS_ABI);
const proxyIface = new ethers.utils.Interface(REBALANCE_PROXY_ABI);

function seedVault(db: Db, startBlock: number): void {
  db.run(
    `INSERT INTO vaults (id, label, pool, token0, token1, dec0, dec1, tick_spacing, entrypoint, start_block, first_seen_at, descriptor_json)
     VALUES (:id, 'aDOT/HOLLAR', :pool, :t0, :t1, 10, 18, 60, 'proxy', :sb, :now, :desc)`,
    {
      id: VAULT,
      pool: POOL,
      t0: '0x' + '33'.repeat(20),
      t1: '0x' + '44'.repeat(20),
      sb: startBlock,
      now: T0,
      desc: JSON.stringify({
        VAULT,
        ENTRYPOINT: 'proxy',
        REBALANCE_PROXY: PROXY,
        ADMIN_ADDRESS: ADMIN,
        FEE_RECIPIENT,
        FOLD_MIN_SHARE: 0.4,
        UI_START_BLOCK: startBlock,
      }),
    },
  );
}

function logOf(name: string, values: unknown[], o: { block: number; hash: string; index: number }): LogLike {
  const { data, topics } = eventsIface.encodeEventLog(eventsIface.getEvent(name), values);
  return { blockNumber: o.block, transactionHash: o.hash, logIndex: o.index, address: VAULT, topics, data };
}

describe('events indexer', () => {
  it('halves the chunk on -32603 and persists the cursor after every chunk', async () => {
    const db = fresh();
    seedVault(db, 0);
    const ranges: Array<[number, number]> = [];
    const provider: EventsProvider = {
      getBlockNumber: async () => 2000,
      getLogs: async (f) => {
        ranges.push([f.fromBlock, f.toBlock]);
        if (f.toBlock - f.fromBlock + 1 > 500) {
          const e = new Error('query timeout of 10 seconds exceeded') as Error & { error: { code: number } };
          e.error = { code: -32603 };
          throw e;
        }
        return [];
      },
      getBlock: async () => ({ timestamp: T0 }),
      getTransaction: async () => null,
      getTransactionReceipt: async () => null,
    };
    const live = emptyLive();
    const ix = new EventsIndexer({ db, cfg: cfgFor(), live, provider, sleepImpl: async () => undefined, now: () => T0 });
    await ix.tickOnce();

    expect(ranges.slice(0, 3)).toEqual([
      [0, 1999],
      [0, 999],
      [0, 499],
    ]);
    expect(ix.chunkBlocks).toBe(500);
    expect(ix.backoff).toBe(0); // reset by the first chunk that landed
    expect(db.metaGetJson(`backfill:${VAULT}`)).toEqual({ from: 0, to: 2000, done: true });
    expect(live.chain.backfill).toEqual({ from: 0, to: 2000, done: true });
    // a fresh process resumes from meta rather than re-reading the range
    const resumed = new EventsIndexer({ db, cfg: cfgFor(), live, provider });
    expect(resumed.cursor(VAULT)).toEqual({ from: 0, to: 2000, done: true });
  });

  it('never drops below the chunk floor', async () => {
    const db = fresh();
    seedVault(db, 0);
    const provider: EventsProvider = {
      getBlockNumber: async () => 10_000,
      getLogs: async () => {
        const e = new Error('boom') as Error & { code: number };
        e.code = -32603;
        throw e;
      },
      getBlock: async () => ({ timestamp: T0 }),
      getTransaction: async () => null,
      getTransactionReceipt: async () => null,
    };
    const ix = new EventsIndexer({ db, cfg: cfgFor(), live: emptyLive(), provider, sleepImpl: async () => undefined, budgetMs: 40 });
    await ix.tickOnce();
    expect(ix.chunkBlocks).toBeGreaterThanOrEqual(250);
    expect(ix.backoff).toBeGreaterThanOrEqual(5000);
    expect(db.metaGetJson(`backfill:${VAULT}`)).toBeNull(); // nothing landed, nothing claimed
  });

  it('writes chain_events, one txs row per tx, and classifies a zero-translation rebalance as a fold', async () => {
    const db = fresh();
    seedVault(db, 100);
    // the sample just before the tx: base unchanged by the call, limit 50/50 mixed
    db.run(
      `INSERT INTO samples (vault_id, ts, block, spot_tick, sqrt_price_x96, base_lower, base_upper, limit_lower, limit_upper, limit_amt0, limit_amt1)
       VALUES (:v, :ts, 100, -13800, :sqrt, -14400, -13200, -13200, -13140, '1000', '1000')`,
      { v: VAULT, ts: T0 - 60, sqrt: ethers.BigNumber.from(2).pow(96).toString() },
    );
    const hash = '0x' + 'cd'.repeat(32);
    const logs = [
      logOf('Rebalance', [-13800, '5000', '6000', '10', '12', '7000'], { block: 101, hash, index: 3 }),
      logOf('ZeroBurn', [5, '10', '12'], { block: 101, hash, index: 2 }),
      logOf('Deposit', ['0x' + '77'.repeat(20), '0x' + '88'.repeat(20), '900', '5', '6'], { block: 101, hash: '0x' + 'ef'.repeat(32), index: 0 }),
    ];
    const data = proxyIface.encodeFunctionData('rebalance', [
      VAULT,
      -14400,
      -13200,
      -13140,
      -13080,
      FEE_RECIPIENT,
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const provider: EventsProvider = {
      getBlockNumber: async () => 101,
      getLogs: async () => logs,
      getBlock: async () => ({ timestamp: T0 }),
      getTransaction: async (h) => (h === hash ? { from: SIGNER, to: PROXY, data, gasPrice: ethers.BigNumber.from(6_000_000) } : null),
      getTransactionReceipt: async (h) =>
        h === hash
          ? {
              status: 1,
              gasUsed: ethers.BigNumber.from(800_000),
              effectiveGasPrice: ethers.BigNumber.from(6_000_000),
              from: SIGNER,
              to: PROXY,
              blockNumber: 101,
              transactionIndex: 2,
            }
          : null,
    };
    const ix = new EventsIndexer({ db, cfg: cfgFor(), live: emptyLive(), provider, now: () => T0 });
    const row = listVaults(db)[0];
    expect(await ix.ingest(row, logs, true)).toBe(3);

    const kinds = db.all<{ kind: string; ts: number }>('SELECT kind, ts FROM chain_events ORDER BY tx_hash, log_index');
    expect(kinds.map((k) => k.kind)).toEqual(['ZeroBurn', 'Rebalance', 'Deposit']);
    expect(kinds.every((k) => k.ts === T0)).toBe(true);
    expect(db.get<{ args_json: string }>("SELECT args_json FROM chain_events WHERE kind = 'Deposit'")?.args_json).toContain('"shares":"900"');

    const txs = db.all<Record<string, unknown>>('SELECT * FROM txs');
    expect(txs).toHaveLength(1);
    expect(txs[0].kind).toBe('fold');
    expect(txs[0].cost_wei).toBe('4800000000000');
    expect(txs[0].status).toBe(1);
    expect(txs[0].tick).toBe(-13800);
    expect(txs[0].supply).toBe('7000');
    expect(txs[0].base_lower).toBe(-14400);
    expect(txs[0].fee_recipient).toBe(FEE_RECIPIENT);
    expect(txs[0].full_range).toBe(0);
    expect(txs[0].foreign_recipient).toBe(0);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events_log WHERE kind IN ('tx', 'zero-burn', 'deposit')")?.n).toBe(4);

    // idempotent: the same chunk replayed adds nothing
    expect(await ix.ingest(row, logs, false)).toBe(0);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM txs')?.n).toBe(1);
  });

  it('calls a backfilled rebalance a recenter off the previous tx, with no sample to compare', async () => {
    const db = fresh();
    seedVault(db, 100);
    const row = listVaults(db)[0];

    const run = async (hash: string, block: number, ts: number, base: [number, number]) => {
      const logs = [logOf('Rebalance', [-13800, '5000', '6000', '10', '12', '7000'], { block, hash, index: 1 })];
      const data = proxyIface.encodeFunctionData('rebalance', [VAULT, base[0], base[1], -13140, -13080, FEE_RECIPIENT, [0, 0, 0, 0], [0, 0, 0, 0]]);
      const provider: EventsProvider = {
        getBlockNumber: async () => block,
        getLogs: async () => logs,
        getBlock: async () => ({ timestamp: ts }),
        getTransaction: async () => ({ from: SIGNER, to: PROXY, data, gasPrice: ethers.BigNumber.from(1) }),
        getTransactionReceipt: async () => ({ status: 1, gasUsed: ethers.BigNumber.from(1), effectiveGasPrice: ethers.BigNumber.from(1), from: SIGNER, to: PROXY, blockNumber: block, transactionIndex: 0 }),
      };
      const idx = new EventsIndexer({ db, cfg: cfgFor(), live: emptyLive(), provider, now: () => ts });
      await idx.ingest(row, logs, false);
    };

    // nothing to compare the first one against
    await run('0x' + 'a1'.repeat(32), 101, T0 - 600, [-14400, -13200]);
    // same base as the tx before it: refresh or fold is not knowable without a sample
    await run('0x' + 'a2'.repeat(32), 102, T0 - 300, [-14400, -13200]);
    // the band moved
    await run('0x' + 'a3'.repeat(32), 103, T0, [-14460, -13260]);

    const kinds = db.all<{ kind: string }>('SELECT kind FROM txs ORDER BY ts').map((r) => r.kind);
    expect(kinds).toEqual(['unknown', 'unknown', 'recenter']);
  });

  it('classifies by the plan rule and recognises a refused range', () => {
    const sqrt = ethers.BigNumber.from(2).pow(96).toString();
    const mixed = { base: [-14400, -13200] as [number, number], limitAmt0: '1000', limitAmt1: '1000', sqrtPriceX96: sqrt };
    const oneSided = { ...mixed, limitAmt0: '0' };
    expect(limitMinLegShare(mixed)).toBeCloseTo(0.5, 12);
    expect(limitMinLegShare(oneSided)).toBe(0);
    expect(rebalanceKind(mixed, [-14400, -13200], 0.4)).toBe('fold');
    expect(rebalanceKind(oneSided, [-14400, -13200], 0.4)).toBe('refresh');
    expect(rebalanceKind(mixed, [-14460, -13260], 0.4)).toBe('recenter');
    expect(rebalanceKind(null, [-14400, -13200], 0.4)).toBe('unknown');
    expect(rebalanceKind(mixed, null, 0.4)).toBe('unknown');

    const data = proxyIface.encodeFunctionData('rebalance', [VAULT, -14400, -13200, -13140, -13080, FEE_RECIPIENT, [0, 0, 0, 0], [0, 0, 0, 0]]);
    expect(decodeRebalanceCall(data, VAULT)).toEqual({ base: [-14400, -13200], limit: [-13140, -13080], feeRecipient: FEE_RECIPIENT });
    expect(decodeRebalanceCall(data, '0x' + '99'.repeat(20))).toBeNull();
    expect(decodeRebalanceCall('0x', VAULT)).toBeNull();

    expect(isChunkError({ error: { code: -32603 } })).toBe(true);
    expect(isChunkError(Object.assign(new Error('query timeout of 10 seconds exceeded'), { code: 'SERVER_ERROR' }))).toBe(true);
    expect(isChunkError(new Error('execution reverted'))).toBe(false);
  });
});

// --- chain sampler (pure parts) --------------------------------------------------------

describe('chain sampler', () => {
  const th = (over: Partial<VaultThresholds> = {}): VaultThresholds => ({
    entrypoint: 'proxy',
    proxy: PROXY,
    admin: ADMIN,
    feeRecipient: FEE_RECIPIENT,
    clearing: '0x3541a3e5db2d611904be4f45a3cafea9a4df3e48',
    twapEnabled: true,
    twapWindowSecs: 3600,
    minTwapWindowSecs: 3000,
    maxDevTicks: 50,
    allowUnsafeSpot: false,
    oracleEnabled: true,
    oracleFeed0: '0x' + 'aa'.repeat(20),
    oracleFeed1: null,
    oracleFeed0Side: 'token0',
    oracleMaxAgeSecs: 28800,
    oracleMaxDevTicks: 50,
    foldMinShare: 0.4,
    mmDataProvider: null,
    mmUnderlying: null,
    dryRun: false,
    source: 'descriptor',
    ...over,
  });
  const gate = (over: Record<string, unknown> = {}) =>
    gateOf({
      th: th(),
      spotTick: -13800,
      twapWindowSecs: 3600,
      twapTick: -13798,
      twapError: false,
      oracleTick: -13790,
      oracleAgeSecs: 240,
      oracleError: false,
      ...over,
    } as Parameters<typeof gateOf>[0]);

  it('mirrors checkPrice: window clamp, dev order, oracle against the twap tick', () => {
    expect(gate()).toEqual({ ok: true, failedAt: null, reason: 'ok' });
    // the window is min(TWAP_WINDOW_SECS, pool history); below the floor it is a twap-history failure
    expect(gate({ twapWindowSecs: 1200, twapTick: null }).failedAt).toBe('twap-history');
    expect(gate({ twapTick: -13700 }).failedAt).toBe('twap-dev');
    expect(gate({ twapError: true }).failedAt).toBe('twap-unavailable');
    expect(gate({ oracleAgeSecs: 30000 }).failedAt).toBe('oracle-stale');
    expect(gate({ oracleTick: -13690 }).failedAt).toBe('oracle-dev');
    expect(gate({ oracleError: true, oracleTick: null }).failedAt).toBe('oracle-unreadable');
    // twap first, exactly as checkPrice short-circuits
    expect(gate({ twapTick: -13700, oracleTick: -13690 }).failedAt).toBe('twap-dev');
    // oracle deviation is measured against the twap tick, not spot
    expect(gateOf({ th: th(), spotTick: -13800, twapWindowSecs: 3600, twapTick: -13760, twapError: false, oracleTick: -13755, oracleAgeSecs: 10, oracleError: false }).ok).toBe(true);
    expect(gateOf({ th: th({ twapEnabled: false }), spotTick: 0, twapWindowSecs: null, twapTick: null, twapError: false, oracleTick: null, oracleAgeSecs: null, oracleError: false }).failedAt).toBe('spot-unsafe');
  });

  it('reads the clearing deposit gate off live thresholds', () => {
    const base = {
      paused: false,
      whitelistedAddress: '0x3541A3E5Db2d611904BE4F45A3CAFEA9A4df3e48',
      clearing: '0x3541a3e5db2d611904be4f45a3cafea9a4df3e48',
      supply: 1000n,
      maxTotalSupply: 0n,
      twapCheck: true,
      threshold: 10_100, // 1% today; the code default 10_000 would allow 0%
      ratio: 1.005,
      inBaseRange: true,
    };
    const open = depositsOf(base);
    expect(open.state).toBe('open');
    expect(open.deviationBps).toBeCloseTo(50, 6);
    expect(open.whitelisted).toBe(true);
    expect(depositsOf({ ...base, ratio: 1.012 }).state).toBe('blocked');
    expect(depositsOf({ ...base, ratio: 1.012, twapCheck: false }).state).toBe('open');
    expect(depositsOf({ ...base, paused: true }).reason).toBe('clearing paused');
    expect(depositsOf({ ...base, whitelistedAddress: '0x' + '99'.repeat(20) }).whitelisted).toBe(false);
    // mainnet whitelists the UniProxy, which holds the clearing (UniProxy.sol:36)
    const viaProxy = depositsOf({ ...base, whitelistedAddress: '0x20aA5d9ffF339c3f1ACaee792aa05c53cEb3F741', entryClearance: base.clearing });
    expect([viaProxy.whitelisted, viaProxy.state]).toEqual([true, 'open']);
    expect(depositsOf({ ...base, whitelistedAddress: '0x' + '99'.repeat(20), entryClearance: '0x' + '88'.repeat(20) }).whitelisted).toBe(false);
    expect(depositsOf({ ...base, maxTotalSupply: 1000n }).reason).toBe('supply at maxTotalSupply');
    // out of base range is a note, never a gate
    const note = depositsOf({ ...base, inBaseRange: false });
    expect([note.state, note.note]).toEqual(['open', 'out of base range']);
  });

  it('prefers the running keeper config over the descriptor, and falls back to it', () => {
    const db = fresh();
    seedVault(db, 100);
    const fromFile = thresholdsFor(db, VAULT, null);
    expect([fromFile.source, fromFile.foldMinShare, fromFile.proxy]).toEqual(['descriptor', 0.4, PROXY]);
    const fromKeeper = thresholdsFor(db, VAULT, {
      v: 1,
      source: 'VAULTS_FILE',
      descriptorSha256: null,
      global: { DRY_RUN: true },
      vaults: [{ VAULT, FOLD_MIN_SHARE: 0.25, MAX_DEV_TICKS: 50, TWAP_ENABLED: true }],
      fingerprint: 'fp-2',
    });
    expect([fromKeeper.source, fromKeeper.foldMinShare, fromKeeper.dryRun, fromKeeper.maxDevTicks]).toEqual(['keeper', 0.25, true, 50]);
    // keys the keeper's projection does not carry still come from the descriptor
    expect(fromKeeper.clearing).toBeNull();
    expect(fromKeeper.admin).toBe(ADMIN);
  });
});

describe('monitor collector', () => {
  const firing = (key: string, severity: 'info' | 'warning' | 'critical' = 'critical') => ({
    key,
    severity,
    title: `${key} title`,
    detail: `${key} detail`,
    onsetAt: new Date(T0 * 1000).toISOString(),
    lastNotifiedAt: null,
  });

  function status(over: Partial<MonitorStatus> = {}): MonitorStatus {
    return MonitorStatus.parse({
      v: 1,
      version: '0.4.0',
      rpcHost: 'rpc.example',
      bootAt: new Date((T0 - 600) * 1000).toISOString(),
      lastCycleAt: new Date(T0 * 1000).toISOString(),
      lastCycleOk: true,
      consecutiveFailures: 0,
      cycles: 7,
      stale: false,
      firing: [],
      pools: [],
      alerts: [],
      ...over,
    });
  }

  // the monitor partitions its findings — vault === null ones only appear at the top level
  it('lands the monitor top-level firing as global findings', () => {
    const db = fresh();
    seedVault(db, 0);
    const mc = new MonitorCollector({ db, baseUrl: 'http://monitor.example', pollMs: 60_000, now: () => T0 });
    mc.ingest(status({ firing: [firing('gas'), firing('monitor-rpc-failing')] }), T0);

    const rows = db.all<{ vault_id: string | null; key: string; severity: string; cleared_ts: number | null }>(
      'SELECT vault_id, key, severity, cleared_ts FROM findings ORDER BY key',
    );
    expect(rows).toEqual([
      { vault_id: null, key: 'gas', severity: 'critical', cleared_ts: null },
      { vault_id: null, key: 'monitor-rpc-failing', severity: 'critical', cleared_ts: null },
    ]);

    // and they clear when the monitor stops reporting them
    mc.ingest(status({ firing: [firing('gas', 'warning')] }), T0 + 60);
    const after = db.all<{ key: string; severity: string; cleared_ts: number | null }>(
      'SELECT key, severity, cleared_ts FROM findings ORDER BY key',
    );
    expect(after).toEqual([
      { key: 'gas', severity: 'warning', cleared_ts: null },
      { key: 'monitor-rpc-failing', severity: 'critical', cleared_ts: T0 + 60 },
    ]);
  });

  it('keeps a per-vault finding on its vault', () => {
    const db = fresh();
    seedVault(db, 0);
    const mc = new MonitorCollector({ db, baseUrl: 'http://monitor.example', pollMs: 60_000, now: () => T0 });
    mc.ingest(
      status({
        firing: [firing('gas')],
        pools: [{ id: VAULT, label: 'aDOT/HOLLAR', thresholds: {}, snapshot: null, firing: [firing('clamp-blocking', 'warning')] }],
      }),
      T0,
    );
    const rows = db.all<{ vault_id: string | null; key: string }>('SELECT vault_id, key FROM findings ORDER BY key');
    expect(rows).toEqual([
      { vault_id: VAULT, key: 'clamp-blocking' },
      { vault_id: null, key: 'gas' },
    ]);
  });
});
