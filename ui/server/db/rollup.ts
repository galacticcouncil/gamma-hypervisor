import type { Db } from './index';
import { log, nowSec, tick } from '../collect/util';

// samples -> samples_1h, complete hours only, forever. "last" = the latest
// non-null value in the hour; fractions are over the rows that had the field.

export const HOUR = 3600;
const MAX_HOURS_PER_RUN = 24 * 90;

type SampleRow = {
  ts: number;
  price_human: number | null;
  nav1: number | null;
  share_price: number | null;
  x: number | null;
  in_base: number | null;
  in_limit: number | null;
  fees1_value: number | null;
  gas_wei: string | null;
}

export type HourRow = {
  vault_id: string;
  ts: number;
  n: number;
  price_last: number | null;
  nav1_last: number | null;
  share_price_last: number | null;
  share_price_min: number | null;
  share_price_max: number | null;
  x_avg: number | null;
  in_base_frac: number | null;
  in_limit_frac: number | null;
  fees1_value_last: number | null;
  gas_wei_last: string | null;
}

function lastNonNull<T>(rows: SampleRow[], pick: (r: SampleRow) => T | null): T | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = pick(rows[i]);
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

function frac(rows: SampleRow[], pick: (r: SampleRow) => number | null): number | null {
  let n = 0;
  let sum = 0;
  for (const r of rows) {
    const v = pick(r);
    if (v === null) continue;
    n++;
    sum += v;
  }
  return n === 0 ? null : sum / n;
}

export function aggregateHour(vault: string, hourTs: number, rows: SampleRow[]): HourRow | null {
  if (rows.length === 0) return null;
  const sp = rows.map((r) => r.share_price).filter((v): v is number => v !== null);
  return {
    vault_id: vault,
    ts: hourTs,
    n: rows.length,
    price_last: lastNonNull(rows, (r) => r.price_human),
    nav1_last: lastNonNull(rows, (r) => r.nav1),
    share_price_last: lastNonNull(rows, (r) => r.share_price),
    share_price_min: sp.length ? Math.min(...sp) : null,
    share_price_max: sp.length ? Math.max(...sp) : null,
    x_avg: frac(rows, (r) => r.x),
    in_base_frac: frac(rows, (r) => r.in_base),
    in_limit_frac: frac(rows, (r) => r.in_limit),
    fees1_value_last: lastNonNull(rows, (r) => r.fees1_value),
    gas_wei_last: lastNonNull(rows, (r) => r.gas_wei),
  };
}

const UPSERT = `INSERT OR REPLACE INTO samples_1h (vault_id, ts, n, price_last, nav1_last, share_price_last, share_price_min, share_price_max,
  x_avg, in_base_frac, in_limit_frac, fees1_value_last, gas_wei_last)
VALUES (:vault_id, :ts, :n, :price_last, :nav1_last, :share_price_last, :share_price_min, :share_price_max,
  :x_avg, :in_base_frac, :in_limit_frac, :fees1_value_last, :gas_wei_last)`;

export function rollupHour(db: Db, vault: string, hourTs: number): HourRow | null {
  const rows = db.all<SampleRow>(
    'SELECT ts, price_human, nav1, share_price, x, in_base, in_limit, fees1_value, gas_wei FROM samples WHERE vault_id = :v AND ts >= :a AND ts < :b ORDER BY ts',
    { v: vault, a: hourTs, b: hourTs + HOUR },
  );
  const agg = aggregateHour(vault, hourTs, rows);
  if (agg) db.run(UPSERT, agg);
  return agg;
}

export interface RollupResult {
  hours: number;
  vaults: number;
}

// roll every complete hour after the last rolled one (or the first sample) per vault
export function runRollup(db: Db, now = nowSec()): RollupResult {
  const lastComplete = Math.floor(now / HOUR) * HOUR - HOUR;
  const vaults = db.all<{ vault_id: string; first_ts: number }>('SELECT vault_id, MIN(ts) AS first_ts FROM samples GROUP BY vault_id');
  let hours = 0;
  db.transaction(() => {
    for (const v of vaults) {
      const rolled = db.get<{ ts: number | null }>('SELECT MAX(ts) AS ts FROM samples_1h WHERE vault_id = :v', { v: v.vault_id })?.ts ?? null;
      let h = rolled === null ? Math.floor(v.first_ts / HOUR) * HOUR : rolled + HOUR;
      let budget = MAX_HOURS_PER_RUN;
      for (; h <= lastComplete && budget > 0; h += HOUR, budget--) {
        if (rollupHour(db, v.vault_id, h)) hours++;
      }
    }
  });
  return { hours, vaults: vaults.length };
}

export function startRollup(db: Db, everyMs = 3600_000): () => void {
  const run = (): void => {
    try {
      const r = runRollup(db);
      tick('rollup', true);
      if (r.hours > 0) log('db/rollup', `rolled ${r.hours} hour(s) over ${r.vaults} vault(s)`);
    } catch (e) {
      tick('rollup', false);
      log('db/rollup', `failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const t = setInterval(run, everyMs);
  t.unref?.();
  setTimeout(run, 90_000).unref?.();
  return () => clearInterval(t);
}
