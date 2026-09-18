import http from 'node:http';
import type { ethers } from 'ethers';
import type { Config } from './config';
import type { Finding, Memo, Snapshot } from './checks';
import { blankMemo } from './checks';
import type { Pool, PoolSource, PoolSpec } from './pools';
import { alerts, type Notify } from './notify';

/**
 * What the watchdog knows about itself, and the read-only listener that serves
 * it. The ui consumes /status; the monitor never consumes keeper verdicts.
 * Nothing in here awaits the chain, and nothing in here can throw into the
 * check cycle.
 */

export interface Firing {
  onsetTs: number;
  lastNotifiedTs: number;
  f: Finding;
}

export interface PoolState {
  spec: PoolSpec;
  /** null until the boot-time decimals read succeeds. */
  pool: Pool | null;
  snapshot: Snapshot | null;
  memo: Memo;
}

export interface MonitorState {
  version: string;
  bootTs: number;
  source: PoolSource;
  lastCycleTs: number | null;
  lastCycleOk: boolean | null;
  consecutiveFailures: number;
  cycles: number;
  lastError: string | null;
  gasWei: ethers.BigNumber | null;
  pools: PoolState[];
  /** keyed `${pool.id}:${key}`; global findings (gas, the monitor itself) by bare key. */
  firing: Map<string, Firing>;
}

export type StatusConfig = Pick<
  Config,
  'rpcHost' | 'RPC_URL' | 'KEEPER' | 'DISCORD_WEBHOOK' | 'CHECK_INTERVAL_SECS' | 'REALERT_SECS' | 'FAIL_ALERT_CYCLES' | 'GAS_WARN_WEI' | 'GAS_FLOOR_WEI'
>;

export const RPC_FAILING = 'monitor-rpc-failing';

const nowTs = () => Math.floor(Date.now() / 1000);
const iso = (ts: number) => new Date(ts * 1000).toISOString();

export function createState(init: { version: string; source: PoolSource; specs: PoolSpec[]; now?: number }): MonitorState {
  return {
    version: init.version,
    bootTs: init.now ?? nowTs(),
    source: init.source,
    lastCycleTs: null,
    lastCycleOk: null,
    consecutiveFailures: 0,
    cycles: 0,
    lastError: null,
    gasWei: null,
    pools: init.specs.map((spec) => ({ spec, pool: null, snapshot: null, memo: blankMemo() })),
    firing: new Map(),
  };
}

export function setPools(state: MonitorState, pools: Pool[]): void {
  for (const ps of state.pools) {
    const p = pools.find((x) => x.id === ps.spec.id);
    if (p) ps.pool = p;
  }
}

/** every url form that could ride in an error message reduces to the host. */
export function scrub(msg: string, cfg: Pick<Config, 'RPC_URL' | 'rpcHost'>): string {
  return msg.split(cfg.RPC_URL).join(cfg.rpcHost).replace(/\/\/[^/@\s"]+@/g, '//');
}

export function noteCycle(state: MonitorState, ok: boolean, now = nowTs(), error: string | null = null): void {
  state.cycles += 1;
  state.lastCycleTs = now;
  state.lastCycleOk = ok;
  if (ok) {
    state.consecutiveFailures = 0;
    state.lastError = null;
  } else {
    state.consecutiveFailures += 1;
    state.lastError = error;
  }
}

/** a dead rpc is permanent silence otherwise; one critical after N failed cycles in a row. */
export function rpcFailingFinding(state: MonitorState, cfg: Pick<Config, 'FAIL_ALERT_CYCLES' | 'rpcHost'>): Finding | null {
  if (cfg.FAIL_ALERT_CYCLES <= 0 || state.consecutiveFailures < cfg.FAIL_ALERT_CYCLES) return null;
  return {
    key: RPC_FAILING, severity: 'critical', vault: null,
    title: 'Monitor cannot read the chain',
    detail: `${state.consecutiveFailures} consecutive check cycles have failed against ${cfg.rpcHost}` +
      `${state.lastError ? ` (last: ${state.lastError})` : ''}. Nothing below is being watched until this recovers.`,
  };
}

export const firingKey = (f: Finding): string => (f.vault ? `${f.vault}:${f.key}` : f.key);

export interface CycleResult {
  findings: Finding[];
  /** pool ids whose checks completed this cycle; only their findings may resolve. */
  checked: Set<string>;
  gasOk: boolean;
  cycleOk: boolean;
}

function labelOf(state: MonitorState, vault: string | null): string | null {
  if (!vault) return null;
  const ps = state.pools.find((p) => p.spec.id === vault);
  return ps?.pool?.label ?? ps?.spec.label ?? vault.slice(0, 10);
}

/**
 * The edge-triggered alert machine: fire on transition, repeat every
 * REALERT_SECS with the true onset, one recovery when the condition clears.
 * A severity change inside a key is an escalation, never a resolve.
 */
export async function reconcile(
  state: MonitorState,
  res: CycleResult,
  cfg: Pick<Config, 'REALERT_SECS'>,
  send: Notify,
  now = nowTs(),
): Promise<void> {
  const multi = state.pools.length > 1;
  const title = (f: Finding) => (multi && f.vault ? `[${labelOf(state, f.vault)}] ${f.title}` : f.title);
  const hours = (since: number) => Math.round((now - since) / 3600);
  const seen = new Set<string>();

  for (const f of res.findings) {
    const k = firingKey(f);
    seen.add(k);
    const prev = state.firing.get(k);
    if (!prev) {
      state.firing.set(k, { onsetTs: now, lastNotifiedTs: now, f });
      await send(f.severity, title(f), f.detail);
    } else if (prev.f.severity !== f.severity) {
      const was = prev.f.severity;
      prev.f = f;
      prev.lastNotifiedTs = now;
      await send(f.severity, title(f), `${f.detail}\n(was ${was}; firing since ${hours(prev.onsetTs)}h)`);
    } else if (now - prev.lastNotifiedTs >= cfg.REALERT_SECS) {
      prev.f = f;
      prev.lastNotifiedTs = now;
      await send(f.severity, title(f), `${f.detail}\n(still firing after ${hours(prev.onsetTs)}h)`);
    } else {
      prev.f = f; // keep the detail current for /status without re-notifying
    }
  }

  // a pool whose checks failed this cycle is unknown, not clear
  const resolvable = (k: string, f: Finding) =>
    f.vault ? res.checked.has(f.vault) : k === 'gas' ? res.gasOk : k === RPC_FAILING ? res.cycleOk : res.cycleOk;
  for (const [k, prev] of [...state.firing]) {
    if (seen.has(k) || !resolvable(k, prev.f)) continue;
    state.firing.delete(k);
    await send('recovered', `Resolved: ${title(prev.f)}`, 'Condition no longer detected.');
  }
}

// --- /status ------------------------------------------------------------------

function firingView(fs: Firing[]) {
  return fs.map(({ onsetTs, lastNotifiedTs, f }) => ({
    key: f.key, severity: f.severity, title: f.title, detail: f.detail, vault: f.vault,
    onsetAt: iso(onsetTs), lastNotifiedAt: iso(lastNotifiedTs),
  }));
}

export function serialise(state: MonitorState, cfg: StatusConfig, now = nowTs()) {
  const firing = [...state.firing.values()];
  const gasWei = state.gasWei ? state.gasWei.toString() : null;
  return {
    v: 1 as const,
    version: state.version,
    rpcHost: cfg.rpcHost,
    bootAt: iso(state.bootTs),
    lastCycleAt: state.lastCycleTs === null ? null : iso(state.lastCycleTs),
    lastCycleOk: state.lastCycleOk,
    consecutiveFailures: state.consecutiveFailures,
    cycles: state.cycles,
    stale: now - (state.lastCycleTs ?? state.bootTs) > 3 * cfg.CHECK_INTERVAL_SECS,
    lastError: state.lastError,
    source: state.source,
    webhook: cfg.DISCORD_WEBHOOK ? 'set' : 'unset',
    intervals: { checkIntervalSecs: cfg.CHECK_INTERVAL_SECS, realertSecs: cfg.REALERT_SECS, failAlertCycles: cfg.FAIL_ALERT_CYCLES },
    gas: { keeper: cfg.KEEPER, wei: gasWei, warnWei: cfg.GAS_WARN_WEI, floorWei: cfg.GAS_FLOOR_WEI },
    firing: firingView(firing.filter((x) => x.f.vault === null)),
    pools: state.pools.map(({ spec, pool, snapshot, memo }) => ({
      id: spec.id,
      label: pool?.label ?? spec.label ?? spec.id,
      resolved: pool !== null,
      addresses: { vault: spec.vault, pool: pool?.pool ?? spec.pool, proxy: spec.proxy, clearing: spec.clearing, feed: spec.feed, feed1: spec.feed1 },
      tokens: pool ? { sym0: pool.sym0, sym1: pool.sym1, dec0: pool.dec0, dec1: pool.dec1 } : null,
      thresholds: { ...spec.thresholds },
      lastOkAt: memo.lastOkTs === null ? null : iso(memo.lastOkTs),
      snapshot: snapshot ? { ...snapshot, gasWei } : null,
      firing: firingView(firing.filter((x) => x.f.vault === spec.id)),
    })),
    alerts: alerts(),
  };
}

function reply(res: http.ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), 'cache-control': 'no-store' });
  res.end(s);
}

/** GET /status + GET /healthz on the overlay; /healthz is process liveness only. */
export function startStatus(state: MonitorState, cfg: StatusConfig, port: number, host = '0.0.0.0'): http.Server {
  const server = http.createServer((req, res) => {
    try {
      if (req.method !== 'GET') return reply(res, 405, { error: 'method not allowed' });
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/healthz') return reply(res, 200, { ok: true });
      if (path === '/status') return reply(res, 200, serialise(state, cfg));
      return reply(res, 404, { error: 'not found' });
    } catch (e) {
      console.log(`status: request failed: ${(e as Error).message}`);
      try { reply(res, 500, { error: 'internal' }); } catch { /* socket gone */ }
    }
  });
  server.maxConnections = 8;
  server.headersTimeout = 4000;
  server.requestTimeout = 5000;
  // EADDRINUSE and friends log and leave the watchdog running without a listener
  server.on('error', (e) => console.log(`status listener error: ${(e as Error).message}`));
  server.listen(port, host);
  return server;
}
