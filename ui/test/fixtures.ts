import type { CycleRecord } from '@keeper/record';
import { openDb, type Db } from '../server/db/index';
import { loadConfig, type UiConfig } from '../server/config';
import type { KeeperCollectorState } from '../server/collect/keeper';
import type { MonitorCollectorState } from '../server/collect/monitor';
import type { ChainState } from '../server/contract/serialize';
import type { KeeperStatus } from '../server/contract/types';

// one fixture fleet for the contract and text tests: a gate-blocked aDOT/HOLLAR
// vault with samples, cycles, txs, events and findings, plus the three poisoned
// strings every body is checked against.

/** the sentinel signing key — never a real one, never logged */
export const SENTINEL = `0x${'ab'.repeat(32)}`;
export const CREDENTIALED_URL = 'https://user:pass@rpc.internal.test/abc?key=secret';
export const TX_HASH = '0x8f3a1c2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8c1';
export const COMPOUND_HASH = '0x1c0ea1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e';

export const VAULT_ID = '0xa206d0959813f17c17c87147271c49065438648a';
export const VAULT_LABEL = 'aDOT/HOLLAR';
export const POOL = '0x1111111111111111111111111111111111111111';
export const TOKEN0 = '0x2222222222222222222222222222222222222222';
export const TOKEN1 = '0x3333333333333333333333333333333333333333';
export const SIGNER = '0x0b0b1234567890abcdef1234567890abcdefcb96';
export const PROXY = '0x8b7dd119b7edb85d9cf166129dbec5d88dc78c94';

export const KEEPER_URL = 'http://gamma_keeper:8787';
export const MONITOR_URL = 'http://gamma_monitor:8788';
export const DB_DIR = '/tmp/gamma-ui-fixture';

export const NOW = Math.trunc(Date.now() / 1000);
export const BOOT_AT = new Date((NOW - 3600) * 1000).toISOString();

export function testConfig(over: Record<string, string> = {}): UiConfig {
  return loadConfig({
    RPC_URL: 'https://rpc.hydradx.cloud',
    HEAD_FALLBACK_URL: 'https://hdx.tarn.hydration.cloud',
    KEEPER_URL,
    MONITOR_URL,
    DB_PATH: `${DB_DIR}/gamma.db`,
    BACKUP_DIR: `${DB_DIR}/backup`,
    VAULTS_FILE: `${DB_DIR}/vaults.json`,
    METRICS_TOKEN: 'metrics-token-fixture',
    RATE_LIMIT: '1000/10s',
    PUBLIC_URL: 'https://gamma.play.hydration.cloud',
    COMMIT: 'abc1234',
    ...over,
  } as NodeJS.ProcessEnv);
}

export const DESCRIPTOR: Record<string, string | number | boolean> = {
  VAULT: VAULT_ID,
  LABEL: VAULT_LABEL,
  ENTRYPOINT: 'proxy',
  REBALANCE_PROXY: PROXY,
  REBALANCE_THRESHOLD_MULT: 11,
  BASE_HALF_WIDTH_MULT: 16,
  LIMIT_REFRESH_ENABLED: true,
  LIMIT_REFRESH_TICKS: 120,
  FOLD_ENABLED: true,
  FOLD_MIN_SHARE: 0.4,
  MIN_INTERVAL_SECS: 21600,
  DWELL_SECS: 2025,
  TWAP_ENABLED: true,
  TWAP_WINDOW_SECS: 3600,
  MIN_TWAP_WINDOW_SECS: 3000,
  MAX_DEV_TICKS: 100,
  ORACLE_ENABLED: true,
  ORACLE_MAX_AGE_SECS: 28800,
  ORACLE_MAX_DEV_TICKS: 50,
  REGIME_ENABLED: true,
  VOL_RATIO_ELEVATED: 3,
  MOVE_15M_ELEVATED: 0.02,
  MOVE_1H_EXTREME: 0.08,
  COMPOUND_ENABLED: true,
  COMPOUND_INTERVAL_SECS: 3600,
  GAS_FLOOR_WEI: '1000000000000000',
  MONITOR_CLEARING: '0x3541a3e5db2d611904be4f45a3cafea9a4df3e48',
  MONITOR_GRACE_SECS: 7200,
  UI_START_BLOCK: 14000000,
};

export function cycleRecord(over: Partial<CycleRecord> = {}): CycleRecord {
  const base: CycleRecord = {
    v: 1,
    bootAt: BOOT_AT,
    seq: 412,
    vault: { id: VAULT_ID, label: VAULT_LABEL },
    block: 14471201,
    blockTs: NOW - 120,
    tsSource: 'block',
    evaluatedAt: new Date((NOW - 120) * 1000).toISOString(),
    durationMs: 812,
    reads: { spotTick: 185062, sqrtPriceX96: '123456789012345678901234567890', base: [184860, 186840], limit: [185880, 185940], limitLiquidity: '99999999' },
    triggers: {
      rebalance: { trigger: true, reason: 'drift 788 > 660', drift: 788, thresholdTicks: 660, outside: false },
      refresh: { trigger: false, reason: 'superseded by trigger', awayTicks: 818 },
      fold: { trigger: false, reason: 'min leg 0.0% < 40%', minLegShare: 0 },
    },
    winner: 'TRIGGER',
    compoundDue: false,
    dwell: {
      rebalance: { sinceTs: NOW - 2145, heldSecs: 2025, requiredSecs: 2025, armed: true },
      refresh: { sinceTs: 0, heldSecs: 0, requiredSecs: 2025, armed: false },
      fold: { sinceTs: 0, heldSecs: 0, requiredSecs: 2025, armed: false },
    },
    cooldown: { evaluated: true, elapsedSecs: 183_600, minIntervalSecs: 21600, skipped: false },
    gate: {
      evaluated: true,
      ok: false,
      failedAt: 'oracle-dev',
      reason: 'pool 184985 vs oracle 185096 dev 111 > 50',
      via: 'skip',
      twap: { windowSecs: 3600, tick: 184985, devTicks: 77, maxDevTicks: 100 },
      oracle: { tick: 185096, ageSecs: 2238, devTicks: 111, maxDevTicks: 50 },
    },
    regime: { regime: 'calm', changed: false, reason: null, sinceTs: NOW - 86400 },
    compound: null,
    plan: null,
    tx: null,
    outcome: { code: 'gate-blocked', stage: 'gate', detail: 'skip: pool 184985 vs oracle 185096 dev 111 > 50' },
    source: 'parsed',
  };
  return { ...base, ...over };
}

export function keeperStatus(): KeeperStatus {
  return {
    v: 1,
    generatedAt: new Date(NOW * 1000).toISOString(),
    keeper: {
      version: '0.2.0',
      bootAt: BOOT_AT,
      mode: 'LIVE',
      signer: SIGNER,
      rpcHost: 'hdx.tarn.hydration.cloud',
      pollMs: 2200,
      blockTimeSecs: 2.2,
      head: { number: 14471203, ts: NOW - 4, at: new Date((NOW - 4) * 1000).toISOString() },
      busy: false,
      busySinceAt: null,
      skippedWhileBusy: 0,
      cyclesTotal: 41201,
      errorsTotal: 3,
      hookErrors: 0,
      listener: { requests: 1204, slowResponses: 0, clients: 1 },
      configFingerprint: 'fp-1',
    },
    vaults: [
      {
        id: VAULT_ID,
        label: VAULT_LABEL,
        tag: VAULT_LABEL,
        pool: POOL,
        token0: { address: TOKEN0, symbol: 'aDOT', decimals: 10 },
        token1: { address: TOKEN1, symbol: 'HOLLAR', decimals: 18 },
        tickSpacing: 60,
        entrypoint: 'proxy',
        proxy: PROXY,
        admin: '0x8fc8a0d7cb9c6b2366ec08f1bf03067d54b67bc5',
        feeRecipient: '0x6d6f646c70792f74727372790000000000000000',
        owner: '0x6d6f646c70792f74727372790000000000000000',
        dwellSecs: 2025,
        roles: { rebalancerOk: true, adminOk: true, exempted: false, deadlock: false, warnings: [] },
        state: {
          lastRebalanceTs: NOW - 183_600,
          dwell: {
            rebalance: { sinceTs: NOW - 2145, heldSecs: 2025, met: true },
            refresh: { sinceTs: 0, heldSecs: 0, met: false },
            fold: { sinceTs: 0, heldSecs: 0, met: false },
          },
          regime: { regime: 'calm', sinceTs: NOW - 86400, calmSinceTs: NOW - 86400 },
          priceTrail: { size: 240, move15mFrac: 0.004, move1hFrac: 0.021 },
          volBaseline: { median: 0.012, fetchedAtTs: NOW - 3600 },
          lastCompoundTs: NOW - 1800,
        },
        standing: { code: 'gate-blocked', subcode: 'oracle-dev', sinceTs: NOW - 7440, seq: 412 },
        last: cycleRecord(),
        ring: { size: 4096, firstSeq: 1, lastSeq: 412 },
      },
    ],
  };
}

// the keeper's whitelist projection. the sentinel sits in a config value the
// way a leaked note would: the ui learns the value here and scrubs it everywhere
export function keeperConfigBody() {
  return {
    v: 1 as const,
    source: 'env' as const,
    descriptorSha256: 'deadbeef',
    global: {
      RPC_URL: { host: 'hdx.tarn.hydration.cloud' },
      INDEXER_URL: { host: 'indexer.hydradx.cloud' },
      POLL_INTERVAL_MS: 2200,
      DRY_RUN: false,
      GAS_FLOOR_WEI: '1000000000000000',
      OPERATOR_NOTE: `rotate ${SENTINEL} after the referendum`,
    },
    vaults: [{ ...DESCRIPTOR }],
    fingerprint: 'fp-1',
  };
}

export function keeperState(over: Partial<KeeperCollectorState> = {}): KeeperCollectorState {
  return {
    configured: true,
    reachable: true,
    consecutiveFailures: 0,
    lastOkAt: NOW - 2,
    unreachableSince: null,
    detail: null,
    bootAt: BOOT_AT,
    status: keeperStatus(),
    statusAt: NOW - 2,
    config: keeperConfigBody(),
    configAt: NOW - 60,
    sse: { connected: true, lastFrameAt: NOW - 3, reconnects: 0 },
    cursors: { [VAULT_ID]: { bootAt: BOOT_AT, seq: 412 } },
    ...over,
  };
}

export function monitorState(over: Partial<MonitorCollectorState> = {}): MonitorCollectorState {
  const checkedAt = new Date((NOW - 41) * 1000).toISOString();
  return {
    configured: true,
    reachable: true,
    consecutiveFailures: 0,
    lastOkAt: NOW - 41,
    unreachableSince: null,
    detail: null,
    stale: false,
    findingsStale: false,
    status: {
      v: 1,
      version: '0.4.0',
      rpcHost: 'rpc.hydradx.cloud',
      bootAt: new Date((NOW - 7200) * 1000).toISOString(),
      lastCycleAt: checkedAt,
      lastCycleOk: true,
      consecutiveFailures: 0,
      cycles: 24,
      stale: false,
      // one signer: the real monitor publishes gas here, never per pool
      gas: { keeper: SIGNER, wei: '1720000000000000', warnWei: '2000000000000000', floorWei: '1000000000000000' },
      firing: [],
      pools: [],
      alerts: [{ at: checkedAt, severity: 'warning', title: 'gas below warn' }],
    },
    statusAt: NOW - 41,
    vaults: {
      [VAULT_ID]: {
        label: VAULT_LABEL,
        thresholds: { ORACLE_MAX_DEV_TICKS: 50, CLEARING: DESCRIPTOR.MONITOR_CLEARING },
        firing: [
          {
            key: 'clamp-blocking',
            severity: 'warning',
            title: 'oracle clamp blocking',
            detail: 'dev 111 > 50',
            onsetAt: new Date((NOW - 7440) * 1000).toISOString(),
            lastNotifiedAt: checkedAt,
          },
        ],
        snapshot: {
          checkedAt,
          gasWei: '1720000000000000',
          tick: 185062,
          base: [184860, 186840],
          limit: [185880, 185940],
          drift: 788,
          threshold: 660,
          lastRebalanceTs: NOW - 183_600,
          sinceSecs: 183_600,
          allowanceSecs: 21600,
          limitOutsideBy: 818,
          paused: false,
          feedPx: 1.0906,
          poolPx: 1.0904,
          divergenceBps: 2,
          oracleTick: 185096,
          twapTick: 184985,
          devTicks: 111,
          spotDevTicks: 34,
          feedAgeSecs: 2238,
          navToken1: 4242,
          limitValueToken1: 2221,
        },
      },
    },
    ...over,
  };
}

export function chainState(): ChainState {
  return {
    ok: true,
    head: { number: 14471204, ts: NOW - 2, at: new Date((NOW - 2) * 1000).toISOString() },
    fallbackHead: { number: 14471204, ts: NOW - 3, at: new Date((NOW - 3) * 1000).toISOString() },
    backfill: { from: 14000000, to: 14471204, done: true },
    lastSampleAtMs: (NOW - 30) * 1000,
    detail: null,
  };
}

const SUPPLY = 9813n * 10n ** 18n;

function sampleRow(ts: number, block: number, tick: number, withFees: boolean) {
  const total0 = 3_100_000_000_000n; // 310 aDOT at 10 decimals
  const total1 = 900n * 10n ** 18n;
  return {
    vault_id: VAULT_ID,
    ts,
    block,
    spot_tick: tick,
    sqrt_price_x96: '123456789012345678901234567890',
    price_human: Math.pow(1.0001, tick) * 1e-8,
    total0: total0.toString(),
    total1: total1.toString(),
    supply: SUPPLY.toString(),
    max_total_supply: (20000n * 10n ** 18n).toString(),
    nav1: 4242,
    share_price: 1.0421,
    x: 0.762,
    base_lower: 184860,
    base_upper: 186840,
    limit_lower: 185880,
    limit_upper: 185940,
    in_base: 1,
    in_limit: 0,
    base_liq: '123456789',
    base_amt0: (total0 / 2n).toString(),
    base_amt1: (total1 / 2n).toString(),
    limit_liq: '99999999',
    limit_amt0: (total0 / 2n).toString(),
    limit_amt1: (total1 / 2n).toString(),
    fees0: withFees ? '3120000000' : null,
    fees1: withFees ? (3n * 10n ** 18n).toString() : null,
    fees1_value: withFees ? 6.9 : null,
    idle0: withFees ? '1000000' : null,
    idle1: withFees ? '1000000000000000' : null,
    oracle_tick: 185096,
    oracle_price: 1.0906,
    oracle_age: 2238,
    twap_tick: 184985,
    twap_window: 3600,
    gate_ok: 0,
    gate_failed_at: 'oracle-dev',
    proxy_last_rebalance_ts: NOW - 183_600,
    gas_wei: '1720000000000000',
    pool_liq: '987654321',
    fee_divisor: 255,
    fee_protocol: 0,
    reserve_paused: 0,
    clearing_twap_check: 1,
    clearing_threshold: 10100,
    clearing_dev_bps: 20,
    deposits_open: 1,
  };
}

const INSERT_SAMPLE = `INSERT OR REPLACE INTO samples (vault_id, ts, block, spot_tick, sqrt_price_x96, price_human, total0, total1, supply, max_total_supply,
  nav1, share_price, x, base_lower, base_upper, limit_lower, limit_upper, in_base, in_limit, base_liq, base_amt0, base_amt1, limit_liq, limit_amt0, limit_amt1,
  fees0, fees1, fees1_value, idle0, idle1, oracle_tick, oracle_price, oracle_age, twap_tick, twap_window, gate_ok, gate_failed_at, proxy_last_rebalance_ts,
  gas_wei, pool_liq, fee_divisor, fee_protocol, reserve_paused, clearing_twap_check, clearing_threshold, clearing_dev_bps, deposits_open)
VALUES (:vault_id, :ts, :block, :spot_tick, :sqrt_price_x96, :price_human, :total0, :total1, :supply, :max_total_supply,
  :nav1, :share_price, :x, :base_lower, :base_upper, :limit_lower, :limit_upper, :in_base, :in_limit, :base_liq, :base_amt0, :base_amt1, :limit_liq, :limit_amt0, :limit_amt1,
  :fees0, :fees1, :fees1_value, :idle0, :idle1, :oracle_tick, :oracle_price, :oracle_age, :twap_tick, :twap_window, :gate_ok, :gate_failed_at, :proxy_last_rebalance_ts,
  :gas_wei, :pool_liq, :fee_divisor, :fee_protocol, :reserve_paused, :clearing_twap_check, :clearing_threshold, :clearing_dev_bps, :deposits_open)`;

/** an in-memory db carrying one vault with history, plus the poisoned strings */
export function seedDb(): Db {
  const db = openDb(':memory:');
  db.run(
    `INSERT INTO vaults (id, label, pool, token0, token1, dec0, dec1, sym0, sym1, tick_spacing, entrypoint, start_block, first_seen_at, descriptor_json)
     VALUES (:id, :label, :pool, :t0, :t1, 10, 18, 'aDOT', 'HOLLAR', 60, 'proxy', 14000000, :seen, :desc)`,
    { id: VAULT_ID, label: VAULT_LABEL, pool: POOL, t0: TOKEN0, t1: TOKEN1, seen: NOW - 9 * 86400, desc: JSON.stringify(DESCRIPTOR) },
  );
  db.metaSetJson('descriptor_order', [VAULT_ID]);
  db.metaSet('descriptor_sha256', 'deadbeefcafe');
  db.metaSetJson('keeper:config', keeperConfigBody());
  db.metaSet('keeper:config_at', String(NOW - 60));

  for (let i = 60; i >= 0; i--) {
    const ts = NOW - i * 60;
    db.run(INSERT_SAMPLE, sampleRow(ts - (ts % 60), 14471204 - i * 30, 185062 - i, i % 5 === 0));
  }

  const rec = cycleRecord();
  db.run(
    `INSERT INTO cycles_raw (vault_id, boot_at, seq, block, block_ts, received_at, record_json)
     VALUES (:v, :b, :s, :blk, :bts, :r, :json)`,
    { v: VAULT_ID, b: BOOT_AT, s: rec.seq, blk: rec.block, bts: rec.blockTs, r: rec.blockTs, json: JSON.stringify(rec) },
  );
  for (let i = 0; i < 5; i++) {
    const r = cycleRecord({ seq: 400 + i, block: 14471180 + i, blockTs: NOW - 600 + i * 60 });
    db.run(
      `INSERT INTO cycles (vault_id, boot_at, seq, block, block_ts, evaluated_at, outcome_code, stage, winner, spot_tick,
        base_lower, base_upper, limit_lower, limit_upper, drift_ticks, armed_mask, dwell_reb_secs, dwell_ref_secs, dwell_fold_secs,
        cooldown_remaining_secs, gate_ok, gate_failed_at, gate_via, twap_tick, twap_dev, oracle_tick, oracle_dev, oracle_age, regime,
        compound_result, tx_hash, error, source, is_transition, record_json)
       VALUES (:v, :b, :s, :blk, :bts, :bts, 'gate-blocked', 'gate', 'TRIGGER', 185062,
        184860, 186840, 185880, 185940, 788, 1, 2025, 0, 0,
        0, 0, 'oracle-dev', 'skip', 184985, 77, 185096, 111, 2238, 'calm',
        NULL, NULL, NULL, 'parsed', :t, :json)`,
      { v: VAULT_ID, b: BOOT_AT, s: r.seq, blk: r.block, bts: r.blockTs, t: i === 0 ? 1 : 0, json: JSON.stringify(r) },
    );
  }

  db.run(
    `INSERT INTO episodes (vault_id, code, subcode, since_ts, until_ts, first_seq, last_seq, cycles, detail)
     VALUES (:v, 'gate-blocked', 'oracle-dev', :since, NULL, 380, 412, 33, 'dev 111 > 50')`,
    { v: VAULT_ID, since: NOW - 7440 },
  );
  db.run(
    `INSERT INTO episodes (vault_id, code, subcode, since_ts, until_ts, first_seq, last_seq, cycles, detail)
     VALUES (:v, 'hold', NULL, :since, :until, 1, 379, 379, 'in range')`,
    { v: VAULT_ID, since: NOW - 86400, until: NOW - 7440 },
  );

  db.run(
    `INSERT INTO txs (hash, vault_id, kind, block, ts, from_addr, gas_used, gas_price_wei, cost_wei, status, tick,
      total0, total1, supply, base_lower, base_upper, limit_lower, limit_upper, fee_recipient, full_range, foreign_recipient, plan_json, receipt_json)
     VALUES (:h, :v, 'recenter', 14392110, :ts, :signer, 815000, '6000000000', '4890000000000', 1, 184950,
      '3100000000000', '900000000000000000000', :supply, 184860, 186840, 185880, 185940, :fee, 0, 0, NULL, NULL)`,
    { h: TX_HASH, v: VAULT_ID, ts: NOW - 2 * 86400, signer: SIGNER, supply: SUPPLY.toString(), fee: '0x6d6f646c70792f74727372790000000000000000' },
  );
  db.run(
    `INSERT INTO txs (hash, vault_id, kind, block, ts, from_addr, gas_used, gas_price_wei, cost_wei, status, tick,
      total0, total1, supply, base_lower, base_upper, limit_lower, limit_upper, fee_recipient, full_range, foreign_recipient, plan_json, receipt_json)
     VALUES (:h, :v, 'compound', 14466912, :ts, :signer, 643000, '6000000000', '3858000000000', 1, 185010,
      '3100000000000', '900000000000000000000', :supply, 184860, 186840, 185880, 185940, :fee, 0, 0, NULL, NULL)`,
    { h: COMPOUND_HASH, v: VAULT_ID, ts: NOW - 3600, signer: SIGNER, supply: SUPPLY.toString(), fee: '0x6d6f646c70792f74727372790000000000000000' },
  );

  db.run(
    `INSERT INTO chain_events (tx_hash, log_index, vault_id, block, ts, kind, args_json)
     VALUES (:h, 3, :v, 14392110, :ts, 'ZeroBurn', :args)`,
    { h: TX_HASH, v: VAULT_ID, ts: NOW - 2 * 86400, args: JSON.stringify({ fee: 255, fees0: '3120000000', fees1: '3000000000000000000' }) },
  );
  db.run(
    `INSERT INTO chain_events (tx_hash, log_index, vault_id, block, ts, kind, args_json)
     VALUES (:h, 4, :v, 14392100, :ts, 'Deposit', :args)`,
    {
      h: COMPOUND_HASH,
      v: VAULT_ID,
      ts: NOW - 3 * 86400,
      args: JSON.stringify({ sender: SIGNER, to: SIGNER, shares: '1000000000000000000', amount0: '1000000000', amount1: '1000000000000000000' }),
    },
  );

  db.run(
    `INSERT INTO findings (vault_id, source, key, severity, title, detail, onset_ts, last_seen_ts, cleared_ts)
     VALUES (:v, 'monitor', 'clamp-blocking', 'warning', 'oracle clamp blocking', :detail, :onset, :seen, NULL)`,
    { v: VAULT_ID, detail: `dev 111 > 50 (reported by ${MONITOR_URL})`, onset: NOW - 7440, seen: NOW - 41 },
  );
  db.run(
    `INSERT INTO findings (vault_id, source, key, severity, title, detail, onset_ts, last_seen_ts, cleared_ts)
     VALUES (NULL, 'ui', 'chain-rpc-shared', 'info', 'ui and keeper share an rpc provider', :detail, :onset, :seen, NULL)`,
    { detail: `keeper polls ${CREDENTIALED_URL}`, onset: NOW - 600, seen: NOW - 10 },
  );

  const lines = [
    `#14471201 tick=185062 base=[184860,186840] TRIGGER — drift 788 > 660`,
    `skip: pool 184985 vs oracle 185096 dev 111 > 50`,
    `✓ rebalanced — ${TX_HASH}`,
    `warn: rpc ${CREDENTIALED_URL} slow`,
    `boot: signer key ${SENTINEL} loaded`,
    `error: SERVER_ERROR url="${CREDENTIALED_URL}" requestBody="{}"`,
  ];
  lines.forEach((line, i) => db.run('INSERT INTO keeper_lines (vault_id, ts, line) VALUES (:v, :ts, :l)', { v: VAULT_ID, ts: NOW - 600 + i, l: line }));

  for (let i = 0; i < 8; i++) {
    db.run('INSERT INTO events_log (ts, vault_id, kind, ref_id, payload_json) VALUES (:ts, :v, :k, :r, :p)', {
      ts: NOW - 300 + i * 30,
      v: VAULT_ID,
      k: i % 3 === 0 ? 'cycle' : i % 3 === 1 ? 'finding' : 'tx',
      r: String(400 + i),
      p: JSON.stringify({ seq: 400 + i, note: `line ${i}`, hash: TX_HASH }),
    });
  }

  db.run('INSERT INTO source_health (source, since_ts, until_ts, reachable, detail) VALUES (:s, :since, NULL, 1, NULL)', { s: 'keeper', since: NOW - 3600 });
  db.run('INSERT INTO keeper_runs (boot_at, version, signer, dry_run, config_fingerprint, public_config_json, last_seen_at) VALUES (:b, :v, :s, 0, :f, :j, :t)', {
    b: BOOT_AT,
    v: '0.2.0',
    s: SIGNER,
    f: 'fp-1',
    j: JSON.stringify(keeperConfigBody()),
    t: NOW - 2,
  });
  db.run(
    `INSERT INTO samples_1h (vault_id, ts, n, price_last, nav1_last, share_price_last, share_price_min, share_price_max, x_avg, in_base_frac, in_limit_frac, fees1_value_last, gas_wei_last)
     VALUES (:v, :ts, 60, 1.0906, 4242, 1.0421, 1.04, 1.05, 0.76, 0.91, 0.38, 6.9, '1720000000000000')`,
    { v: VAULT_ID, ts: NOW - (NOW % 3600) - 3600 },
  );
  return db;
}

/** every string no body may contain */
export function poisons(cfg: UiConfig): string[] {
  return [SENTINEL, SENTINEL.slice(2), SENTINEL.toUpperCase(), 'user:pass', KEEPER_URL, MONITOR_URL, 'gamma_keeper', 'gamma_monitor', cfg.DB_PATH, cfg.BACKUP_DIR];
}
