import { z } from 'zod';
import type { SQLInputValue } from 'node:sqlite';
import type { Db } from './index';
import { QUERY, type QueryName } from '../contract/enums';
import { QueryParams } from '../contract/types';
import { nowSec } from '../collect/util';

// /api/v1/queries: named, prepared, read-only. params are zod-validated
// (vault, from, to ≤ 90d apart, limit ≤ 5000); there is no free-form sql.
// `vault` is optional everywhere it applies: null = every vault.

export interface NamedQuery {
  name: QueryName;
  description: string;
  params: ReadonlyArray<'vault' | 'from' | 'to' | 'limit'>;
  sql: string;
}

const V = '(:vault IS NULL OR vault_id = :vault)';

export const QUERIES: Readonly<Record<QueryName, NamedQuery>> = {
  'outcome-histogram': {
    name: 'outcome-histogram',
    description: 'stored cycle rows (transitions + heartbeats) per outcome code in the window',
    params: ['vault', 'from', 'to', 'limit'],
    sql: `SELECT vault_id, outcome_code, COUNT(*) AS rows_, SUM(is_transition) AS transitions, MIN(block_ts) AS first_ts, MAX(block_ts) AS last_ts
          FROM cycles WHERE ${V} AND block_ts >= :from AND block_ts <= :to
          GROUP BY vault_id, outcome_code ORDER BY rows_ DESC LIMIT :limit`,
  },
  'standing-durations': {
    name: 'standing-durations',
    description: 'episode time per (code, subcode): how long the vault sat in each standing',
    params: ['vault', 'from', 'to', 'limit'],
    sql: `SELECT vault_id, code, subcode, COUNT(*) AS episodes, SUM(COALESCE(until_ts, :to) - since_ts) AS total_secs,
                 MAX(COALESCE(until_ts, :to) - since_ts) AS max_secs, SUM(cycles) AS cycles
          FROM episodes WHERE ${V} AND since_ts <= :to AND COALESCE(until_ts, :to) >= :from
          GROUP BY vault_id, code, subcode ORDER BY total_secs DESC LIMIT :limit`,
  },
  'gate-block-episodes': {
    name: 'gate-block-episodes',
    description: 'every gate-blocked run with its subcode and duration, newest first',
    params: ['vault', 'from', 'to', 'limit'],
    sql: `SELECT id, vault_id, subcode, since_ts, until_ts, COALESCE(until_ts, :to) - since_ts AS duration_secs, cycles, first_seq, last_seq, detail
          FROM episodes WHERE ${V} AND code = 'gate-blocked' AND since_ts <= :to AND COALESCE(until_ts, :to) >= :from
          ORDER BY since_ts DESC LIMIT :limit`,
  },
  'arm-events': {
    name: 'arm-events',
    description: 'transitions where a trigger was dwelling or armed',
    params: ['vault', 'from', 'to', 'limit'],
    sql: `SELECT id, vault_id, block_ts, block, seq, winner, armed_mask, outcome_code, drift_ticks, dwell_reb_secs, dwell_ref_secs, dwell_fold_secs
          FROM cycles WHERE ${V} AND is_transition = 1 AND (armed_mask > 0 OR outcome_code = 'arming') AND block_ts >= :from AND block_ts <= :to
          ORDER BY block_ts DESC LIMIT :limit`,
  },
  'rebalance-list': {
    name: 'rebalance-list',
    description: 'landed rebalance transactions (recenter / refresh / fold / unknown) with cost and compromise flags',
    params: ['vault', 'from', 'to', 'limit'],
    sql: `SELECT hash, vault_id, kind, block, ts, tick, base_lower, base_upper, limit_lower, limit_upper, gas_used, cost_wei, status, full_range, foreign_recipient
          FROM txs WHERE ${V} AND kind != 'compound' AND ts >= :from AND ts <= :to ORDER BY ts DESC LIMIT :limit`,
  },
  'rebalances-per-day': {
    name: 'rebalances-per-day',
    description: 'transactions per utc day and kind',
    params: ['vault', 'from', 'to', 'limit'],
    sql: `SELECT vault_id, date(ts, 'unixepoch') AS day, kind, COUNT(*) AS n, SUM(CAST(cost_wei AS REAL)) AS cost_wei
          FROM txs WHERE ${V} AND ts >= :from AND ts <= :to GROUP BY vault_id, day, kind ORDER BY day DESC, kind LIMIT :limit`,
  },
  'composition-extremes': {
    name: 'composition-extremes',
    description: 'samples ranked by |2X-1|: where the vault was most one-sided',
    params: ['vault', 'from', 'to', 'limit'],
    sql: `SELECT vault_id, ts, block, x, ABS(2 * x - 1) AS two_x_minus_one, spot_tick, base_lower, base_upper, in_base, share_price
          FROM samples WHERE ${V} AND x IS NOT NULL AND ts >= :from AND ts <= :to ORDER BY two_x_minus_one DESC LIMIT :limit`,
  },
  'deposit-flows': {
    name: 'deposit-flows',
    description: 'Deposit / Withdraw events with sender, recipient, shares and amounts',
    params: ['vault', 'from', 'to', 'limit'],
    sql: `SELECT vault_id, ts, block, tx_hash, log_index, kind,
                 json_extract(args_json, '$.sender') AS sender, json_extract(args_json, '$.to') AS recipient,
                 json_extract(args_json, '$.shares') AS shares, json_extract(args_json, '$.amount0') AS amount0, json_extract(args_json, '$.amount1') AS amount1
          FROM chain_events WHERE ${V} AND kind IN ('Deposit', 'Withdraw') AND ts >= :from AND ts <= :to ORDER BY ts DESC, log_index DESC LIMIT :limit`,
  },
  'fee-harvests': {
    name: 'fee-harvests',
    description: 'ZeroBurn events (gross fees, fee divisor) and the tx kind that produced them',
    params: ['vault', 'from', 'to', 'limit'],
    sql: `SELECT e.vault_id, e.ts, e.block, e.tx_hash, json_extract(e.args_json, '$.fee') AS fee_divisor,
                 json_extract(e.args_json, '$.fees0') AS fees0, json_extract(e.args_json, '$.fees1') AS fees1, t.kind
          FROM chain_events e LEFT JOIN txs t ON t.hash = e.tx_hash
          WHERE (:vault IS NULL OR e.vault_id = :vault) AND e.kind = 'ZeroBurn' AND e.ts >= :from AND e.ts <= :to
          ORDER BY e.ts DESC LIMIT :limit`,
  },
  'time-in-range': {
    name: 'time-in-range',
    description: 'per utc day from the hourly rollup: share of samples in base / in limit',
    params: ['vault', 'from', 'to', 'limit'],
    sql: `SELECT vault_id, date(ts, 'unixepoch') AS day, SUM(n) AS samples,
                 SUM(in_base_frac * n) / SUM(n) AS in_base_frac, SUM(in_limit_frac * n) / SUM(n) AS in_limit_frac,
                 MIN(share_price_min) AS share_price_min, MAX(share_price_max) AS share_price_max
          FROM samples_1h WHERE ${V} AND ts >= :from AND ts <= :to GROUP BY vault_id, day ORDER BY day DESC LIMIT :limit`,
  },
  'keeper-restarts': {
    name: 'keeper-restarts',
    description: 'one row per keeper boot (state-lost events), newest first',
    params: ['limit'],
    sql: `SELECT boot_at, version, signer, dry_run, config_fingerprint, last_seen_at FROM keeper_runs ORDER BY boot_at DESC LIMIT :limit`,
  },
  'source-outages': {
    name: 'source-outages',
    description: 'unreachable spells per source (keeper, monitor, rpc, rpc-fallback)',
    params: ['from', 'to', 'limit'],
    sql: `SELECT source, since_ts, until_ts, COALESCE(until_ts, :to) - since_ts AS duration_secs, detail
          FROM source_health WHERE reachable = 0 AND since_ts <= :to AND COALESCE(until_ts, :to) >= :from ORDER BY since_ts DESC LIMIT :limit`,
  },
};

export const DEFAULT_WINDOW_SECS = 30 * 86400;

export function isQueryName(s: string): s is QueryName {
  return (QUERY as readonly string[]).includes(s);
}

export function listQueries(): Array<{ name: QueryName; description: string; params: string[] }> {
  return QUERY.map((n) => ({ name: n, description: QUERIES[n].description, params: [...QUERIES[n].params] }));
}

export interface QueryResult {
  name: QueryName;
  params: Record<string, string | number>;
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

export class QueryError extends Error {
  constructor(
    readonly code: 'not-found' | 'bad-request',
    message: string,
  ) {
    super(message);
  }
}

// resolve the window: `to` defaults to now, `from` to 30d before `to`; the
// zod refine already caps the span at 90d
function resolveParams(q: NamedQuery, raw: Record<string, unknown>, now: number): { bound: Record<string, SQLInputValue>; echo: Record<string, string | number> } {
  const parsed = QueryParams.safeParse(raw);
  if (!parsed.success) throw new QueryError('bad-request', parsed.error.issues.map((i) => `${i.path.join('.') || '?'}: ${i.message}`).join('; '));
  const p = parsed.data;
  const to = p.to ?? now;
  const from = p.from ?? to - DEFAULT_WINDOW_SECS;
  if (from > to) throw new QueryError('bad-request', 'from: must not exceed to');
  const bound: Record<string, SQLInputValue> = {};
  const echo: Record<string, string | number> = {};
  for (const k of q.params) {
    if (k === 'vault') {
      bound.vault = p.vault ? p.vault.toLowerCase() : null;
      if (p.vault) echo.vault = p.vault.toLowerCase();
    } else if (k === 'from') {
      bound.from = from;
      echo.from = from;
    } else if (k === 'to') {
      bound.to = to;
      echo.to = to;
    } else {
      bound.limit = p.limit;
      echo.limit = p.limit;
    }
  }
  return { bound, echo };
}

function cell(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  return String(v);
}

export function runQuery(db: Db, name: string, raw: Record<string, unknown> = {}, now = nowSec()): QueryResult {
  if (!isQueryName(name)) throw new QueryError('not-found', 'unknown query');
  const q = QUERIES[name];
  const { bound, echo } = resolveParams(q, raw, now);
  const stmt = db.prepare(q.sql);
  const rows = stmt.all(bound) as Array<Record<string, unknown>>;
  const columns = rows.length > 0 ? Object.keys(rows[0]) : columnsOf(q.sql);
  return { name, params: echo, columns, rows: rows.map((r) => columns.map((c) => cell(r[c]))) };
}

// column names for an empty result: the select list's aliases / bare names
function columnsOf(sql: string): string[] {
  const m = /^\s*SELECT\s+([\s\S]*?)\s+FROM\s/i.exec(sql);
  if (!m) return [];
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of m[1]) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((expr) => {
    const t = expr.trim();
    const alias = /\sAS\s+(\w+)\s*$/i.exec(t);
    if (alias) return alias[1];
    const dot = t.lastIndexOf('.');
    return dot >= 0 ? t.slice(dot + 1) : t;
  });
}
