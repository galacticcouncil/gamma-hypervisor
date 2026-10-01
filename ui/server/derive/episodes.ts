import { sameStanding, standingOf, type CycleRecord, type GateFailedAt, type OutcomeCode } from '@keeper/record';
import type { Db, Row } from '../db/index';
import type { Episode } from '../contract/types';

// the episode machine: a run of identical (outcome.code, gate.failedAt) across
// consecutive records is one row — "how long has it been blocked". the pure
// step is here so the keeper collector, the queries and the tests share it;
// the db writer honours the one-open-episode-per-vault index.

export interface OpenEpisode {
  id: number | null;
  vault: string;
  code: OutcomeCode;
  subcode: GateFailedAt | null;
  sinceTs: number;
  firstSeq: number;
  lastSeq: number;
  cycles: number;
  detail: string;
}

export interface EpisodeStep {
  // the episode that just ended (untilTs = this record's blockTs), if any
  close: OpenEpisode | null;
  open: OpenEpisode;
}

export function stepEpisode(open: OpenEpisode | null, rec: CycleRecord): EpisodeStep {
  const key = standingOf(rec);
  if (open && sameStanding(open, key)) {
    return {
      close: null,
      open: { ...open, lastSeq: rec.seq, cycles: open.cycles + 1, detail: rec.outcome.detail || open.detail },
    };
  }
  return {
    close: open,
    open: {
      id: null,
      vault: rec.vault.id,
      code: key.code,
      subcode: key.subcode,
      sinceTs: rec.blockTs,
      firstSeq: rec.seq,
      lastSeq: rec.seq,
      cycles: 1,
      detail: rec.outcome.detail,
    },
  };
}

interface EpisodeRow extends Row {
  id: number;
  vault_id: string;
  code: OutcomeCode;
  subcode: GateFailedAt | null;
  since_ts: number;
  until_ts: number | null;
  first_seq: number;
  last_seq: number;
  cycles: number;
  detail: string | null;
}

export function openEpisodeRow(db: Db, vault: string): OpenEpisode | null {
  const r = db.get<EpisodeRow>('SELECT * FROM episodes WHERE vault_id = :v AND until_ts IS NULL', { v: vault });
  if (!r) return null;
  return {
    id: r.id,
    vault: r.vault_id,
    code: r.code,
    subcode: r.subcode,
    sinceTs: r.since_ts,
    firstSeq: r.first_seq,
    lastSeq: r.last_seq,
    cycles: r.cycles,
    detail: r.detail ?? '',
  };
}

// folds one record into the episodes table; returns the open episode's id
export function applyRecord(db: Db, rec: CycleRecord): { closedId: number | null; openId: number; changed: boolean } {
  return db.transaction(() => {
    const open = openEpisodeRow(db, rec.vault.id);
    const step = stepEpisode(open, rec);
    let closedId: number | null = null;
    if (step.close && step.close.id !== null) {
      db.run('UPDATE episodes SET until_ts = :u, last_seq = :l, cycles = :c WHERE id = :id', {
        u: rec.blockTs,
        l: step.close.lastSeq,
        c: step.close.cycles,
        id: step.close.id,
      });
      closedId = step.close.id;
    }
    if (step.open.id !== null) {
      db.run('UPDATE episodes SET last_seq = :l, cycles = :c, detail = :d WHERE id = :id', {
        l: step.open.lastSeq,
        c: step.open.cycles,
        d: step.open.detail,
        id: step.open.id,
      });
      return { closedId, openId: step.open.id, changed: false };
    }
    const r = db.run(
      `INSERT INTO episodes (vault_id, code, subcode, since_ts, until_ts, first_seq, last_seq, cycles, detail)
       VALUES (:v, :c, :s, :since, NULL, :f, :l, :n, :d)`,
      {
        v: step.open.vault,
        c: step.open.code,
        s: step.open.subcode,
        since: step.open.sinceTs,
        f: step.open.firstSeq,
        l: step.open.lastSeq,
        n: step.open.cycles,
        d: step.open.detail,
      },
    );
    return { closedId, openId: r.lastInsertRowid, changed: true };
  });
}

export function episodeFromRow(r: Row, nowTs: number): Episode {
  const e = r as EpisodeRow;
  const until = e.until_ts ?? null;
  return {
    id: e.id,
    vault: e.vault_id,
    code: e.code,
    subcode: e.subcode ?? null,
    sinceTs: e.since_ts,
    untilTs: until,
    durationSecs: Math.max(0, (until ?? nowTs) - e.since_ts),
    cycles: e.cycles ?? 0,
    firstSeq: e.first_seq ?? 0,
    lastSeq: e.last_seq ?? 0,
    detail: e.detail ?? '',
  };
}

// Σ duration of gate-blocked episodes since `sinceTs`, grouped by subcode — the §7.3 lockout is one row
export function gateBlockedSecs(db: Db, vault: string, sinceTs: number, nowTs: number): Array<{ subcode: string | null; secs: number; episodes: number }> {
  const rows = db.all<EpisodeRow>(
    `SELECT * FROM episodes WHERE vault_id = :v AND code = 'gate-blocked' AND COALESCE(until_ts, :now) > :since ORDER BY since_ts`,
    { v: vault, now: nowTs, since: sinceTs },
  );
  const out = new Map<string | null, { subcode: string | null; secs: number; episodes: number }>();
  for (const r of rows) {
    const from = Math.max(r.since_ts, sinceTs);
    const to = r.until_ts ?? nowTs;
    const cur = out.get(r.subcode) ?? { subcode: r.subcode, secs: 0, episodes: 0 };
    cur.secs += Math.max(0, to - from);
    cur.episodes += 1;
    out.set(r.subcode, cur);
  }
  return [...out.values()].sort((a, b) => b.secs - a.secs);
}
