/// <reference types="svelte" />
import { describe, expect, it, beforeEach } from 'vitest';
import { load } from '../src/routes/+layout.server.js';
import FleetPage from '../src/routes/+page.svelte';
import VaultPage from '../src/routes/v/[id]/+page.svelte';
import { status as statusStore } from '../src/lib/stores/status';
// vitest aliases $app/* to test/stubs; tsc has no mapping for them
// @ts-expect-error - no declarations for the sveltekit stubs
import { setPage } from '$app/stores';
import { offenders } from '../server/contract/glyphs';
import { StatusV1 } from '../server/contract/types';

// the first paint: the layout's ssr load reads the registry express sets on globalThis, the
// page renders the fleet from it, and nothing internal (wei, urls, paths) reaches the html.

interface Ssr {
  render: (props: Record<string, unknown>) => { html: string; head: string };
}

const Fleet = FleetPage as unknown as Ssr;
const Vault = VaultPage as unknown as Ssr;

const addr = (seed: string) => `0x${seed.repeat(21)}`.slice(0, 42);
const HASH = `0x${'8f'.repeat(32)}`;
const SIGNER = addr('0b');
const KEEPER_RPC = 'hdx.tarn.hydration.cloud';
const BALANCE_WEI = '1720000000000000';
const SUPPLY_WEI = '9813000000000000000000';
// the screens age everything against the wall clock, so the fixture is relative to it
const NOW = Math.floor(Date.now() / 1000);
const iso = (ts: number) => new Date(ts * 1000).toISOString();

function amount(raw: string, decimals: number, human: number, symbol: string) {
  return { raw, decimals, human, symbol };
}

function gas() {
  return {
    signerBalanceWei: BALANCE_WEI,
    floorWei: '1000000000000000',
    warnWei: '2000000000000000',
    runwayTx: 351,
    runwayDays: 19.2,
    costSource: 'receipts' as const,
  };
}

function chain(over: Record<string, unknown> = {}) {
  return {
    asOf: { block: 14471204, ts: NOW - 20 },
    ageSecs: 20,
    spotTick: 185062,
    price: { raw: 1.0906e8, human: 1.0906, quote: 'HOLLAR per aDOT' },
    base: { lower: 184860, upper: 186840, inRange: true, driftTicks: 788, thresholdTicks: 660 },
    limit: { lower: 185880, upper: 185940, side: 'below' as const, liquidity: '4242000000', outsideByTicks: 818, stranded: false },
    nav: {
      total0: amount('3120000000000', 10, 312.0, 'aDOT'),
      total1: amount('3810000000000000000000', 18, 3810, 'HOLLAR'),
      navToken1: 4242.1,
      note: 'excludes fees accrued since last poke',
    },
    shares: { totalSupply: SUPPLY_WEI, sharePriceToken1: 0.9968, maxTotalSupply: '0' },
    composition: { token0Share: 0.762, baseShare: 0.476, limitShare: 0.524, twoXMinusOne: 0.524 },
    gates: [
      { gate: 'drift', enabled: true, reading: '788 tk', limit: '660', op: '>', ratio: 1.19, verdict: 'TRIGGER', keeperSaw: '=', agrees: true },
      { gate: 'twap vs oracle', enabled: true, reading: '111 tk', limit: '50', op: '<=', ratio: 2.22, verdict: 'FAIL', keeperSaw: 111, agrees: true },
      { gate: 'spot vs oracle', enabled: true, reading: '34 tk', limit: '(info)', op: null, ratio: 0.34, verdict: 'agrees', keeperSaw: null, agrees: null },
    ],
    caps: { maxTranslation: 780, maxWidth: 300, minIntervalSecs: 21600, lastRebalanceTs: NOW - 186000, exempted: false },
    feesOwed: {
      fees0: amount('31200000000', 10, 3.12, 'aDOT'),
      fees1: amount('3810000000000000000', 18, 3.81, 'HOLLAR'),
      asOf: { block: 14471204, ts: NOW - 20 },
    },
    idle: null,
    fee: { divisor: 255, protocolFrac0: 0.25, protocolFrac1: 0.25 },
    gas: gas(),
    roles: { rebalancerOk: true, adminOk: true, exempted: false, deadlock: false, warnings: [] },
    deposits: { state: 'open' as const, reason: null, threshold: 10100, deviationBps: 12, twapCheck: true, whitelisted: true, note: null },
    ...over,
  };
}

function keeperSide(over: Record<string, unknown> = {}) {
  return {
    reachable: true,
    asOf: { block: 14471203, ts: NOW - 22 },
    ageSecs: 22,
    action: 'TRIGGER 34m/34m',
    outcome: { code: 'gate-blocked' as const, stage: 'gate' as const, detail: 'pool 184945 vs oracle 185056 dev 111 > 50' },
    standing: { code: 'gate-blocked' as const, subcode: 'oracle-dev' as const, sinceTs: NOW - 7440, secs: 7440, cycles: 3380 },
    dwell: {
      rebalance: { sinceTs: NOW - 2040, heldSecs: 2040, requiredSecs: 2025, armed: true },
      refresh: { sinceTs: 0, heldSecs: 0, requiredSecs: 2025, armed: false },
      fold: { sinceTs: 0, heldSecs: 0, requiredSecs: 2025, armed: false },
    },
    cooldown: { evaluated: true, elapsedSecs: 186000, minIntervalSecs: 21600, skipped: false },
    gateSaw: {
      evaluated: true,
      ok: false,
      failedAt: 'oracle-dev' as const,
      reason: 'pool 184945 vs oracle 185056 dev 111 > 50',
      via: 'skip' as const,
      twap: { windowSecs: 3600, tick: 184985, devTicks: 77, maxDevTicks: 100 },
      oracle: { tick: 185096, ageSecs: 2238, devTicks: 111, maxDevTicks: 50 },
    },
    regime: {
      regime: 'calm' as const,
      sinceTs: NOW - 90000,
      lastEvaluatedAt: iso(NOW - 7440),
      inputs: { volRatio: 1.2, move15mFrac: 0.004, move1hFrac: 0.021 },
    },
    compound: { due: false, dueInSecs: 2040, lastTs: NOW - 3600 },
    lastTx: { hash: HASH, kind: 'recenter' as const, ts: NOW - 186000 },
    lastError: null,
    config: null,
    ...over,
  };
}

function monitorSide(firing: Array<Record<string, unknown>> = []) {
  return { reachable: true, asOf: iso(NOW - 41), ageSecs: 41, stale: false, firing, snapshot: null };
}

function vault(id: string, label: string, over: Record<string, unknown> = {}) {
  return {
    id: addr(id),
    label,
    pair: label,
    pool: addr('c1'),
    tickSpacing: 60,
    entrypoint: 'proxy' as const,
    verdict: {
      level: 'held' as const,
      code: 'gate-blocked',
      legit: true,
      sinceTs: NOW - 7440,
      sentence: 'due work held by oracle clamp (twap lag) 2h04m',
    },
    liveness: 'blocked-legit' as const,
    keeper: keeperSide(),
    chain: chain(),
    monitor: monitorSide([
      {
        key: 'clamp-blocking',
        severity: 'warning' as const,
        title: 'clamp blocking',
        detail: 'dev 111 > 50',
        onsetAt: iso(NOW - 7440),
        lastNotifiedAt: iso(NOW - 600),
      },
    ]),
    disagreements: [],
    economics: {
      window: '7d' as const,
      netVsBasketHodl: -0.0121,
      netVs5050Hodl: -0.0102,
      experimental: { feesFrac: 0.0102, ilFrac: -0.0223 },
      timeInBase: 0.91,
      txs: 6,
      avgCostWei: '4900000000000',
    },
    ...over,
  };
}

function fixture() {
  const source = (over: Record<string, unknown> = {}) => ({
    configured: true,
    reachable: true,
    asOf: iso(NOW - 3),
    ageSecs: 3,
    unreachableSince: null,
    detail: null,
    ...over,
  });
  return {
    v: 1 as const,
    generatedAt: iso(NOW),
    sources: {
      keeper: source(),
      monitor: source({ ageSecs: 41, asOf: iso(NOW - 41) }),
      chain: {
        ok: true,
        rpcHost: 'rpc.hydradx.cloud',
        head: { number: 14471204, ts: NOW - 2, at: iso(NOW - 2) },
        fallbackHead: { number: 14471204, ts: NOW - 4, at: iso(NOW - 4) },
        backfill: { from: 14000000, to: 14471204, done: true },
      },
      ui: { ssr: true, commit: 'abc1234' },
    },
    keeper: {
      configured: true,
      reachable: true,
      mode: 'LIVE' as const,
      version: '0.2.0',
      bootAt: iso(NOW - 273840),
      signer: SIGNER,
      rpcHost: KEEPER_RPC,
      head: { number: 14471203, ts: NOW - 2, at: iso(NOW - 2) },
      busy: false,
      busySinceAt: null,
      skippedWhileBusy: 0,
      cyclesTotal: 124500,
      errorsTotal: 3,
      hookErrors: 0,
      configFingerprint: 'fe01dd',
      gas: gas(),
      liveness: 'alive' as const,
    },
    vaults: [
      vault('a2', 'aDOT/HOLLAR'),
      vault('b7', 'tBTC/HOLLAR', {
        verdict: { level: 'ok' as const, code: 'hold', legit: null, sinceTs: NOW - 400, sentence: 'quiet · nothing due · compound in 34m' },
        liveness: 'quiet' as const,
        keeper: keeperSide({
          action: null,
          outcome: { code: 'hold' as const, stage: 'triggers' as const, detail: 'in range (drift 219 <= 660)' },
          standing: { code: 'hold' as const, subcode: null, sinceTs: NOW - 400, secs: 400, cycles: 180 },
          dwell: {
            rebalance: { sinceTs: 0, heldSecs: 0, requiredSecs: 2025, armed: false },
            refresh: { sinceTs: 0, heldSecs: 0, requiredSecs: 2025, armed: false },
            fold: { sinceTs: 0, heldSecs: 0, requiredSecs: 2025, armed: false },
          },
          gateSaw: null,
        }),
        monitor: monitorSide(),
      }),
      vault('d4', 'HOLLAR/USDT', {
        verdict: { level: 'fault' as const, code: 'error', legit: false, sinceTs: NOW - 60, sentence: 'error: call revert exception (rpc)' },
        liveness: 'alive' as const,
        keeper: keeperSide({
          action: null,
          outcome: { code: 'error' as const, stage: 'error' as const, detail: 'call revert exception' },
          standing: { code: 'error' as const, subcode: null, sinceTs: NOW - 60, secs: 60, cycles: 2 },
          dwell: {
            rebalance: { sinceTs: 0, heldSecs: 0, requiredSecs: 2025, armed: false },
            refresh: { sinceTs: 0, heldSecs: 0, requiredSecs: 2025, armed: false },
            fold: { sinceTs: 0, heldSecs: 0, requiredSecs: 2025, armed: false },
          },
          gateSaw: null,
          lastTx: null,
          lastError: { at: iso(NOW - 60), block: 14471201, message: 'call revert exception' },
        }),
        chain: null,
        economics: null,
      }),
    ],
    findings: [
      {
        id: 1,
        vault: null,
        source: 'monitor' as const,
        key: 'gas-warn' as const,
        severity: 'warning' as const,
        title: 'gas warn',
        detail: '0.00172 < 0.002',
        onsetAt: iso(NOW - 10800),
        lastSeenAt: iso(NOW - 41),
        clearedAt: null,
        active: true,
        stale: false,
      },
    ],
  };
}

// the visible text only: attributes and class names are not drawn by the font
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function assertClean(html: string) {
  // no raw wei, no internal url or host, no filesystem path
  expect(html).not.toContain(BALANCE_WEI);
  expect(html).not.toContain(SUPPLY_WEI);
  expect(html).not.toContain(KEEPER_RPC);
  expect(html).not.toMatch(/https?:\/\//);
  expect(html).not.toContain('/data/');
  expect(html).not.toContain('gamma_keeper');
  // every glyph is one the vendored DOS font can draw
  expect(offenders(textOf(html))).toEqual([]);
}

describe('ssr', () => {
  beforeEach(() => {
    statusStore.set(null);
    delete (globalThis as Record<string, unknown>).__gammaUi;
    setPage('/');
  });

  it('the fixture is a valid StatusV1', () => {
    expect(() => StatusV1.parse(fixture())).not.toThrow();
  });

  it('loads the status from the ssr registry', () => {
    const body = fixture();
    (globalThis as Record<string, unknown>).__gammaUi = { statusJson: () => body };
    expect(load()).toEqual({ status: body, ssr: true });
  });

  it('renders the fleet rows from the load data', () => {
    (globalThis as Record<string, unknown>).__gammaUi = { statusJson: () => fixture() };
    const { html } = Fleet.render({ data: load() });

    // header block
    expect(html).toContain('gamma keeper');
    expect(html).toContain('3 vaults');
    expect(html).toContain('LIVE');
    expect(html).toContain('0.00172 WETH');
    expect(html).toContain('agree 3/3');

    // one row per vault, in descriptor order, with the cells the mockup promises
    expect(html).toContain('aDOT/HOLLAR');
    expect(html).toContain('tBTC/HOLLAR');
    expect(html).toContain('HOLLAR/USDT');
    expect(html).toContain('TRIGGER'); // armed
    expect(html).toContain('clamp 111>50'); // blocking: the gate code + reading > limit
    expect(html).toContain('2d3h rec'); // last act
    expect(html).toContain('err'); // the third vault threw this cycle, the others still read ok
    expect(html.indexOf('aDOT/HOLLAR')).toBeLessThan(html.indexOf('tBTC/HOLLAR'));

    // the footer spells a quiet vault out, worst first
    expect(html).toContain('quiet');
    expect(html).toContain('due work held by oracle clamp');
    expect(html).toContain('gas-warn firing');

    assertClean(html);
  });

  it('falls back to an unreachable strip instead of an error when the registry is absent', () => {
    expect(load()).toEqual({ status: null, ssr: false });
    const { html } = Fleet.render({ data: load() });
    expect(html).toContain('connecting');
    expect(html).not.toContain('aDOT/HOLLAR');
    assertClean(html);
  });

  it('never inlines the reason a throwing registry gave', () => {
    (globalThis as Record<string, unknown>).__gammaUi = {
      statusJson: () => {
        throw new Error('connect ECONNREFUSED http://gamma_keeper:8787/status');
      },
    };
    const data = load();
    expect(data).toEqual({ status: null, ssr: false });
    assertClean(Fleet.render({ data }).html);
  });

  it('renders the vault drill for a label slug', () => {
    (globalThis as Record<string, unknown>).__gammaUi = { statusJson: () => fixture() };
    const data = load();
    setPage('/v/adot-hollar', { id: 'adot-hollar' });
    const { html } = Vault.render({ data });

    expect(html).toContain('aDOT/HOLLAR');
    expect(html).toContain('spot 185062');
    expect(html).toContain('due work held by oracle clamp');
    expect(html).toContain('BLOCKED');
    expect(html).toContain('1 of 3');
    assertClean(html);
  });

  it('renders every drill view before its own fetch has landed', () => {
    (globalThis as Record<string, unknown>).__gammaUi = { statusJson: () => fixture() };
    const data = load();
    for (const view of ['gates', 'history', 'econ', 'config']) {
      statusStore.set(null);
      setPage(`/v/adot-hollar?view=${view}`, { id: 'adot-hollar' });
      const { html } = Vault.render({ data });
      expect(html).toContain('aDOT/HOLLAR');
      expect(html).toContain(`[${view === 'history' ? 'Hist' : view === 'config' ? 'Cfg' : view === 'gates' ? 'Gates' : 'Econ'}]`);
      assertClean(html);
    }
  });
});
