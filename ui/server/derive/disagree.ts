import type { CycleRecord } from '@keeper/record';
import type { Db, Row } from '../db/index';
import type { FindingKey, FindingSeverity, FindingSource } from '../contract/enums';
import type { ConfigValue, Disagreement, DriftRow, Finding, KeeperConfig, MonitorFiring, VaultDescriptor } from '../contract/types';
import { fmtClock, fmtDur, fmtHash } from '../contract/format';
import { armedLeg } from './standing';

// the ui's own findings (plan › data model › disagreement rules), evaluated
// every 10s from what the collectors saw. slow verdicts only, with age
// windows — the keeper's gate values are stale by design on quiet blocks, so
// every keeper-vs-chain compare is by asOf.block with a grace, never by wall
// clock alone.

export interface RuleFinding {
  vault: string | null;
  key: FindingKey;
  severity: FindingSeverity;
  title: string;
  detail: string;
  // when the source says it started; defaults to first-seen
  onsetTs?: number;
}

export interface HeadLite {
  number: number;
  atTs: number;
}

export const STALL_HEAD_SECS = 60;
export const STALL_BUSY_SECS = 600;
export const GATE_GRACE_SECS = 120;
export const GATE_BLOCK_TOLERANCE = 1;
export const INBAND_WINDOW_SECS = 600;
export const STATE_LOST_SECS = 7200;
export const FULL_RANGE_TICK = 886800;

export interface StalledInput {
  keeperHead: HeadLite | null;
  busySinceTs: number | null;
  uiHead: HeadLite | null;
  fallbackHead: HeadLite | null;
  // ui rpc host == keeper rpc host: the ui head is no evidence
  chainRpcShared: boolean;
  fallbackShared: boolean;
  nowTs: number;
}

// head frozen > 60s while a head on another provider advanced, or busy > 10 min
export function stalledCheck(i: StalledInput): { headPlus: number; frozenSecs: number } | null {
  const busySecs = i.busySinceTs === null ? 0 : Math.max(0, i.nowTs - i.busySinceTs);
  if (busySecs > STALL_BUSY_SECS) return { headPlus: 0, frozenSecs: busySecs };
  if (!i.keeperHead) return null;
  const frozenSecs = Math.max(0, i.nowTs - i.keeperHead.atTs);
  if (frozenSecs <= STALL_HEAD_SECS) return null;
  let plus = 0;
  if (!i.chainRpcShared && i.uiHead) plus = Math.max(plus, i.uiHead.number - i.keeperHead.number);
  if (!i.fallbackShared && i.fallbackHead) plus = Math.max(plus, i.fallbackHead.number - i.keeperHead.number);
  return plus > 0 ? { headPlus: plus, frozenSecs } : null;
}

export interface SampleLite {
  ts: number;
  block: number | null;
  gateOk: boolean | null;
  gateFailedAt: string | null;
  inBase: boolean | null;
  baseLower: number | null;
  baseUpper: number | null;
}

export interface FlaggedTx {
  hash: string;
  ts: number;
  fullRange: boolean;
  foreignRecipient: boolean;
}

export interface VaultRuleInput {
  id: string;
  label: string;
  record: CycleRecord | null;
  // the sample nearest the record's asOf block
  sampleNearRecord: SampleLite | null;
  latestSample: SampleLite | null;
  monitorFiring: MonitorFiring[];
  monitorCheckedAtTs: number | null;
  flaggedTxs: FlaggedTx[];
  // the descriptor says this vault runs live (no DRY_RUN there)
  descriptorLive: boolean;
}

function near(rec: CycleRecord, s: SampleLite): boolean {
  if (s.block !== null && Math.abs(s.block - rec.block) <= GATE_BLOCK_TOLERANCE) return true;
  return Math.abs(s.ts - rec.blockTs) <= GATE_GRACE_SECS;
}

// a deviation within ±1 tick of its cap is borderline on both sides; not a disagreement
function borderline(rec: CycleRecord): boolean {
  const g = rec.gate;
  if (!g) return false;
  const near1 = (dev: number, cap: number) => Math.abs(dev - cap) <= 1;
  return (g.twap ? near1(g.twap.devTicks, g.twap.maxDevTicks) : false) || (g.oracle ? near1(g.oracle.devTicks, g.oracle.maxDevTicks) : false);
}

export function disagreementsFor(v: VaultRuleInput, nowTs: number): Disagreement[] {
  const out: Disagreement[] = [];
  const rec = v.record;
  if (!rec) return out;

  // gate: keeper saw ok/fail at block B vs the sample nearest B
  const s = v.sampleNearRecord;
  if (rec.gate?.evaluated && s && near(rec, s) && s.gateOk !== null && s.gateOk !== rec.gate.ok && !borderline(rec)) {
    out.push({
      key: 'gate',
      keeper: rec.gate.ok ? 'ok' : (rec.gate.failedAt ?? 'fail'),
      chain: s.gateOk ? 'ok' : (s.gateFailedAt ?? 'fail'),
      sinceSecs: Math.max(0, nowTs - rec.blockTs),
      detail: `keeper saw gate ${rec.gate.ok ? 'pass' : 'fail'} at #${rec.block}; chain sample at #${s.block ?? '?'} says ${s.gateOk ? 'pass' : 'fail'}`,
    });
  }

  // monitor overdue/stranded while the keeper has nothing armed — the one that matters
  const recFresh = nowTs - rec.blockTs <= INBAND_WINDOW_SECS;
  const monFresh = v.monitorCheckedAtTs !== null && nowTs - v.monitorCheckedAtTs <= INBAND_WINDOW_SECS;
  if (recFresh && monFresh && armedLeg(rec) === null && rec.winner === 'hold') {
    for (const f of v.monitorFiring) {
      if (f.key !== 'rebalance-overdue' && f.key !== 'limit-stranded') continue;
      const onset = Math.floor(Date.parse(f.onsetAt) / 1000);
      out.push({
        key: f.key,
        keeper: 'nothing armed',
        chain: 'firing',
        sinceSecs: Number.isFinite(onset) ? Math.max(0, nowTs - onset) : 0,
        detail: `monitor ${f.key} firing (${f.title}) while the keeper's last cycle at #${rec.block} holds`,
      });
    }
  }

  // in-band: both readings < 10 min old, same base band
  const l = v.latestSample;
  const outside = rec.triggers?.rebalance.outside ?? null;
  if (
    l &&
    outside !== null &&
    l.inBase !== null &&
    recFresh &&
    nowTs - l.ts <= INBAND_WINDOW_SECS &&
    l.baseLower === rec.reads?.base[0] &&
    l.baseUpper === rec.reads?.base[1] &&
    outside === l.inBase
  ) {
    out.push({
      key: 'in-band',
      keeper: outside ? 'outside' : 'inside',
      chain: l.inBase ? 'inside' : 'outside',
      sinceSecs: Math.max(0, nowTs - Math.max(rec.blockTs, l.ts)),
      detail: `keeper #${rec.block} says spot ${outside ? 'outside' : 'inside'} base; chain sample says ${l.inBase ? 'inside' : 'outside'}`,
    });
  }
  return out;
}

export interface RulesInput {
  nowTs: number;
  keeper: {
    configured: boolean;
    reachable: boolean;
    misses: number;
    unreachableSinceTs: number | null;
    mode: 'LIVE' | 'DRY_RUN' | null;
    bootAtTs: number | null;
    fingerprint: string | null;
    previousFingerprint: string | null;
    rpcHost: string | null;
    head: HeadLite | null;
    busySinceTs: number | null;
  };
  ui: {
    rpcHost: string;
    fallbackHost: string | null;
    head: HeadLite | null;
    fallbackHead: HeadLite | null;
  };
  drift: DriftRow[];
  vaults: VaultRuleInput[];
}

export function uiFindings(i: RulesInput): RuleFinding[] {
  const out: RuleFinding[] = [];
  const k = i.keeper;

  if (k.configured && (k.misses >= 3 || (!k.reachable && k.unreachableSinceTs !== null))) {
    out.push({
      vault: null,
      key: 'keeper-unreachable',
      severity: 'critical',
      title: 'keeper unreachable',
      detail: `no /status for ${k.misses} polls${k.unreachableSinceTs !== null ? ` since ${fmtClock(k.unreachableSinceTs)}` : ''}`,
      onsetTs: k.unreachableSinceTs ?? undefined,
    });
  }

  const shared = k.rpcHost !== null && k.rpcHost === i.ui.rpcHost;
  const fallbackShared = k.rpcHost !== null && i.ui.fallbackHost === k.rpcHost;
  if (k.configured && k.reachable) {
    const st = stalledCheck({
      keeperHead: k.head,
      busySinceTs: k.busySinceTs,
      uiHead: i.ui.head,
      fallbackHead: i.ui.fallbackHead,
      chainRpcShared: shared,
      fallbackShared,
      nowTs: i.nowTs,
    });
    if (st) {
      out.push({
        vault: null,
        key: 'keeper-stalled',
        severity: 'critical',
        title: 'keeper stalled',
        detail: st.headPlus > 0 ? `head +${st.headPlus} blocks elsewhere, keeper head frozen ${fmtDur(st.frozenSecs)}` : `busy for ${fmtDur(st.frozenSecs)}`,
      });
    }
  }

  if (shared) {
    out.push({
      vault: null,
      key: 'chain-rpc-shared',
      severity: 'warning',
      title: 'ui and keeper share an rpc provider',
      detail: `both read ${k.rpcHost}; a frozen head would blind keeper, monitor and ui together`,
    });
  }

  if (k.mode === 'DRY_RUN' && i.vaults.some((v) => v.descriptorLive)) {
    out.push({
      vault: null,
      key: 'dry-run-live',
      severity: 'critical',
      title: 'keeper is dry-running a live vault',
      detail: 'keeper reports DRY_RUN while the descriptor says live: it looks healthy and does nothing',
    });
  }

  if (k.bootAtTs !== null && i.nowTs - k.bootAtTs < STATE_LOST_SECS) {
    out.push({
      vault: null,
      key: 'state-lost',
      severity: 'info',
      title: 'keeper restarted',
      detail: `restarted ${fmtDur(i.nowTs - k.bootAtTs)} ago · dwell/regime/price trail reset`,
      onsetTs: k.bootAtTs,
    });
  }

  const fpChanged = k.fingerprint !== null && k.previousFingerprint !== null && k.fingerprint !== k.previousFingerprint;
  if (fpChanged || i.drift.length > 0) {
    const rows = i.drift.slice(0, 5).map((d) => `${d.key}: descriptor ${fmtValue(d.descriptor)} vs keeper ${fmtValue(d.keeper)}`);
    out.push({
      vault: null,
      key: 'config-drift',
      severity: 'warning',
      title: 'config drift',
      detail: fpChanged && rows.length === 0 ? 'keeper config fingerprint changed without a restart' : rows.join('; '),
    });
  }

  for (const v of i.vaults) {
    const dis = disagreementsFor(v, i.nowTs);
    if (dis.length > 0) {
      const critical = dis.some((d) => d.key === 'rebalance-overdue' || d.key === 'limit-stranded');
      out.push({
        vault: v.id,
        key: 'keeper-chain-disagree',
        severity: critical ? 'critical' : 'warning',
        title: `keeper and chain disagree on ${dis.map((d) => d.key).join(', ')}`,
        detail: dis.map((d) => d.detail).join('; '),
      });
    }
    for (const t of v.flaggedTxs) {
      if (t.fullRange) {
        out.push({
          vault: v.id,
          key: 'full-range',
          severity: 'critical',
          title: 'full-range rebalance',
          detail: `rebalance ${fmtHash(t.hash)} placed a full-range band (ticks beyond ±${FULL_RANGE_TICK})`,
          onsetTs: t.ts,
        });
      }
      if (t.foreignRecipient) {
        out.push({
          vault: v.id,
          key: 'foreign-recipient',
          severity: 'critical',
          title: 'foreign fee recipient',
          detail: `rebalance ${fmtHash(t.hash)} named a fee recipient other than the configured FEE_RECIPIENT`,
          onsetTs: t.ts,
        });
      }
    }
  }
  return out;
}

function fmtValue(v: ConfigValue): string {
  if (v === null) return 'null';
  if (typeof v === 'object') return v.host;
  return String(v);
}

// --- config drift ---------------------------------------------------------------

const SIBLING_KEY = /^(MONITOR_|UI_)|^LABEL$/;

function norm(v: ConfigValue | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (v === null) return 'null';
  if (typeof v === 'object') return v.host.toLowerCase();
  return String(v).trim().toLowerCase();
}

// descriptor vs keeper /config, per VAULT_KEY; sibling keys (MONITOR_*, UI_*, LABEL) are not the keeper's
export function configDrift(descriptor: VaultDescriptor[] | null, keeper: KeeperConfig | null): DriftRow[] {
  if (!descriptor || !keeper) return [];
  const out: DriftRow[] = [];
  for (const d of descriptor) {
    const vid = norm(d.VAULT);
    if (!vid) continue;
    const kv = keeper.vaults.find((v) => norm(v.VAULT) === vid);
    if (!kv) {
      out.push({ vault: vid, key: 'VAULT', descriptor: d.VAULT ?? null, keeper: null });
      continue;
    }
    for (const [key, dv] of Object.entries(d)) {
      if (SIBLING_KEY.test(key)) continue;
      const kvv = kv[key];
      if (kvv === undefined) continue;
      if (norm(dv) !== norm(kvv)) out.push({ vault: vid, key, descriptor: dv, keeper: kvv });
    }
  }
  return out;
}

// --- findings table -----------------------------------------------------------

interface FindingRow extends Row {
  id: number;
  vault_id: string | null;
  source: FindingSource;
  key: FindingKey;
  severity: FindingSeverity;
  title: string;
  detail: string;
  onset_ts: number;
  last_seen_ts: number;
  cleared_ts: number | null;
}

// upsert the active set for one source; open rows not in it are cleared
export function reconcileFindings(
  db: Db,
  source: FindingSource,
  active: RuleFinding[],
  nowTs: number,
): { opened: number[]; cleared: number[]; seen: number[] } {
  return db.transaction(() => {
    const open = db.all<FindingRow>('SELECT * FROM findings WHERE source = :s AND cleared_ts IS NULL', { s: source });
    const keyOf = (v: string | null, k: string) => `${v ?? ''}|${k}`;
    const openBy = new Map(open.map((r) => [keyOf(r.vault_id, r.key), r]));
    const opened: number[] = [];
    const seen: number[] = [];
    const kept = new Set<string>();
    for (const f of active) {
      const key = keyOf(f.vault, f.key);
      if (kept.has(key)) continue;
      kept.add(key);
      const row = openBy.get(key);
      if (row) {
        db.run('UPDATE findings SET last_seen_ts = :t, severity = :sev, title = :ti, detail = :d WHERE id = :id', {
          t: nowTs,
          sev: f.severity,
          ti: f.title,
          d: f.detail,
          id: row.id,
        });
        seen.push(row.id);
      } else {
        const r = db.run(
          `INSERT INTO findings (vault_id, source, key, severity, title, detail, onset_ts, last_seen_ts, cleared_ts)
           VALUES (:v, :s, :k, :sev, :ti, :d, :o, :t, NULL)`,
          { v: f.vault, s: source, k: f.key, sev: f.severity, ti: f.title, d: f.detail, o: f.onsetTs ?? nowTs, t: nowTs },
        );
        opened.push(r.lastInsertRowid);
      }
    }
    const cleared: number[] = [];
    for (const r of open) {
      if (kept.has(keyOf(r.vault_id, r.key))) continue;
      db.run('UPDATE findings SET cleared_ts = :t WHERE id = :id', { t: nowTs, id: r.id });
      cleared.push(r.id);
    }
    return { opened, cleared, seen };
  });
}

export function findingFromRow(r: Row, staleSources: ReadonlySet<FindingSource> = new Set()): Finding {
  const f = r as FindingRow;
  const iso = (t: number | null) => (t === null ? null : new Date(t * 1000).toISOString());
  return {
    id: f.id,
    vault: f.vault_id ?? null,
    source: f.source,
    key: f.key,
    severity: f.severity,
    title: f.title ?? '',
    detail: f.detail ?? '',
    onsetAt: iso(f.onset_ts) ?? new Date(0).toISOString(),
    lastSeenAt: iso(f.last_seen_ts) ?? iso(f.onset_ts) ?? new Date(0).toISOString(),
    clearedAt: iso(f.cleared_ts),
    active: f.cleared_ts === null,
    stale: f.cleared_ts === null && staleSources.has(f.source),
  };
}

// worst first: critical > warning > info, then most recent onset
const SEV_RANK: Record<FindingSeverity, number> = { critical: 3, warning: 2, info: 1 };
export function sortFindings<T extends { severity: FindingSeverity; onsetAt: string }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.onsetAt.localeCompare(a.onsetAt));
}
