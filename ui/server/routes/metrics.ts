import { Router } from 'express';
import { Gauge, Registry } from 'prom-client';
import { ctx, statusBody } from '../contract/serialize';
import { livenessRank } from '../derive/standing';
import { weiToNum } from '../contract/format';
import { fail } from './util';
import { streamClientCount } from './stream';

// /metrics — prom gauges labelled {vault}, rpc-status idiom. not public: only
// overlay source ips (rfc1918 / loopback) or a matching X-Metrics-Token get an
// answer; anything through traefik gets a 404, not a 403, so the endpoint does
// not advertise itself.

const PRIVATE_V4 = [/^10\./, /^127\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

export function isOverlayIp(ip: string | undefined): boolean {
  if (!ip) return false;
  const bare = ip.replace(/^::ffff:/, '');
  if (bare === '::1' || bare.startsWith('fd') || bare.startsWith('fc')) return true;
  return PRIVATE_V4.some((re) => re.test(bare));
}

function collect(): string | Promise<string> {
  const c = ctx();
  const reg = new Registry();
  const g = (name: string, help: string, labels: string[] = ['vault']) => new Gauge({ name, help, labelNames: labels, registers: [reg] });

  const up = g('gamma_ui_up', 'the ui process answered this scrape', []);
  up.set(1);
  const sources = g('gamma_source_reachable', 'source reachability (keeper, monitor, chain)', ['source']);
  const head = g('gamma_head_block', 'head block per source', ['source']);
  const liveness = g('gamma_vault_liveness_rank', 'liveness rank: 1 quiet .. 9 unreachable');
  const findingsG = g('gamma_findings_active', 'active findings', ['severity']);
  const gasG = g('gamma_signer_balance_eth', 'signer balance in ether', []);
  const runway = g('gamma_gas_runway_days', 'gas runway in days', []);
  const drift = g('gamma_drift_ticks', 'spot distance from the base band mid');
  const inBase = g('gamma_in_base', 'spot inside the base band');
  const sharePrice = g('gamma_share_price_token1', 'nav per share in token1');
  const standingSecs = g('gamma_standing_secs', 'seconds in the current standing', ['vault', 'code']);
  const streams = g('gamma_stream_clients', 'open sse clients', []);
  streams.set(streamClientCount());

  const s = statusBody(c, { compact: true });
  sources.set({ source: 'keeper' }, s.sources.keeper.reachable ? 1 : 0);
  sources.set({ source: 'monitor' }, s.sources.monitor.reachable ? 1 : 0);
  sources.set({ source: 'chain' }, s.sources.chain.ok ? 1 : 0);
  if (s.keeper.head) head.set({ source: 'keeper' }, s.keeper.head.number);
  if (s.sources.chain.head) head.set({ source: 'chain' }, s.sources.chain.head.number);
  if (s.sources.chain.fallbackHead) head.set({ source: 'chain-fallback' }, s.sources.chain.fallbackHead.number);
  const bal = s.keeper.gas?.signerBalanceWei ?? null;
  if (bal !== null) gasG.set(weiToNum(bal) ?? 0);
  if (s.keeper.gas?.runwayDays != null) runway.set(s.keeper.gas.runwayDays);
  for (const sev of ['info', 'warning', 'critical'] as const) {
    findingsG.set({ severity: sev }, s.findings.filter((f) => f.active && f.severity === sev).length);
  }
  for (const v of s.vaults) {
    liveness.set({ vault: v.label }, livenessRank(v.liveness));
    if (v.chain) {
      drift.set({ vault: v.label }, v.chain.base.driftTicks);
      inBase.set({ vault: v.label }, v.chain.base.inRange ? 1 : 0);
      if (v.chain.shares.sharePriceToken1 !== null) sharePrice.set({ vault: v.label }, v.chain.shares.sharePriceToken1);
    }
    if (v.keeper.standing) standingSecs.set({ vault: v.label, code: v.keeper.standing.code }, v.keeper.standing.secs);
  }
  return reg.metrics();
}

export function metricsRoutes(): Router {
  const r = Router();
  r.get('/metrics', (req, res) => {
    const c = ctx();
    const token = c.cfg.METRICS_TOKEN;
    const header = req.get('x-metrics-token');
    const allowed = (token !== undefined && header === token) || (header === undefined && isOverlayIp(req.ip));
    if (!allowed) {
      fail(req, res, 404, 'not-found', 'not found');
      return;
    }
    void Promise.resolve(collect())
      .then((body) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.send(body);
      })
      .catch(() => fail(req, res, 500, 'internal', 'metrics failed'));
  });
  return r;
}
