import type { CycleRecord, OutcomeCode, StandingKey } from '@keeper/record';
import type { Liveness } from '../contract/enums';
import type { StandingV1 } from '../contract/types';
import { fmtDur } from '../contract/format';

// standing (how long in the current outcome) and the liveness table
// (plan › ui › liveness). pure; the serialiser feeds it what the collectors saw.

export interface StandingSource {
  code: OutcomeCode;
  subcode: StandingKey['subcode'];
  sinceTs: number;
  seq: number;
}

export function standingV1(s: StandingSource | null, nowTs: number, cycles: number | null): StandingV1 | null {
  if (!s) return null;
  return {
    code: s.code,
    subcode: s.subcode,
    sinceTs: s.sinceTs,
    secs: Math.max(0, nowTs - s.sinceTs),
    cycles: cycles ?? 0,
  };
}

export const LEGIT_BLOCK: ReadonlySet<OutcomeCode> = new Set(['cooldown', 'gate-blocked', 'regime-extreme', 'no-regime-feed-unreadable']);
export const OPERATIONAL_BLOCK: ReadonlySet<OutcomeCode> = new Set([
  'gas-floor',
  'preflight-revert',
  'width-cap',
  'clamp-unworkable',
  'error',
]);

// a leg is armed, or the winner word is present without a counting dwell
export function armedLeg(rec: CycleRecord | null): 'rebalance' | 'refresh' | 'fold' | null {
  if (!rec) return null;
  if (rec.dwell.rebalance.armed) return 'rebalance';
  if (rec.dwell.refresh.armed) return 'refresh';
  if (rec.dwell.fold.armed) return 'fold';
  return null;
}

export function isDue(rec: CycleRecord | null): boolean {
  if (!rec) return false;
  return armedLeg(rec) !== null || rec.compoundDue || rec.winner !== 'hold';
}

// `TRIGGER 34m/34m`, `fold 12m`, null when nothing is counting
export function armedAction(rec: CycleRecord | null): string | null {
  if (!rec || rec.winner === 'hold') return null;
  const leg = rec.winner === 'TRIGGER' ? rec.dwell.rebalance : rec.winner === 'REFRESH' ? rec.dwell.refresh : rec.dwell.fold;
  if (leg.armed) return `${rec.winner} ${fmtDur(leg.heldSecs)}/${fmtDur(leg.requiredSecs)}`;
  const word = rec.winner === 'TRIGGER' ? 'trigger' : rec.winner === 'REFRESH' ? 'refresh' : 'fold';
  return `${word} ${fmtDur(leg.heldSecs)}`;
}

export interface LivenessInput {
  configured: boolean;
  reachable: boolean;
  misses: number;
  nowTs: number;
  bootAtTs: number | null;
  headAtTs: number | null;
  busySinceTs: number | null;
  // the vault's newest log line is `submitting rebalance via …`; the cycle has no
  // record yet (it is finalised only after tx.wait returns)
  submitting: boolean;
  record: CycleRecord | null;
  standing: StandingKey | null;
  // monitor rebalance-overdue firing on this vault
  monitorOverdue: boolean;
  // head frozen > 60s while a head on another provider advanced
  stalledEvidence: boolean;
}

export const RESTARTED_WINDOW_SECS = 7200;
export const STALL_HEAD_SECS = 60;
export const STALL_BUSY_SECS = 600;
export const ALIVE_BUSY_SECS = 300;

export function livenessFor(i: LivenessInput): Liveness {
  if (!i.configured || !i.reachable || i.misses >= 3) return 'unreachable';
  const busySecs = i.busySinceTs === null ? 0 : Math.max(0, i.nowTs - i.busySinceTs);
  const headAge = i.headAtTs === null ? null : Math.max(0, i.nowTs - i.headAtTs);
  if (busySecs > STALL_BUSY_SECS) return 'stalled';
  if (headAge !== null && headAge > STALL_HEAD_SECS && i.stalledEvidence) return 'stalled';
  const rec = i.record;
  // a finalised record can never say `submitting` (stage `submit` implies a tx
  // hash), so acting is the live state: mid-submit, or busy long enough that the
  // cycle is doing more than reading
  if (busySecs > 0 && (i.submitting || busySecs > ALIVE_BUSY_SECS)) return 'acting';
  const code = i.standing?.code ?? rec?.outcome.code ?? null;
  const due = isDue(rec);
  if (code && OPERATIONAL_BLOCK.has(code)) return 'blocked-operational';
  if (i.monitorOverdue) return 'blocked-operational';
  if (code && LEGIT_BLOCK.has(code)) return 'blocked-legit';
  if (due || code === 'arming' || code === 'compound-only') return 'due';
  if (i.bootAtTs !== null && i.nowTs - i.bootAtTs < RESTARTED_WINDOW_SECS) return 'restarted';
  if (rec && rec.winner === 'hold' && !rec.compoundDue) return 'quiet';
  return 'alive';
}

// worst first; the fleet header shows the worst of its vaults
const RANK: Record<Liveness, number> = {
  unreachable: 9,
  stalled: 8,
  'blocked-operational': 7,
  acting: 6,
  'blocked-legit': 5,
  due: 4,
  restarted: 3,
  alive: 2,
  quiet: 1,
};

export function worstLiveness(xs: Liveness[]): Liveness {
  let w: Liveness = 'quiet';
  for (const x of xs) if (RANK[x] > RANK[w]) w = x;
  return w;
}

export function livenessRank(l: Liveness): number {
  return RANK[l];
}
