import { describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Finding, Snapshot } from '../src/checks';
import { ALERTS_MAX, alerts, recordAlert, type Severity } from '../src/notify';
import type { PoolSpec, Pool } from '../src/pools';
import {
  RPC_FAILING,
  createState,
  firingKey,
  noteCycle,
  reconcile,
  rpcFailingFinding,
  scrub,
  serialise,
  setPools,
  startStatus,
  type StatusConfig,
} from '../src/status';

const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);
const WEBHOOK = 'https://discord.com/api/webhooks/123456/secret-token-value';
const RPC = 'https://user:pass@rpc.example.test/v1?key=abc';

const cfg: StatusConfig = {
  rpcHost: 'rpc.example.test',
  RPC_URL: RPC,
  KEEPER: '0x' + 'cc'.repeat(20),
  DISCORD_WEBHOOK: WEBHOOK,
  CHECK_INTERVAL_SECS: 300,
  REALERT_SECS: 21600,
  FAIL_ALERT_CYCLES: 3,
  GAS_WARN_WEI: '2000000000000000',
  GAS_FLOOR_WEI: '1000000000000000',
};

const thresholds = {
  REBALANCE_THRESHOLD_MULT: 11, MIN_INTERVAL_SECS: 21600, REBALANCE_GRACE_SECS: 7200,
  TWAP_ENABLED: true, TWAP_WINDOW_SECS: 3600, MIN_TWAP_WINDOW_SECS: 600,
  ORACLE_MAX_DEV_TICKS: 50, STALE_SECONDS: 28800,
  LIMIT_REFRESH_ENABLED: true, LIMIT_REFRESH_TICKS: 120, DIVERGENCE_BPS: 200,
};

const spec = (vault: string, label: string | null = null): PoolSpec => ({
  id: vault.toLowerCase(), label, vault, pool: null, proxy: '0x' + 'dd'.repeat(20), clearing: null,
  feed: null, feed1: null, feed0Side: 'token0', thresholds,
});
const resolved = (s: PoolSpec, sym0 = 'aDOT', sym1 = 'HOLLAR'): Pool => ({
  ...s, pool: '0x' + 'ee'.repeat(20), dec0: 10, dec1: 18, sym0, sym1, label: s.label ?? `${sym0}/${sym1}`,
});

const finding = (key: string, vault: string | null, severity: Finding['severity'] = 'warning'): Finding => ({
  key, vault, severity, title: `title ${key}`, detail: `detail ${key}`,
});

type Sent = { sev: Severity; title: string; detail: string };
const spy = () => {
  const sent: Sent[] = [];
  const send = vi.fn(async (sev: Severity, title: string, detail: string) => { sent.push({ sev, title, detail }); });
  return { sent, send };
};

const T0 = 1_760_000_000;
const onePool = () => {
  const s = createState({ version: '0.4.0', source: 'env', specs: [spec(A)], now: T0 });
  setPools(s, [resolved(spec(A))]);
  return s;
};
const ok = (findings: Finding[], checked = [A.toLowerCase()]) => ({ findings, checked: new Set(checked), gasOk: true, cycleOk: true });

describe('cycle bookkeeping', () => {
  it('counts consecutive failures and resets on success', () => {
    const s = onePool();
    noteCycle(s, false, T0, 'boom');
    noteCycle(s, false, T0 + 300, 'boom again');
    expect(s.consecutiveFailures).toBe(2);
    expect(s.lastCycleOk).toBe(false);
    expect(s.lastError).toBe('boom again');
    noteCycle(s, true, T0 + 600);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastCycleOk).toBe(true);
    expect(s.lastError).toBeNull();
    expect(s.cycles).toBe(3);
    expect(s.lastCycleTs).toBe(T0 + 600);
  });

  it('emits monitor-rpc-failing only at the threshold, never when disabled', () => {
    const s = onePool();
    for (let i = 0; i < 2; i++) noteCycle(s, false, T0 + i, 'x');
    expect(rpcFailingFinding(s, cfg)).toBeNull();
    noteCycle(s, false, T0 + 2, `call revert url="${RPC}"`);
    const f = rpcFailingFinding(s, cfg)!;
    expect(f).toMatchObject({ key: RPC_FAILING, severity: 'critical', vault: null });
    expect(f.detail).toContain('3 consecutive');
    expect(f.detail).toContain('rpc.example.test');
    expect(rpcFailingFinding(s, { ...cfg, FAIL_ALERT_CYCLES: 0 })).toBeNull();
  });

  it('scrub reduces the rpc url to its host and drops userinfo', () => {
    expect(scrub(`SERVER_ERROR url="${RPC}" body`, cfg)).toBe('SERVER_ERROR url="rpc.example.test" body');
    expect(scrub('at https://u:p@other.host/x', cfg)).toBe('at https://other.host/x');
  });
});

describe('reconcile', () => {
  it('fires once, then repeats every REALERT_SECS with the true onset', async () => {
    const s = onePool();
    const { sent, send } = spy();
    const f = finding('rebalance-overdue', A.toLowerCase(), 'critical');
    await reconcile(s, ok([f]), cfg, send, T0);
    expect(sent).toEqual([{ sev: 'critical', title: 'title rebalance-overdue', detail: 'detail rebalance-overdue' }]);
    // inside the window: silent, detail refreshed
    await reconcile(s, ok([{ ...f, detail: 'newer' }]), cfg, send, T0 + 3600);
    expect(sent.length).toBe(1);
    expect(s.firing.get(firingKey(f))!.f.detail).toBe('newer');
    // two realerts: the hours count from onset, not from the previous realert
    await reconcile(s, ok([f]), cfg, send, T0 + 6 * 3600);
    await reconcile(s, ok([f]), cfg, send, T0 + 12 * 3600);
    expect(sent.length).toBe(3);
    expect(sent[1].detail).toContain('(still firing after 6h)');
    expect(sent[2].detail).toContain('(still firing after 12h)');
    expect(s.firing.get(firingKey(f))!.onsetTs).toBe(T0);
    expect(s.firing.get(firingKey(f))!.lastNotifiedTs).toBe(T0 + 12 * 3600);
  });

  it('resolves only for a pool whose checks completed this cycle', async () => {
    const s = onePool();
    const { sent, send } = spy();
    const f = finding('out-of-band', A.toLowerCase(), 'critical');
    await reconcile(s, ok([f]), cfg, send, T0);
    // pool failed: unknown, not clear
    await reconcile(s, { findings: [], checked: new Set(), gasOk: false, cycleOk: false }, cfg, send, T0 + 300);
    expect(s.firing.size).toBe(1);
    expect(sent.length).toBe(1);
    await reconcile(s, ok([]), cfg, send, T0 + 600);
    expect(s.firing.size).toBe(0);
    expect(sent[1]).toEqual({ sev: 'recovered', title: 'Resolved: title out-of-band', detail: 'Condition no longer detected.' });
  });

  it('gas warn -> floor escalates in place, no spurious Resolved', async () => {
    const s = onePool();
    const { sent, send } = spy();
    const warn = finding('gas', null, 'warning');
    const floor = finding('gas', null, 'critical');
    await reconcile(s, ok([warn]), cfg, send, T0);
    await reconcile(s, ok([floor]), cfg, send, T0 + 7200);
    expect(sent.map((x) => x.sev)).toEqual(['warning', 'critical']);
    expect(sent[1].detail).toContain('(was warning; firing since 2h)');
    expect(s.firing.get('gas')!.onsetTs).toBe(T0);
    // eased back to warning: still no resolve
    await reconcile(s, ok([warn]), cfg, send, T0 + 7500);
    expect(sent[2].sev).toBe('warning');
    expect(sent.some((x) => x.sev === 'recovered')).toBe(false);
    // funded: exactly one resolve
    await reconcile(s, ok([]), cfg, send, T0 + 7800);
    expect(sent.filter((x) => x.sev === 'recovered').length).toBe(1);
    expect(s.firing.has('gas')).toBe(false);
  });

  it('gas is not resolved while the gas read itself failed', async () => {
    const s = onePool();
    const { sent, send } = spy();
    await reconcile(s, ok([finding('gas', null)]), cfg, send, T0);
    await reconcile(s, { findings: [], checked: new Set([A.toLowerCase()]), gasOk: false, cycleOk: false }, cfg, send, T0 + 300);
    expect(s.firing.has('gas')).toBe(true);
    expect(sent.length).toBe(1);
  });

  it('monitor-rpc-failing fires after N failures and recovers on the next good cycle', async () => {
    const s = onePool();
    const { sent, send } = spy();
    for (let i = 0; i < 3; i++) {
      noteCycle(s, false, T0 + i * 300, 'dead');
      const rpc = rpcFailingFinding(s, cfg);
      await reconcile(s, { findings: rpc ? [rpc] : [], checked: new Set(), gasOk: false, cycleOk: false }, cfg, send, T0 + i * 300);
    }
    expect(sent.length).toBe(1);
    expect(sent[0].sev).toBe('critical');
    expect(s.firing.has(RPC_FAILING)).toBe(true);
    noteCycle(s, true, T0 + 900);
    expect(rpcFailingFinding(s, cfg)).toBeNull();
    await reconcile(s, ok([]), cfg, send, T0 + 900);
    expect(s.firing.has(RPC_FAILING)).toBe(false);
    expect(sent[1].sev).toBe('recovered');
  });

  it('prefixes [label] only when more than one pool is watched', async () => {
    const one = onePool();
    const s1 = spy();
    await reconcile(one, ok([finding('paused', A.toLowerCase())]), cfg, s1.send, T0);
    expect(s1.sent[0].title).toBe('title paused');

    const two = createState({ version: '0.4.0', source: 'VAULTS_FILE', specs: [spec(A, 'aDOT/HOLLAR'), spec(B)], now: T0 });
    setPools(two, [resolved(spec(A, 'aDOT/HOLLAR')), resolved(spec(B), 'tBTC', 'HOLLAR')]);
    const s2 = spy();
    await reconcile(two, {
      findings: [finding('paused', A.toLowerCase()), finding('paused', B.toLowerCase()), finding('gas', null)],
      checked: new Set([A.toLowerCase(), B.toLowerCase()]), gasOk: true, cycleOk: true,
    }, cfg, s2.send, T0);
    expect(s2.sent.map((x) => x.title)).toEqual(['[aDOT/HOLLAR] title paused', '[tBTC/HOLLAR] title paused', 'title gas']);
    expect([...two.firing.keys()]).toEqual([`${A.toLowerCase()}:paused`, `${B.toLowerCase()}:paused`, 'gas']);
    await reconcile(two, ok([], [A.toLowerCase(), B.toLowerCase()]), cfg, s2.send, T0 + 300);
    expect(s2.sent.slice(3).map((x) => x.title)).toEqual(['Resolved: [aDOT/HOLLAR] title paused', 'Resolved: [tBTC/HOLLAR] title paused', 'Resolved: title gas']);
  });
});

describe('/status view', () => {
  const snap: Snapshot = {
    checkedAt: new Date(T0 * 1000).toISOString(), tick: 185062, base: [184860, 186840], limit: [185880, 185940],
    drift: 212, threshold: 660, lastRebalanceTs: T0 - 8000, sinceSecs: 8000, allowanceSecs: 28800, limitOutsideBy: 818,
    paused: false, feedPx: 1.09, poolPx: 1.0906, divergenceBps: 5, oracleTick: 185096, twapTick: 184985, devTicks: 111,
    spotDevTicks: 34, feedAgeSecs: 2238, navToken1: 4242, limitValueToken1: 2222,
  };

  it('never carries the webhook, reports it as set/unset, partitions firing', async () => {
    const s = onePool();
    s.pools[0].snapshot = snap;
    s.gasWei = { toString: () => '1720000000000000' } as never;
    const { send } = spy();
    await reconcile(s, ok([finding('clamp-blocking', A.toLowerCase()), finding('gas', null)]), cfg, send, T0);
    noteCycle(s, true, T0);
    const body = serialise(s, cfg, T0 + 10);
    const text = JSON.stringify(body);
    expect(text).not.toContain('secret-token-value');
    expect(text).not.toContain('discord.com');
    expect(text).not.toContain('user:pass');
    expect(text).not.toContain('key=abc');
    expect(body.webhook).toBe('set');
    expect(serialise(s, { ...cfg, DISCORD_WEBHOOK: undefined }, T0).webhook).toBe('unset');
    expect(body).toMatchObject({ v: 1, version: '0.4.0', rpcHost: 'rpc.example.test', lastCycleOk: true, consecutiveFailures: 0, cycles: 1, stale: false, source: 'env' });
    expect(body.firing.map((f) => f.key)).toEqual(['gas']);
    expect(body.pools[0].firing.map((f) => f.key)).toEqual(['clamp-blocking']);
    expect(body.pools[0].firing[0]).toMatchObject({ onsetAt: new Date(T0 * 1000).toISOString(), lastNotifiedAt: new Date(T0 * 1000).toISOString(), vault: A.toLowerCase() });
    expect(body.pools[0]).toMatchObject({ id: A.toLowerCase(), label: 'aDOT/HOLLAR', resolved: true, thresholds });
    expect(body.pools[0].snapshot).toMatchObject({ ...snap, gasWei: '1720000000000000' });
    expect(body.gas.wei).toBe('1720000000000000');
  });

  it('flags stale after 3 intervals without a cycle, from boot when none ran', () => {
    const s = onePool();
    expect(serialise(s, cfg, T0 + 900).stale).toBe(false);
    expect(serialise(s, cfg, T0 + 901).stale).toBe(true);
    noteCycle(s, false, T0 + 1000, 'x');
    expect(serialise(s, cfg, T0 + 1900).stale).toBe(false);
    expect(serialise(s, cfg, T0 + 1901).stale).toBe(true);
    expect(serialise(s, cfg, T0 + 1901).lastCycleAt).toBe(new Date((T0 + 1000) * 1000).toISOString());
  });

  it('serialises before the boot-time resolution lands', () => {
    const s = createState({ version: '0.4.0', source: 'env', specs: [spec(A)], now: T0 });
    const body = serialise(s, cfg, T0);
    expect(body.pools[0]).toMatchObject({ id: A.toLowerCase(), label: A.toLowerCase(), resolved: false, snapshot: null, tokens: null });
  });
});

describe('listener', () => {
  it('healthz is 200 with a stale cycle; status says stale; GET only', async () => {
    const s = onePool();
    const server = startStatus(s, cfg, 0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      const h = await fetch(`${base}/healthz`);
      expect(h.status).toBe(200);
      expect(await h.json()).toEqual({ ok: true });
      const st = await fetch(`${base}/status?x=1`);
      expect(st.status).toBe(200);
      expect(st.headers.get('content-type')).toBe('application/json');
      const body = await st.json();
      expect(body.stale).toBe(true); // nothing ran since T0, long ago
      expect(body.v).toBe(1);
      expect(JSON.stringify(body)).not.toContain('secret-token-value');
      expect((await fetch(`${base}/status`, { method: 'POST' })).status).toBe(405);
      expect((await fetch(`${base}/nope`)).status).toBe(404);
      expect(server.maxConnections).toBe(8);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('alerts ring', () => {
  it('keeps the last 100 in order', () => {
    for (let i = 0; i < ALERTS_MAX + 50; i++) recordAlert({ at: new Date(i * 1000).toISOString(), severity: 'warning', title: `a${i}` });
    const a = alerts();
    expect(a.length).toBe(ALERTS_MAX);
    expect(a[0].title).toBe('a50');
    expect(a[a.length - 1].title).toBe(`a${ALERTS_MAX + 49}`);
  });
});
