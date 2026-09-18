import type { Dwell, Gate, GateFailedAt, OutcomeCode, StandingKey, Winner } from '@keeper/record';
import type { Liveness, VerdictLevel } from '../contract/enums';
import type { Verdict } from '../contract/types';
import { fmtClock, fmtDur } from '../contract/format';

// the verdict decision table (plan › api contract). one function, shared by
// the serialiser and the page, so /status.vaults[].verdict.sentence and the
// drill's `verdict` row can never disagree.

export const OK_CODES: ReadonlySet<OutcomeCode> = new Set(['hold', 'arming', 'compound-only', 'landed']);
export const HELD_CODES: ReadonlySet<OutcomeCode> = new Set([
  'cooldown',
  'gate-blocked',
  'regime-extreme',
  'no-regime-feed-unreadable',
]);
export const FAULT_CODES: ReadonlySet<OutcomeCode> = new Set([
  'gas-floor',
  'width-cap',
  'clamp-unworkable',
  'preflight-revert',
  'error',
]);

export interface VerdictInput {
  // KEEPER_URL is set: an unset one is a deployment choice, not an outage
  configured: boolean;
  standing: StandingKey | null;
  // outcome.detail of the latest record
  detail: string | null;
  sinceTs: number | null;
  nowTs: number;
  liveness: Liveness;
  winner: Winner | null;
  dwell: Dwell | null;
  spotTick: number | null;
  gate: Gate | null;
  compoundDueInSecs: number | null;
  // keeper reports DRY_RUN while the descriptor says live
  dryRunLive: boolean;
  // title of a firing monitor critical, if any
  monitorCritical: string | null;
  disagreements: number;
  unreachableSinceTs: number | null;
  stalled: { headPlus: number; frozenSecs: number } | null;
}

// what is holding the work, in words
export function gateName(code: OutcomeCode, subcode: GateFailedAt | null): string {
  if (code === 'cooldown') return 'cooldown';
  if (code === 'regime-extreme') return 'regime';
  if (code === 'no-regime-feed-unreadable') return 'feed';
  switch (subcode) {
    case 'twap-history':
    case 'twap-dev':
    case 'twap-unavailable':
      return 'twap gate';
    case 'spot-unsafe':
      return 'spot gate';
    case 'oracle-stale':
    case 'oracle-dev':
    case 'oracle-unreadable':
      return 'oracle clamp';
    default:
      return 'gate';
  }
}

// spot agrees with the feed while the pool twap does not: the 1h twap lags a
// fast move (wiki §7.3) — not manipulation
export function twapLagHint(spotTick: number | null, gate: Gate | null): boolean {
  if (spotTick === null || !gate?.oracle) return false;
  const o = gate.oracle;
  const spotVsOracle = Math.abs(spotTick - o.tick);
  return o.devTicks > o.maxDevTicks && spotVsOracle <= o.maxDevTicks;
}

function heldHint(i: VerdictInput, subcode: GateFailedAt | null): string | null {
  if (twapLagHint(i.spotTick, i.gate)) return 'twap lag';
  if (i.standing?.code === 'cooldown' && i.detail) return 'min interval';
  return subcode;
}

function winnerWord(w: Winner | null): string {
  return w === 'TRIGGER' ? 'trigger' : w === 'REFRESH' ? 'refresh' : w === 'FOLD' ? 'fold' : 'hold';
}

function dwellLeg(d: Dwell | null, w: Winner | null) {
  if (!d) return null;
  return w === 'TRIGGER' ? d.rebalance : w === 'REFRESH' ? d.refresh : w === 'FOLD' ? d.fold : null;
}

function make(level: VerdictLevel, code: string, legit: boolean | null, sinceTs: number | null, sentence: string): Verdict {
  return { level, code, legit, sinceTs, sentence };
}

export function verdictFor(i: VerdictInput): Verdict {
  // ui-derived faults first: they say the keeper column cannot be trusted at all
  if (i.liveness === 'unreachable') {
    if (!i.configured) return make('unknown', 'keeper-not-configured', null, null, 'keeper not configured');
    return make('fault', 'keeper-unreachable', false, i.unreachableSinceTs, `keeper unreachable since ${fmtClock(i.unreachableSinceTs)}`);
  }
  if (i.liveness === 'stalled') {
    const s = i.stalled;
    const what = s ? `head +${s.headPlus} blocks, lastBlock frozen ${fmtDur(s.frozenSecs)}` : 'head frozen';
    return make('fault', 'keeper-stalled', false, i.sinceTs, `keeper stalled: ${what}`);
  }
  if (i.monitorCritical) return make('fault', 'monitor-critical', false, i.sinceTs, `monitor critical: ${i.monitorCritical}`);
  if (i.disagreements > 0) {
    return make('fault', 'keeper-chain-disagree', false, i.sinceTs, `keeper and chain disagree (${i.disagreements})`);
  }
  if (!i.standing) return make('unknown', 'unknown', null, null, 'no keeper record yet');

  const { code, subcode } = i.standing;
  const since = i.sinceTs === null ? '' : ` ${fmtDur(i.nowTs - i.sinceTs)}`;

  if (code === 'dry-run') {
    if (i.dryRunLive) return make('fault', code, false, i.sinceTs, `dry-run on a live vault: ${i.detail ?? 'not sending'}`);
    return make('ok', code, null, i.sinceTs, `dry run · would act: ${i.detail ?? '-'}`);
  }
  if (FAULT_CODES.has(code)) return make('fault', code, false, i.sinceTs, `${code}: ${i.detail ?? '-'}`);
  if (HELD_CODES.has(code)) {
    const hint = heldHint(i, subcode);
    return make('held', code, true, i.sinceTs, `due work held by ${gateName(code, subcode)}${hint ? ` (${hint})` : ''}${since}`);
  }
  // ok tier
  if (code === 'arming') {
    const leg = dwellLeg(i.dwell, i.winner);
    const prog = leg ? ` ${fmtDur(leg.heldSecs)}/${fmtDur(leg.requiredSecs)}` : '';
    return make('ok', code, null, i.sinceTs, `arming ${winnerWord(i.winner)}${prog}`);
  }
  if (code === 'landed') return make('ok', code, null, i.sinceTs, `acted: ${i.detail ?? 'tx landed'}`);
  if (code === 'compound-only') return make('ok', code, null, i.sinceTs, 'quiet · compound sweep due');
  const compound = i.compoundDueInSecs === null ? '' : ` · compound in ${fmtDur(Math.max(0, i.compoundDueInSecs))}`;
  return make('ok', code, null, i.sinceTs, `quiet · nothing due${compound}`);
}
