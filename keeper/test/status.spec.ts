import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { once } from 'node:events';
import { ethers } from 'ethers';
import { ERC20_ABI, HYPERVISOR_ABI, POOL_ABI, REBALANCE_PROXY_ABI } from '../src/abis';
import type { Chain, VaultCtx } from '../src/chain';
import { GLOBAL_KEYS, VAULT_KEYS, loadKeeperConfig, type Config, type GlobalConfig } from '../src/config';
import { startKeeper } from '../src/keeper';
import { addTee, log, logTagged } from '../src/log';
import { CycleRecord, OUTCOME_CODES, type OutcomeCode } from '../src/record';
import { blankState } from '../src/state';
import {
  PUBLIC_GLOBAL_KEYS,
  PUBLIC_VAULT_KEYS,
  createStatus,
  hostOf,
  status,
  type StatusInstance,
  type StatusOpts,
} from '../src/status';

// the sentinel is a real key: an ethers.Wallet is built from it, so anything
// that serialises the signer serialises this exact string. it must never reach
// a ring, a response body or the sse stream, in any casing, with or without 0x.
const SENTINEL = '0x' + 'ab'.repeat(32);
// a credentialed rpc url, the shape ethers embeds in SERVER_ERROR messages
const RPC = 'https://user:pass@rpc.internal.test/path?key=x';
const INDEXER = 'https://indexer:hunter2@indexer.internal.test/graphql?token=t';
const RPC_HOST = 'rpc.internal.test';

const VAULT_A = '0x' + 'aa'.repeat(20);
const VAULT_B = '0x' + 'bb'.repeat(20);
const PROXY = '0x' + 'cc'.repeat(20);
const ADMIN = '0x' + 'dd'.repeat(20);
const TREASURY = '0x' + 'ee'.repeat(20);
const FEED = '0x' + '11'.repeat(20);
const MM = '0x' + '22'.repeat(20);
const UNDERLYING = '0x' + '33'.repeat(20);
const POOL = '0x' + '44'.repeat(20);
const T0 = '0x' + '55'.repeat(20);
const T1 = '0x' + '66'.repeat(20);
const OWNER = '0x' + '77'.repeat(20);

// a real 64-hex tx hash: it must SURVIVE redaction everywhere but /config
const HASH = '0x' + 'cd'.repeat(32);
const TS = 1_700_000_000;

const LABEL_A = 'aDOT/HOLLAR';
const LABEL_B = 'tBTC/HOLLAR';

let saved: NodeJS.ProcessEnv;
const live: StatusInstance[] = [];

beforeEach(() => {
  saved = { ...process.env };
  for (const k of [...GLOBAL_KEYS, ...VAULT_KEYS, 'VAULTS_JSON', 'VAULTS_FILE', 'PRIVATE_KEY_FILE'])
    delete process.env[k];
  Object.assign(process.env, {
    PRIVATE_KEY: SENTINEL,
    RPC_URL: RPC,
    INDEXER_URL: INDEXER,
    DRY_RUN: 'false',
    FEE_RECIPIENT: TREASURY,
    ENTRYPOINT: 'proxy',
    REBALANCE_PROXY: PROXY,
    MIN_INTERVAL_SECS: '21600',
    MAX_DEV_TICKS: '100',
    ORACLE_ENABLED: 'true',
    ORACLE_FEED0: FEED,
    ORACLE_MAX_DEV_TICKS: '50',
    COMPOUND_ENABLED: 'true',
    ADMIN_ADDRESS: ADMIN,
    REGIME_ENABLED: 'true',
    MM_DATA_PROVIDER: MM,
    MM_UNDERLYING: UNDERLYING,
    VAULTS_JSON: JSON.stringify([
      { VAULT: VAULT_A, LABEL: LABEL_A },
      { VAULT: VAULT_B, LABEL: LABEL_B },
    ]),
  });
  // the keeper prints every fixture line; keep the test output readable
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  for (const inst of live) {
    await inst.close();
    inst.uninstall();
  }
  live.length = 0;
  vi.restoreAllMocks();
  process.env = saved;
});

// ---------------------------------------------------------------------------
// harness: a real Wallet and real Contracts on a credentialed provider, so the
// redaction tests have something genuinely dangerous to serialise
// ---------------------------------------------------------------------------

interface Harness {
  inst: StatusInstance;
  global: GlobalConfig;
  chain: Chain;
  vaults: VaultCtx[];
}

function vaultCtx(chain: Chain, cfg: Config): VaultCtx {
  const ctx: VaultCtx = {
    chain,
    id: cfg.VAULT.toLowerCase(),
    label: cfg.LABEL!,
    cfg,
    vault: new ethers.Contract(cfg.VAULT, HYPERVISOR_ABI, chain.signer),
    pool: new ethers.Contract(POOL, POOL_ABI, chain.provider),
    token0: new ethers.Contract(T0, ERC20_ABI, chain.provider),
    token1: new ethers.Contract(T1, ERC20_ABI, chain.provider),
    proxy: new ethers.Contract(cfg.REBALANCE_PROXY!, REBALANCE_PROXY_ABI, chain.signer),
    tickSpacing: 60,
    decimals0: 10,
    decimals1: 18,
    symbol0: 'aDOT',
    symbol1: 'HOLLAR',
    owner: OWNER,
    feeRecipient: cfg.FEE_RECIPIENT!,
    dwellSecs: 2025,
    state: blankState(),
    tag: cfg.LABEL!,
    log: (msg: string) => logTagged(ctx.tag, msg),
  };
  return ctx;
}

function harness(opts: StatusOpts = {}): Harness {
  const { global, vaults: cfgs } = loadKeeperConfig();
  // an explicit network keeps the constructor from reaching for the chain
  const provider = new ethers.providers.JsonRpcProvider(global.RPC_URL, { name: 'test', chainId: 31337 });
  const signer = new ethers.Wallet(global.PRIVATE_KEY, provider);
  const chain: Chain = { cfg: global, provider, signer };
  const vaults = cfgs.map((cfg) => vaultCtx(chain, cfg));
  const inst = createStatus(global, chain, vaults, opts).install();
  live.push(inst);
  return { inst, global, chain, vaults };
}

/** one evaluate() pass, driven through the module facade the keeper calls */
function runCycle(v: VaultCtx, block: number, lines: string[], blockTs = TS): void {
  status.head(block, false);
  status.cycleStart(block, blockTs);
  for (const l of lines) v.log(l);
  status.cycleEnd(block);
}

/** the same, without the console: for the thousands-of-records bounds tests */
function quickCycles(inst: StatusInstance, v: VaultCtx, n: number, from = 1): void {
  for (let i = 0; i < n; i++) {
    const block = from + i;
    inst.onCycleStart(block, TS + i);
    inst.onLine(v.tag, `#${block} tick=185062 base=[184860,186840] hold — in range (drift 219 <= 660)`);
    inst.onCycleEnd(block);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!pred() && Date.now() < until) await sleep(10);
}

interface Res {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function fetchText(port: number, path: string, opts: http.RequestOptions = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, ...opts }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function openSse(port: number, headers: Record<string, string> = {}) {
  const req = http.request({ host: '127.0.0.1', port, path: '/events', headers });
  req.on('error', () => {});
  req.end();
  const [res] = (await once(req, 'response')) as [http.IncomingMessage];
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (c) => (body += c));
  return { req, res, body: () => body, frames: () => body.split('event: cycle').length - 1 };
}

// ---------------------------------------------------------------------------
// the branch grammar (keeper.ts:449-626, compound.ts:59-65) as it is printed
// ---------------------------------------------------------------------------

const SUMMARY_HOLD = '#101 tick=185062 base=[184860,186840] hold — in range (drift 219 <= 660)';
const SUMMARY_TRIGGER = '#101 tick=185662 base=[184860,186840] TRIGGER — drift 788 > threshold 660';
const SUMMARY_COMPOUND = '#101 tick=185062 base=[184860,186840] hold +compound-due — in range (drift 219 <= 660)';
const SUMMARY_TRIGGER_COMPOUND =
  '#101 tick=185662 base=[184860,186840] TRIGGER +compound-due — drift 788 > threshold 660';
const TWAP_OK = '  twap ok: spot 185062 vs TWAP(3600s) 184985 (dev 77)';
const ORACLE_OK = '  oracle ok: pool 184985 vs oracle 185019 (dev 34, age 238s)';
const COOLDOWN_SKIP = '  skip: min interval (120s < 21600s)';
const ORACLE_DEV = 'pool 184985 vs oracle 185096 dev 111 > 50';
const OPERATOR_ACTION =
  '  OPERATOR ACTION: the keeper cannot pull liquidity — Admin.pullLiquidity is\n' +
  '    onlyRebalancer and the RebalanceProxy holds that role. To pull, the Admin\n' +
  '    holder (governance) must: 1) Admin.setRebalancer(vault, <signer>)\n' +
  '    2) Admin.pullLiquidity(vault, ...) 3) Admin.setRebalancer(vault, <proxy>)';

interface Fixture {
  code: OutcomeCode;
  what: string;
  lines: string[];
  check?: (rec: CycleRecord) => void;
}

const FIXTURES: Fixture[] = [
  {
    code: 'hold',
    what: 'nothing due',
    lines: [SUMMARY_HOLD],
    check: (r) => {
      expect(r.winner).toBe('hold');
      expect(r.triggers!.rebalance.drift).toBe(219);
      expect(r.triggers!.rebalance.thresholdTicks).toBe(660);
      expect(r.gate).toBeNull();
      expect(r.outcome.stage).toBe('triggers');
    },
  },
  {
    code: 'arming',
    what: 'the dwell is still counting',
    lines: [SUMMARY_TRIGGER, '  arming trigger: held 12s / 2025s'],
    check: (r) => {
      expect(r.winner).toBe('TRIGGER');
      expect(r.outcome.detail).toBe('trigger: held 12s / 2025s');
      expect(r.gate).toBeNull();
    },
  },
  {
    code: 'cooldown',
    what: 'armed, inside the min interval',
    lines: [SUMMARY_TRIGGER, COOLDOWN_SKIP],
    check: (r) => {
      expect(r.cooldown).toEqual({ evaluated: true, elapsedSecs: 120, minIntervalSecs: 21600, skipped: true });
      expect(r.gate).toBeNull();
    },
  },
  {
    code: 'compound-only',
    what: 'the cooldown skip is carried past 485 by compoundDue',
    lines: [
      SUMMARY_TRIGGER_COMPOUND,
      COOLDOWN_SKIP,
      TWAP_OK,
      ORACLE_OK,
      '  compound: sweeping idle 0/0 + fees owed 12/34',
      `  compound submitted ${HASH}`,
      '  ✓ compounded',
    ],
    check: (r) => {
      // the precedence case: a cooldown skip AND compound due exits at :520
      expect(r.cooldown!.skipped).toBe(true);
      expect(r.compound).toEqual({ allowed: true, reason: 'sweeping idle 0/0 + fees owed 12/34', submitted: HASH, landed: true });
      expect(r.gate!.ok).toBe(true);
      expect(r.gate!.twap).toEqual({ windowSecs: 3600, tick: 184985, devTicks: 77, maxDevTicks: 100 });
      expect(r.gate!.oracle).toEqual({ tick: 185019, ageSecs: 238, devTicks: 34, maxDevTicks: 50 });
      expect(r.tx).toBeNull();
    },
  },
  {
    code: 'no-regime-feed-unreadable',
    what: 'the feed is unreadable and the regime machine is off',
    lines: [SUMMARY_TRIGGER, '  oracle unreadable and REGIME_ENABLED=false — refusing both actions'],
    check: (r) => {
      expect(r.gate!.failedAt).toBe('oracle-unreadable');
      expect(r.gate!.via).toBeNull();
      expect(r.outcome.stage).toBe('regime');
    },
  },
  {
    code: 'regime-extreme',
    what: 'the multi-line OPERATOR ACTION block follows the skip',
    lines: [SUMMARY_TRIGGER, TWAP_OK, ORACLE_OK, '  skip: regime EXTREME', OPERATOR_ACTION],
    check: (r) => {
      expect(r.outcome.detail).toBe('skip: regime EXTREME');
      expect(r.gate!.ok).toBe(true);
    },
  },
  {
    code: 'gate-blocked',
    what: 'the oracle clamp refuses on the armed path',
    lines: [SUMMARY_TRIGGER, TWAP_OK, `  skip: ${ORACLE_DEV}`],
    check: (r) => {
      expect(r.gate!.failedAt).toBe('oracle-dev');
      expect(r.gate!.via).toBe('skip');
      expect(r.gate!.oracle).toEqual({ tick: 185096, ageSecs: null, devTicks: 111, maxDevTicks: 50 });
    },
  },
  {
    code: 'gas-floor',
    what: 'the signer is out of gas',
    lines: [SUMMARY_TRIGGER, TWAP_OK, ORACLE_OK, '  skip: gas (WETH) balance 0.0009 below floor'],
  },
  {
    code: 'clamp-unworkable',
    what: 'the proxy translation cap cannot be walked',
    lines: [
      SUMMARY_TRIGGER,
      TWAP_OK,
      ORACLE_OK,
      '  skip: translation cap 100 is not workable with tick spacing 60 (needs > 2×spacing); raise the cap on the RebalanceProxy',
    ],
  },
  {
    code: 'width-cap',
    what: 'the width change exceeds the proxy cap',
    lines: [
      SUMMARY_TRIGGER,
      TWAP_OK,
      ORACLE_OK,
      '  skip: width delta 420 exceeds proxy maxWidth 300 — align BASE_HALF_WIDTH_MULT with governance caps',
    ],
  },
  {
    code: 'dry-run',
    what: 'a clamped plan that is never sent',
    lines: [
      SUMMARY_TRIGGER,
      TWAP_OK,
      ORACLE_OK,
      '  clamp: walking band toward target within maxTranslation 800',
      '  plan: base=[184500,186900] limit=[185100,185160] surplus=above tol=1000bps',
      '  DRY_RUN: not sending',
    ],
    check: (r) => {
      expect(r.plan).toEqual({
        kind: 'recenter',
        base: [184500, 186900],
        limit: [185100, 185160],
        side: 'above',
        tolBps: 1000,
        clamped: true,
      });
    },
  },
  {
    code: 'preflight-revert',
    what: 'the call reverts before it is signed',
    lines: [
      SUMMARY_TRIGGER,
      TWAP_OK,
      ORACLE_OK,
      '  plan: base=[184500,186900] limit=[185100,185160] surplus=above tol=1000bps',
      '  skip: preflight revert — execution reverted: price slippage check',
    ],
  },
  {
    code: 'landed',
    what: 'a rebalance confirms',
    lines: [
      SUMMARY_TRIGGER,
      TWAP_OK,
      ORACLE_OK,
      '  plan: base=[184500,186900] limit=[185100,185160] surplus=above tol=1000bps',
      '  submitting rebalance via RebalanceProxy…',
      `  ✓ rebalanced — ${HASH}`,
    ],
    check: (r) => {
      expect(r.tx).toEqual({ hash: HASH, kind: 'recenter' });
      expect(r.outcome.stage).toBe('submit');
    },
  },
  {
    code: 'error',
    what: 'evaluate() threw and startKeeper caught it per vault',
    lines: ['#101 error: call revert exception (method="slot0()", data="0x")'],
    check: (r) => {
      expect(r.outcome.detail).toMatch(/call revert exception/);
      expect(r.reads).toBeNull();
      expect(r.winner).toBeNull();
    },
  },
];

describe('parser: every outcome code', () => {
  for (const f of FIXTURES) {
    it(`${f.code} — ${f.what}`, () => {
      const h = harness();
      runCycle(h.vaults[0], 101, f.lines);
      const rec = h.inst.snapshot().vaults[0].last!;
      CycleRecord.parse(rec); // the record the ui consumes must validate
      expect(rec.outcome.code).toBe(f.code);
      expect(rec.source).toBe('parsed');
      expect(rec.vault).toEqual({ id: VAULT_A.toLowerCase(), label: LABEL_A });
      f.check?.(rec);
    });
  }

  it('leaves no OutcomeCode unexercised', () => {
    expect(new Set(FIXTURES.map((f) => f.code))).toEqual(new Set(OUTCOME_CODES));
  });
});

describe('parser: the compound-only precedence cases', () => {
  it('reports a gate failure seen only through `compound skipped:`', () => {
    const h = harness();
    runCycle(h.vaults[0], 101, [SUMMARY_COMPOUND, `  compound skipped: ${ORACLE_DEV}`]);
    const rec = h.inst.snapshot().vaults[0].last!;
    expect(rec.outcome.code).toBe('compound-only');
    expect(rec.gate).toMatchObject({ ok: false, failedAt: 'oracle-dev', via: 'compound-skipped' });
    expect(rec.compound).toMatchObject({ allowed: false, landed: false, submitted: null });
    // ...and the standing still forms one gate-blocked episode
    expect(h.inst.snapshot().vaults[0].standing).toMatchObject({ code: 'gate-blocked', subcode: 'oracle-dev' });
  });

  it('keeps a regime refusal on the compound, not on the gate', () => {
    const h = harness();
    runCycle(h.vaults[0], 101, [
      SUMMARY_COMPOUND,
      TWAP_OK,
      ORACLE_OK,
      '  compound skipped: regime ELEVATED — not sweeping into a disturbed pool',
    ]);
    const rec = h.inst.snapshot().vaults[0].last!;
    expect(rec.outcome.code).toBe('compound-only');
    expect(rec.gate!.ok).toBe(true);
    expect(rec.compound!.allowed).toBe(false);
    expect(h.inst.snapshot().vaults[0].standing!.code).toBe('compound-only');
  });

  it('an armed skip beats compound-only', () => {
    const h = harness();
    runCycle(h.vaults[0], 101, [SUMMARY_TRIGGER_COMPOUND, TWAP_OK, `  skip: ${ORACLE_DEV}`]);
    const rec = h.inst.snapshot().vaults[0].last!;
    expect(rec.outcome.code).toBe('gate-blocked');
    expect(rec.compoundDue).toBe(true);
  });

  it('a landed tx beats every skip printed before it', () => {
    const h = harness();
    runCycle(h.vaults[0], 101, [
      SUMMARY_TRIGGER_COMPOUND,
      '  compound skipped: nothing to sweep',
      TWAP_OK,
      ORACLE_OK,
      `  ✓ limit refreshed — ${HASH}`,
    ]);
    const rec = h.inst.snapshot().vaults[0].last!;
    expect(rec.outcome.code).toBe('landed');
    expect(rec.tx).toEqual({ hash: HASH, kind: 'refresh' });
  });
});

describe('parser: the rest of the grammar', () => {
  it('records a regime transition and the fold trigger numbers', () => {
    const h = harness();
    runCycle(h.vaults[0], 101, [
      '#101 tick=185062 base=[184860,186840] FOLD — limit is 44.0/56.0 mixed (>= 40% min leg) — fold conversion into base',
      TWAP_OK,
      ORACLE_OK,
      '  *** REGIME -> ELEVATED: 1h vol 3.4x the 30d median ***',
      '  regime elevated — widening band to mult 30 (from 10)',
      '  plan (fold at balance, base unchanged): base=[184500,186900] limit=[185100,185160] surplus=below tol=1000bps',
      '  DRY_RUN: not sending',
    ]);
    const rec = h.inst.snapshot().vaults[0].last!;
    expect(rec.winner).toBe('FOLD');
    expect(rec.triggers!.fold.minLegShare).toBeCloseTo(0.44, 6);
    expect(rec.regime).toMatchObject({ changed: true, reason: '1h vol 3.4x the 30d median' });
    expect(rec.plan!.kind).toBe('fold');
  });

  it('pulls the numbers out of a twap deviation failure', () => {
    const h = harness();
    runCycle(h.vaults[0], 101, [SUMMARY_TRIGGER, '  skip: spot 185662 vs TWAP(3600s) 184985 dev 677 > 100']);
    const rec = h.inst.snapshot().vaults[0].last!;
    expect(rec.outcome.code).toBe('gate-blocked');
    expect(rec.gate!.failedAt).toBe('twap-dev');
    expect(rec.gate!.twap).toEqual({ windowSecs: 3600, tick: 184985, devTicks: 677, maxDevTicks: 100 });
  });

  it('keys lines on the tag, so two vaults never mix', () => {
    const h = harness();
    status.head(101, false);
    status.cycleStart(101, TS);
    h.vaults[0].log(SUMMARY_TRIGGER);
    h.vaults[0].log(COOLDOWN_SKIP);
    h.vaults[1].log(SUMMARY_HOLD);
    status.cycleEnd(101);
    const [a, b] = h.inst.snapshot().vaults;
    expect(a.last!.outcome.code).toBe('cooldown');
    expect(b.last!.outcome.code).toBe('hold');
    expect(a.last!.vault.label).toBe(LABEL_A);
    expect(b.last!.vault.label).toBe(LABEL_B);
  });

  it('holds one standing across a run of identical cycles', () => {
    const h = harness();
    for (const block of [101, 102, 103]) {
      runCycle(h.vaults[0], block, [SUMMARY_TRIGGER.replace('#101', `#${block}`), `  skip: ${ORACLE_DEV}`], TS + block);
    }
    const v = h.inst.snapshot().vaults[0];
    expect(v.standing).toMatchObject({ code: 'gate-blocked', subcode: 'oracle-dev', seq: 1, sinceTs: TS + 101 });
    expect(v.ring.lastSeq).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------

function assertClean(label: string, s: string): void {
  const bare = SENTINEL.slice(2);
  for (const needle of [SENTINEL, SENTINEL.toUpperCase(), bare, bare.toUpperCase(), 'user:pass', 'hunter2', '/path', '?key=', 'graphql'])
    expect(`${label}:${s}`).not.toContain(needle);
}

describe('redaction is by value, not by shape', () => {
  it('scrubs the key in every casing, with and without 0x, out of the line ring', () => {
    const h = harness();
    const bare = SENTINEL.slice(2);
    h.vaults[0].log(`  key ${SENTINEL} bare ${bare} upper ${SENTINEL.toUpperCase()} mixed 0x${bare.toUpperCase()}`);
    const lines = h.inst.logLines(VAULT_A.toLowerCase(), null)!;
    expect(lines).toHaveLength(1);
    assertClean('ring', lines[0]);
    expect(lines[0].match(/\[redacted\]/g)).toHaveLength(4);
  });

  it('reduces a credentialed rpc url to its host', () => {
    const h = harness();
    h.vaults[0].log(`  rpc          ${RPC}  (~2.25s/block)`);
    h.vaults[0].log(`  indexer      ${INDEXER}`);
    const lines = h.inst.logLines(VAULT_A.toLowerCase(), null)!;
    assertClean('banner', lines.join('\n'));
    expect(lines[0]).toContain(RPC_HOST);
    expect(lines[1]).toContain('indexer.internal.test');
  });

  it('scrubs an ethers SERVER_ERROR that embeds the url and the request body', async () => {
    const h = harness();
    const port = await h.inst.listen(0, '127.0.0.1');
    const sse = await openSse(port);
    await waitFor(() => sse.body().includes('retry:'));
    runCycle(h.vaults[0], 101, [SUMMARY_HOLD]);
    runCycle(
      h.vaults[0],
      102,
      [`#102 error: processing response error (body="{}", url="https://user:secret@other.internal.test/rpc", requestBody="{\\"key\\":\\"${SENTINEL}\\"}")`],
      TS + 1,
    );
    const rec = h.inst.snapshot().vaults[0].last!;
    assertClean('record', JSON.stringify(rec));
    expect(rec.outcome.detail).not.toContain('user:secret');

    // the negative control: redaction rewrites url="…", so it must never run on
    // a serialised body — every one of these is still parseable json
    const st = await fetchText(port, '/status');
    assertClean('/status', st.body);
    expect(st.body).not.toContain('user:secret');
    expect(() => JSON.parse(st.body)).not.toThrow();

    const cycles = await fetchText(port, `/vaults/${VAULT_A.toLowerCase()}/cycles`);
    assertClean('/cycles', cycles.body);
    expect(cycles.body).not.toContain('user:secret');
    expect(JSON.parse(cycles.body).items).toHaveLength(2);

    const text = await fetchText(port, `/vaults/${VAULT_A.toLowerCase()}/log`);
    assertClean('/log', text.body);
    expect(text.body).not.toContain('user:secret');

    await waitFor(() => sse.frames() >= 2);
    const frames = sse
      .body()
      .split('event: cycle')
      .slice(1)
      .map((f) => f.slice(f.indexOf('data: ') + 'data: '.length, f.indexOf('\n\n')));
    expect(frames).toHaveLength(2);
    for (const f of frames) {
      assertClean('sse frame', f);
      expect(() => JSON.parse(f)).not.toThrow();
    }
    sse.req.destroy();
  });

  it('stamps every physical line of a multi-line ctx.log()', () => {
    const h = harness();
    h.vaults[0].log('  ⚠ DEADLOCK: band width 2400 -> 3660\n    Fix: raise maxWidth to >= 1260');
    const lines = h.inst.logLines(VAULT_A.toLowerCase(), '1')!;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] {5}Fix: /);
  });

  it('never lets the signer key reach snapshot() or publicConfig()', () => {
    const h = harness();
    runCycle(h.vaults[0], 101, [SUMMARY_HOLD]);
    assertClean('snapshot', JSON.stringify(h.inst.snapshot()));
    const cfg = h.inst.publicConfig();
    assertClean('config', JSON.stringify(cfg));
    expect(Object.keys(cfg.global)).not.toContain('PRIVATE_KEY');
    expect(cfg.global.RPC_URL).toEqual({ host: RPC_HOST });
    expect(cfg.vaults).toHaveLength(2);
    expect(cfg.vaults[0].LABEL).toBe(LABEL_A);
    expect(cfg.source).toBe('VAULTS_JSON');
  });

  it('keeps a real 64-hex tx hash alive in the ring and in /cycles', () => {
    const h = harness();
    runCycle(h.vaults[0], 101, [SUMMARY_TRIGGER, TWAP_OK, ORACLE_OK, `  ✓ rebalanced — ${HASH}`]);
    expect(h.inst.logLines(VAULT_A.toLowerCase(), null)!.join('\n')).toContain(HASH);
    expect(h.inst.cycles(VAULT_A.toLowerCase(), null, null, null)!).toContain(HASH);
  });

  it('applies the 64-hex shape rule to /config only', () => {
    const h = harness();
    expect(JSON.stringify(h.inst.publicConfig())).not.toMatch(/[0-9a-f]{64}/i);
  });

  it('projects every Env key except PRIVATE_KEY', () => {
    const union = new Set<string>([...PUBLIC_GLOBAL_KEYS, ...PUBLIC_VAULT_KEYS, 'PRIVATE_KEY']);
    expect(union).toEqual(new Set<string>([...GLOBAL_KEYS, ...VAULT_KEYS]));
    // and nothing parsed out of the environment escapes that union
    const cfg = loadKeeperConfig().vaults[0] as unknown as Record<string, unknown>;
    const derived = new Set(['gasFloorWei', 'compoundMinFees1']);
    for (const k of Object.keys(cfg)) if (!derived.has(k)) expect(union.has(k)).toBe(true);
  });

  it('hostOf survives a url that is not one', () => {
    expect(hostOf(undefined)).toBeNull();
    expect(hostOf('not a url')).toBeNull();
    expect(hostOf(RPC)).toBe(RPC_HOST);
  });
});

// ---------------------------------------------------------------------------
// rings and tees
// ---------------------------------------------------------------------------

describe('bounded rings', () => {
  it('keeps the last 300 log lines, in order', () => {
    const h = harness();
    for (let i = 0; i < 1000; i++) h.inst.onLine(LABEL_A, `line ${i}`);
    const lines = h.inst.logLines(VAULT_A.toLowerCase(), null)!;
    expect(lines).toHaveLength(300);
    expect(lines[0]).toMatch(/line 700$/);
    expect(lines[299]).toMatch(/line 999$/);
    // n is clamped to the ring, never above it
    expect(h.inst.logLines(VAULT_A.toLowerCase(), '9999')).toHaveLength(300);
    expect(h.inst.logLines(VAULT_A.toLowerCase(), '10')).toHaveLength(10);
  });

  it('keeps STATUS_RING records per vault', () => {
    const h = harness({ ring: 5 });
    quickCycles(h.inst, h.vaults[0], 10);
    const body = JSON.parse(h.inst.cycles(VAULT_A.toLowerCase(), null, null, null)!);
    expect(body.items).toHaveLength(5);
    expect(body.items.map((r: CycleRecord) => r.seq)).toEqual([6, 7, 8, 9, 10]);
    expect(h.inst.snapshot().vaults[0].ring).toEqual({ size: 5, firstSeq: 6, lastSeq: 10 });
  });

  it('answers /cycles for an unknown vault with null, not a guess', () => {
    const h = harness();
    expect(h.inst.cycles('0x' + '99'.repeat(20), null, null, null)).toBeNull();
    expect(h.inst.logLines('nope', null)).toBeNull();
  });
});

describe('the log tee', () => {
  it('survives a tee that throws and a tee that logs', () => {
    const seen: string[] = [];
    const un1 = addTee(() => {
      throw new Error('boom');
    });
    const un2 = addTee((_tag, msg) => {
      seen.push(msg);
      log('a tee that logs');
    });
    try {
      expect(() => log('outer')).not.toThrow();
      // the re-entrancy flag means the inner log() is printed but not re-tee'd
      expect(seen).toEqual(['outer']);
    } finally {
      un1();
      un2();
    }
  });

  it('counts a ctx that throws as a hook error instead of breaking the log', () => {
    const h = harness();
    // a line the parser cannot fold: the state it would read is gone
    Object.defineProperty(h.vaults[0], 'state', {
      get() {
        throw new Error('boom');
      },
    });
    expect(() => runCycle(h.vaults[0], 101, [SUMMARY_TRIGGER])).not.toThrow();
    expect(h.inst.hookErrors).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// never-throw
// ---------------------------------------------------------------------------

describe('the hooks can never reach the block handler', () => {
  async function withProcessSpies(fn: (spies: { uncaught: ReturnType<typeof vi.fn>; rejected: ReturnType<typeof vi.fn> }) => Promise<void>) {
    const uncaught = vi.fn();
    const rejected = vi.fn();
    process.on('uncaughtException', uncaught);
    process.on('unhandledRejection', rejected);
    try {
      await fn({ uncaught, rejected });
      await sleep(20); // an async write error would land here
      expect(uncaught).not.toHaveBeenCalled();
      expect(rejected).not.toHaveBeenCalled();
    } finally {
      process.off('uncaughtException', uncaught);
      process.off('unhandledRejection', rejected);
    }
  }

  function fakeChain(chain: Chain): { chain: Chain; fire: (n: number) => Promise<void> } {
    let handler: (n: number) => Promise<void> = async () => {};
    const provider = {
      on: (_ev: string, fn: (n: number) => Promise<void>) => {
        handler = fn;
      },
      getBlock: async () => ({ timestamp: TS }),
    };
    return { chain: { ...chain, provider } as unknown as Chain, fire: (n) => handler(n) };
  }

  it('resolves the handler and counts hookErrors when all three hooks throw', async () => {
    await withProcessSpies(async () => {
      const h = harness();
      for (const k of ['onHead', 'onCycleStart', 'onCycleEnd'] as const) {
        h.inst[k] = () => {
          throw new Error('boom');
        };
      }
      const f = fakeChain(h.chain);
      await startKeeper(f.chain, []);
      await expect(f.fire(1)).resolves.toBeUndefined();
      expect(h.inst.hookErrors).toBe(3);
      // and the keeper is not wedged: a second block still runs
      await expect(f.fire(2)).resolves.toBeUndefined();
      expect(h.inst.hookErrors).toBe(6);
    });
  });

  it('is a no-op with no listener installed', () => {
    const h = harness();
    h.inst.uninstall();
    expect(() => status.head(1, false)).not.toThrow();
    expect(() => status.cycleStart(1, TS)).not.toThrow();
    expect(() => status.cycleEnd(1)).not.toThrow();
  });

  it('counts the blocks skipped while a cycle is in flight', async () => {
    const h = harness();
    const f = fakeChain(h.chain);
    await startKeeper(f.chain, []);
    const first = f.fire(1); // busy until its getBlock resolves
    await f.fire(2);
    await first;
    expect(h.inst.snapshot().keeper.skippedWhileBusy).toBe(1);
    expect(h.inst.snapshot().keeper.busy).toBe(false);
    // `head` is the block that was evaluated, `seenHead` the newest one seen
    expect(h.inst.snapshot().keeper.head.number).toBe(1);
    expect(h.inst.snapshot().keeper.seenHead.number).toBe(2);
  });

  it('keeps head.number and head.ts describing the same block while busy', () => {
    const h = harness();
    h.inst.onHead(101, false);
    h.inst.onCycleStart(101, TS);
    h.inst.onHead(102, true); // a block skipped while the cycle is in flight
    h.inst.onHead(103, true);
    const k = h.inst.snapshot().keeper;
    expect(k.head).toMatchObject({ number: 101, ts: TS });
    expect(k.seenHead.number).toBe(103);
    expect(k.skippedWhileBusy).toBe(2);
  });

  it('survives an sse client whose socket dies mid-write', async () => {
    await withProcessSpies(async () => {
      const h = harness();
      const port = await h.inst.listen(0, '127.0.0.1');
      const a = await openSse(port);
      await waitFor(() => a.body().includes('retry:'));
      a.req.destroy();
      await sleep(10);
      for (let i = 0; i < 5; i++) runCycle(h.vaults[0], 200 + i, [SUMMARY_HOLD.replace('#101', `#${200 + i}`)], TS + i);
      // the listener is still answering after the broken write
      const res = await fetchText(port, '/status');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).keeper.listener.clients).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

describe('the listener', () => {
  it('serves /status, /config, /healthz and the discovery root', async () => {
    const h = harness();
    const port = await h.inst.listen(0, '127.0.0.1');
    expect(port).toBeGreaterThan(0);
    runCycle(h.vaults[0], 101, [SUMMARY_HOLD]);

    const st = await fetchText(port, '/status');
    expect(st.status).toBe(200);
    expect(st.headers['x-api-version']).toBe('1');
    const body = JSON.parse(st.body);
    expect(body.v).toBe(1);
    expect(body.keeper.mode).toBe('LIVE');
    expect(body.keeper.rpcHost).toBe(RPC_HOST);
    expect(body.keeper.blockTimeSecs).toBeNull();
    expect(body.vaults.map((v: { label: string }) => v.label)).toEqual([LABEL_A, LABEL_B]);

    const cfg = await fetchText(port, '/config');
    expect(cfg.status).toBe(200);
    expect(cfg.body).not.toMatch(/[0-9a-f]{64}/i);

    expect((await fetchText(port, '/healthz')).status).toBe(200);
    expect(JSON.parse((await fetchText(port, '/')).body).routes).toContain('/status');
    expect((await fetchText(port, '/nope')).status).toBe(404);
    expect((await fetchText(port, '/vaults/0xdead/cycles')).status).toBe(404);
  });

  it('is GET only', async () => {
    const h = harness();
    const port = await h.inst.listen(0, '127.0.0.1');
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetchText(port, '/status', { method });
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe('GET');
    }
  });

  it('serves a vault by address and by url-encoded label', async () => {
    const h = harness();
    const port = await h.inst.listen(0, '127.0.0.1');
    runCycle(h.vaults[0], 101, [SUMMARY_HOLD]);
    const byAddr = await fetchText(port, `/vaults/${VAULT_A.toLowerCase()}/cycles`);
    const byLabel = await fetchText(port, `/vaults/${encodeURIComponent(LABEL_A)}/cycles`);
    expect(byAddr.status).toBe(200);
    expect(byLabel.status).toBe(200);
    expect(JSON.parse(byAddr.body).items).toHaveLength(1);
    expect(JSON.parse(byLabel.body).vault.label).toBe(LABEL_A);

    const text = await fetchText(port, `/vaults/${VAULT_A.toLowerCase()}/log?n=1`);
    expect(text.headers['content-type']).toMatch(/text\/plain/);
    expect(text.body.trimEnd().split('\n')).toHaveLength(1);
  });

  it('pages strictly past `since` and clamps `limit` to 500', async () => {
    const h = harness();
    const port = await h.inst.listen(0, '127.0.0.1');
    quickCycles(h.inst, h.vaults[0], 600);

    const page = JSON.parse((await fetchText(port, `/vaults/${VAULT_A.toLowerCase()}/cycles?since=3&limit=4`)).body);
    expect(page.items.map((r: CycleRecord) => r.seq)).toEqual([4, 5, 6, 7]);
    expect(page.next).toBe(7);
    expect(page.complete).toBe(false);

    const big = JSON.parse((await fetchText(port, `/vaults/${VAULT_A.toLowerCase()}/cycles?limit=9999`)).body);
    expect(big.items).toHaveLength(500);

    // a cursor from another boot is not this boot's: serve the tail of the ring
    const foreign = JSON.parse(
      (await fetchText(port, `/vaults/${VAULT_A.toLowerCase()}/cycles?since=${encodeURIComponent('2020-01-01T00:00:00.000Z')}:400&limit=3`)).body,
    );
    expect(foreign.since).toBe(597);
    expect(foreign.items.map((r: CycleRecord) => r.seq)).toEqual([598, 599, 600]);
    expect(foreign.complete).toBe(true);
    expect(foreign.bootAt).toBe(h.inst.bootAt);

    const desc = JSON.parse((await fetchText(port, `/vaults/${VAULT_A.toLowerCase()}/cycles?since=3&limit=2&order=desc`)).body);
    expect(desc.items.map((r: CycleRecord) => r.seq)).toEqual([5, 4]);
  });

  it('replays from Last-Event-ID only within this boot, and at most 500', async () => {
    const h = harness();
    const port = await h.inst.listen(0, '127.0.0.1');
    quickCycles(h.inst, h.vaults[0], 10);

    const fresh = await openSse(port);
    await waitFor(() => fresh.body().includes('retry:'));
    expect(fresh.frames()).toBe(0);
    fresh.req.destroy();

    const replay = await openSse(port, { 'last-event-id': `${h.inst.bootAt}:7` });
    await waitFor(() => replay.frames() >= 3);
    expect(replay.frames()).toBe(3);
    expect(replay.body()).toContain(`id: ${h.inst.bootAt}:8`);
    // live events keep flowing on the same connection
    runCycle(h.vaults[0], 500, [SUMMARY_HOLD.replace('#101', '#500')]);
    await waitFor(() => replay.frames() >= 4);
    expect(replay.frames()).toBe(4);
    replay.req.destroy();

    const foreign = await openSse(port, { 'last-event-id': '2020-01-01T00:00:00.000Z:1' });
    await waitFor(() => foreign.body().includes('retry:'));
    await sleep(30);
    expect(foreign.frames()).toBe(0);
    foreign.req.destroy();
  });

  it('caps the replay at 500 events', async () => {
    const h = harness();
    const port = await h.inst.listen(0, '127.0.0.1');
    quickCycles(h.inst, h.vaults[0], 600);
    const replay = await openSse(port, { 'last-event-id': `${h.inst.bootAt}:1` });
    await waitFor(() => replay.frames() >= 500, 5000);
    await sleep(50);
    expect(replay.frames()).toBe(500);
    replay.req.destroy();
  });

  it('refuses the 17th connection', async () => {
    const h = harness();
    const port = await h.inst.listen(0, '127.0.0.1');
    const socks: net.Socket[] = [];
    try {
      for (let i = 0; i < 16; i++) {
        const s = net.connect(port, '127.0.0.1');
        s.on('error', () => {});
        await once(s, 'connect');
        socks.push(s);
      }
      const s17 = net.connect(port, '127.0.0.1');
      s17.on('error', () => {});
      let data = '';
      s17.on('data', (d) => (data += d));
      await once(s17, 'connect');
      s17.write('GET /status HTTP/1.1\r\nHost: keeper\r\nConnection: close\r\n\r\n');
      await once(s17, 'close');
      expect(data).toBe('');
    } finally {
      for (const s of socks) s.destroy();
    }
    // ...and the listener is healthy again once they are freed
    await sleep(20);
    expect((await fetchText(port, '/status')).status).toBe(200);
  });

  it('counts requests and reports the clients it is streaming to', async () => {
    const h = harness();
    const port = await h.inst.listen(0, '127.0.0.1');
    await fetchText(port, '/status');
    const sse = await openSse(port);
    await waitFor(() => sse.body().includes('retry:'));
    const body = JSON.parse((await fetchText(port, '/status')).body);
    expect(body.keeper.listener.requests).toBeGreaterThanOrEqual(2);
    expect(body.keeper.listener.clients).toBe(1);
    sse.req.destroy();
  });
});
