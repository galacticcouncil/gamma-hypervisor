import type { Db } from './index';
import { log, nowSec, tick } from '../collect/util';

// hourly retention. only the bounded series are trimmed; cycles, episodes,
// txs, chain_events, samples_1h, findings, keeper_runs are kept forever.

export interface RetentionOpts {
  // cycles_raw, hours; 0 disables
  rawRetentionHours: number;
  // samples, days
  sampleRetentionDays: number;
  now?: () => number;
}

export const RETENTION = {
  keeperStatusDays: 30,
  keeperLinesDays: 7,
  eventsLogDays: 30,
} as const;

export interface RetentionResult {
  cyclesRaw: number;
  keeperStatus: number;
  keeperLines: number;
  samples: number;
  eventsLog: number;
}

export function runRetention(db: Db, o: RetentionOpts): RetentionResult {
  const now = (o.now ?? nowSec)();
  const out: RetentionResult = { cyclesRaw: 0, keeperStatus: 0, keeperLines: 0, samples: 0, eventsLog: 0 };
  db.transaction(() => {
    if (o.rawRetentionHours > 0) {
      out.cyclesRaw = db.run('DELETE FROM cycles_raw WHERE received_at < :t', { t: now - o.rawRetentionHours * 3600 }).changes;
    }
    out.keeperStatus = db.run('DELETE FROM keeper_status WHERE ts < :t', { t: now - RETENTION.keeperStatusDays * 86400 }).changes;
    out.keeperLines = db.run('DELETE FROM keeper_lines WHERE ts < :t', { t: now - RETENTION.keeperLinesDays * 86400 }).changes;
    out.samples = db.run('DELETE FROM samples WHERE ts < :t', { t: now - o.sampleRetentionDays * 86400 }).changes;
    out.eventsLog = db.run('DELETE FROM events_log WHERE ts < :t', { t: now - RETENTION.eventsLogDays * 86400 }).changes;
  });
  return out;
}

export function startRetention(db: Db, o: RetentionOpts, everyMs = 3600_000): () => void {
  const run = (): void => {
    try {
      const r = runRetention(db, o);
      tick('retention', true);
      const total = r.cyclesRaw + r.keeperStatus + r.keeperLines + r.samples + r.eventsLog;
      if (total > 0) log('db/retention', `deleted raw=${r.cyclesRaw} status=${r.keeperStatus} lines=${r.keeperLines} samples=${r.samples} events=${r.eventsLog}`);
    } catch (e) {
      tick('retention', false);
      log('db/retention', `failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const t = setInterval(run, everyMs);
  t.unref?.();
  setTimeout(run, 60_000).unref?.();
  return () => clearInterval(t);
}
