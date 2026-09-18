import { z } from 'zod';
import type { Trigger } from './decide';
import type { Regime, RegimeState } from './regime';
import type { ProxyCaps } from './chain';
import type { LimitSide } from './ticks';

// cycle record v1: one evaluate() pass for one vault, as status.ts emits it and
// the ui consumes it (@keeper/record). enums grow additively; a rename bumps v.

export const RECORD_V = 1 as const;

export const OUTCOME_CODES = [
  'hold',
  'arming',
  'cooldown',
  'compound-only',
  'no-regime-feed-unreadable',
  'regime-extreme',
  'gate-blocked',
  'gas-floor',
  'clamp-unworkable',
  'width-cap',
  'dry-run',
  'preflight-revert',
  'landed',
  'error',
] as const;
export type OutcomeCode = (typeof OUTCOME_CODES)[number];

// checkPrice exits, keeper.ts:216-263, in source order
export const GATE_FAILED_AT = [
  'twap-history',
  'twap-dev',
  'twap-unavailable',
  'spot-unsafe',
  'oracle-stale',
  'oracle-dev',
  'oracle-unreadable',
] as const;
export type GateFailedAt = (typeof GATE_FAILED_AT)[number];

// where in evaluate() the cycle ended
export const STAGES = [
  'triggers',
  'dwell',
  'cooldown',
  'gate',
  'regime',
  'compound',
  'gas',
  'clamp',
  'plan',
  'preflight',
  'submit',
  'error',
] as const;
export type Stage = (typeof STAGES)[number];

export const WINNERS = ['TRIGGER', 'REFRESH', 'FOLD', 'hold'] as const;
export type Winner = (typeof WINNERS)[number];
export const PLAN_KINDS = ['recenter', 'refresh', 'fold'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];
export const TX_KINDS = ['recenter', 'refresh', 'fold', 'compound'] as const;
export type TxKind = (typeof TX_KINDS)[number];
export const GATE_VIA = ['skip', 'compound-skipped'] as const;
export type GateVia = (typeof GATE_VIA)[number];
export const TS_SOURCES = ['block', 'wall'] as const;
export const RECORD_SOURCES = ['parsed', 'recorded'] as const;

// the keeper's own unions, mirrored for zod and pinned both ways at compile time
export const REGIMES = ['calm', 'elevated', 'extreme'] as const satisfies readonly Regime[];
export const LIMIT_SIDES = ['above', 'below'] as const satisfies readonly LimitSide[];
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
true satisfies Exact<Regime, (typeof REGIMES)[number]>;
true satisfies Exact<LimitSide, (typeof LIMIT_SIDES)[number]>;

const int = z.number().int();
const ts = int.nonnegative(); // unix seconds
const iso = z.string().datetime(); // ISO-8601 utc
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const ticks = z.tuple([int, int]); // [lower, upper]
const bigStr = z.string().regex(/^-?\d+$/); // BigNumber as decimal string

const TriggerBase = z.object({ trigger: z.boolean(), reason: z.string() });
true satisfies Exact<z.infer<typeof TriggerBase>, Trigger>;

export const DwellLeg = z.object({
  sinceTs: ts, // 0 when the trigger is not holding
  heldSecs: int.nonnegative(),
  requiredSecs: int.nonnegative(),
  armed: z.boolean(),
});
export const Dwell = z.object({ rebalance: DwellLeg, refresh: DwellLeg, fold: DwellLeg });
export type Dwell = z.infer<typeof Dwell>;

export const Cooldown = z.object({
  evaluated: z.boolean(),
  elapsedSecs: int.nonnegative().nullable(),
  minIntervalSecs: int.nonnegative().nullable(),
  skipped: z.boolean(),
});
export type Cooldown = z.infer<typeof Cooldown>;

export const Gate = z.object({
  evaluated: z.boolean(),
  ok: z.boolean(),
  failedAt: z.enum(GATE_FAILED_AT).nullable(),
  reason: z.string(),
  via: z.enum(GATE_VIA).nullable(), // null when the gate passed: no skip line to attribute
  twap: z.object({ windowSecs: int, tick: int, devTicks: int, maxDevTicks: int }).nullable(),
  // ageSecs null on a parsed `dev X > Y` failure line, which carries no age
  oracle: z.object({ tick: int, ageSecs: int.nullable(), devTicks: int, maxDevTicks: int }).nullable(),
});
export type Gate = z.infer<typeof Gate>;

export const RegimeRec = z.object({
  regime: z.enum(REGIMES),
  changed: z.boolean(),
  reason: z.string().nullable(),
  sinceTs: ts,
});
export type RegimeRec = z.infer<typeof RegimeRec>;
true satisfies Exact<RegimeRec['sinceTs'], RegimeState['since']>;

export const Compound = z.object({
  allowed: z.boolean(),
  reason: z.string(),
  submitted: hash.nullable(),
  landed: z.boolean(),
});
export type Compound = z.infer<typeof Compound>;

export const Plan = z.object({
  kind: z.enum(PLAN_KINDS),
  base: ticks,
  limit: ticks,
  side: z.enum(LIMIT_SIDES),
  tolBps: int.nonnegative(),
  clamped: z.boolean(),
});
export type Plan = z.infer<typeof Plan>;

export const Tx = z.object({ hash, kind: z.enum(TX_KINDS) });
export type Tx = z.infer<typeof Tx>;

export const Outcome = z.object({ code: z.enum(OUTCOME_CODES), stage: z.enum(STAGES), detail: z.string() });
export type Outcome = z.infer<typeof Outcome>;

export const CycleRecord = z.object({
  v: z.literal(RECORD_V),
  bootAt: iso,
  seq: int.positive(), // restarts at 1 on every keeper boot
  vault: z.object({ id: z.string().regex(/^0x[0-9a-f]{40}$/), label: z.string() }),
  block: int.nonnegative(),
  blockTs: ts,
  tsSource: z.enum(TS_SOURCES),
  evaluatedAt: iso,
  durationMs: int.nonnegative().nullable(),
  // reads / triggers / winner are null when evaluate() threw before its
  // summary line (source 'parsed' has nothing else to read them from)
  reads: z
    .object({
      spotTick: int,
      sqrtPriceX96: bigStr.nullable(),
      base: ticks,
      limit: ticks.nullable(), // never in the log; 'recorded' fills it
      limitLiquidity: bigStr.nullable(),
    })
    .nullable(),
  triggers: z
    .object({
      rebalance: TriggerBase.extend({
        drift: int.nullable(),
        thresholdTicks: int.nullable(),
        outside: z.boolean().nullable(),
      }),
      refresh: TriggerBase.extend({ awayTicks: int.nullable() }),
      fold: TriggerBase.extend({ minLegShare: z.number().min(0).max(1).nullable() }),
    })
    .nullable(),
  winner: z.enum(WINNERS).nullable(),
  compoundDue: z.boolean(),
  dwell: Dwell,
  cooldown: Cooldown.nullable(),
  gate: Gate.nullable(),
  regime: RegimeRec.nullable(),
  compound: Compound.nullable(),
  plan: Plan.nullable(),
  tx: Tx.nullable(),
  outcome: Outcome,
  source: z.enum(RECORD_SOURCES),
});
export type CycleRecord = z.infer<typeof CycleRecord>;

// the vault's standing = the run of identical (code, subcode) across records
export const Standing = z.object({
  code: z.enum(OUTCOME_CODES),
  subcode: z.enum(GATE_FAILED_AT).nullable(),
  sinceTs: ts,
  seq: int.positive(),
});
export type Standing = z.infer<typeof Standing>;
export type StandingKey = Pick<Standing, 'code' | 'subcode'>;

// subcode is gate.failedAt regardless of via, and a compound-only cycle whose
// gate failed behind `compound skipped:` counts as gate-blocked, so a lockout
// that only shows on compound-due cycles still forms one episode
export function standingOf(rec: Pick<CycleRecord, 'outcome' | 'gate'>): StandingKey {
  const subcode = rec.gate && !rec.gate.ok ? rec.gate.failedAt : null;
  const code = rec.outcome.code === 'compound-only' && subcode ? 'gate-blocked' : rec.outcome.code;
  return { code, subcode };
}

export function sameStanding(a: StandingKey, b: StandingKey): boolean {
  return a.code === b.code && a.subcode === b.subcode;
}

// terminal lines the parser may have seen. evaluate() has one exit per cycle,
// but only what was printed can be trusted, so these are flags resolved by
// precedence rather than one value
export const EXIT_MARKS = [
  'landed',
  'preflight-revert',
  'dry-run',
  'width-cap',
  'clamp-unworkable',
  'gas-floor',
  'regime-extreme',
  'gate-blocked',
  'no-regime-feed-unreadable',
] as const;
export type ExitMark = (typeof EXIT_MARKS)[number];

export interface Pending {
  compoundDue: boolean;
  /** an `arming <label>:` line was seen: the dwell is counting, nothing is armed */
  arming: boolean;
  cooldown: Pick<Cooldown, 'skipped'> | null;
  gate: Pick<Gate, 'ok' | 'failedAt' | 'via'> | null;
  tx: Pick<Tx, 'hash'> | null;
  /** `#N error:` text when evaluate() threw */
  error: string | null;
  marks: Partial<Record<ExitMark, boolean>>;
}

// precedence: a thrown cycle is an error whatever else printed; a landed tx
// beats every skip; the armed path's exits (all after keeper.ts:520) beat
// compound-only; compound-only beats the cooldown skip and the arming line it
// carried past 485; then cooldown, arming, hold. gate-blocked only through the
// armed path (`skip:`), never through `compound skipped:`
export function classify(p: Pending): OutcomeCode {
  const m = p.marks;
  if (p.error !== null) return 'error';
  if (m.landed || p.tx) return 'landed';
  if (m['preflight-revert']) return 'preflight-revert';
  if (m['dry-run']) return 'dry-run';
  if (m['width-cap']) return 'width-cap';
  if (m['clamp-unworkable']) return 'clamp-unworkable';
  if (m['gas-floor']) return 'gas-floor';
  if (m['regime-extreme']) return 'regime-extreme';
  if (m['gate-blocked'] || (p.gate !== null && !p.gate.ok && p.gate.via === 'skip')) return 'gate-blocked';
  if (m['no-regime-feed-unreadable']) return 'no-regime-feed-unreadable';
  if (p.compoundDue) return 'compound-only';
  if (p.cooldown?.skipped) return 'cooldown';
  if (p.arming) return 'arming';
  return 'hold';
}

const STAGE_FOR: Record<OutcomeCode, Stage> = {
  hold: 'triggers',
  arming: 'dwell',
  cooldown: 'cooldown',
  'compound-only': 'compound',
  'no-regime-feed-unreadable': 'regime',
  'regime-extreme': 'regime',
  'gate-blocked': 'gate',
  'gas-floor': 'gas',
  'clamp-unworkable': 'clamp',
  'width-cap': 'clamp',
  'dry-run': 'plan',
  'preflight-revert': 'preflight',
  landed: 'submit',
  error: 'error',
};
export function stageFor(code: OutcomeCode): Stage {
  return STAGE_FOR[code];
}

// checkPrice reason grammar (keeper.ts:218/224/229/233/250/256/262) -> failedAt.
// also matches the same text behind `compound skipped:` (compoundAllowed passes
// gate.reason through verbatim); the regime reason there returns null
const GATE_REASONS: ReadonlyArray<[RegExp, GateFailedAt]> = [
  [/^pool history \d+s < MIN_TWAP_WINDOW_SECS/, 'twap-history'],
  [/^spot -?\d+ vs TWAP\(\d+s\) -?\d+ dev \d+ > \d+/, 'twap-dev'],
  [/^TWAP unavailable/, 'twap-unavailable'],
  [/^TWAP disabled without ALLOW_UNSAFE_SPOT/, 'spot-unsafe'],
  [/^oracle stale \(/, 'oracle-stale'],
  [/^pool -?\d+ vs oracle -?\d+ dev \d+ > \d+/, 'oracle-dev'],
  [/^oracle unreadable/, 'oracle-unreadable'],
];
export function gateFailedAtFor(reason: string): GateFailedAt | null {
  const r = reason.trim();
  for (const [re, code] of GATE_REASONS) if (re.test(r)) return code;
  return null;
}

// `✓ <verb> — 0x…` (keeper.ts:622) -> tx kind
export const TX_KIND_BY_VERB: Readonly<Record<string, TxKind>> = {
  rebalanced: 'recenter',
  'limit refreshed': 'refresh',
  'folded at balance': 'fold',
};

// keeper.ts:473-482, reproduced so the cooldown fields need no line parsing
export type CooldownCaps = Pick<ProxyCaps, 'minIntervalSecs' | 'lastRebalanceTs'>;
export function cooldownOf(i: {
  now: number;
  minIntervalSecs: number;
  lastRebalanceTs: number;
  caps: CooldownCaps | null;
}): Cooldown {
  const minIntervalSecs = Math.max(i.minIntervalSecs, i.caps?.minIntervalSecs ?? 0);
  const lastTs = Math.max(i.lastRebalanceTs, i.caps?.lastRebalanceTs ?? 0);
  const elapsedSecs = lastTs > 0 ? Math.max(0, i.now - lastTs) : null;
  return {
    evaluated: true,
    elapsedSecs,
    minIntervalSecs,
    skipped: elapsedSecs !== null && elapsedSecs < minIntervalSecs,
  };
}
