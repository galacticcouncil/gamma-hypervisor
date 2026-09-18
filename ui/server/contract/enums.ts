// every closed vocabulary the public api uses. the keeper's own come straight
// from @keeper/record so /api/v1/schema cannot drift from the serialiser.
// codes are stable identifiers: grow additively, never rename in v1.

export {
  OUTCOME_CODES,
  GATE_FAILED_AT,
  STAGES,
  WINNERS,
  PLAN_KINDS,
  GATE_VIA,
  TS_SOURCES,
  RECORD_SOURCES,
  REGIMES,
  LIMIT_SIDES,
  EXIT_MARKS,
} from '@keeper/record';
export type {
  OutcomeCode,
  GateFailedAt,
  Stage,
  Winner,
  PlanKind,
  GateVia,
  ExitMark,
} from '@keeper/record';
import { OUTCOME_CODES, GATE_FAILED_AT, TX_KINDS as KEEPER_TX_KINDS } from '@keeper/record';

export const OUTCOME = OUTCOME_CODES;

// standing = the episode machine's code: outcome code + gate.failedAt as subcode
export const STANDING = OUTCOME_CODES;
export const STANDING_SUBCODE = GATE_FAILED_AT;

export const VERDICT = ['ok', 'held', 'fault', 'unknown'] as const;
export type VerdictLevel = (typeof VERDICT)[number];

export const LIVENESS = [
  'alive',
  'quiet',
  'due',
  'blocked-legit',
  'blocked-operational',
  'acting',
  'stalled',
  'unreachable',
  'restarted',
] as const;
export type Liveness = (typeof LIVENESS)[number];

export const KEEPER_MODE = ['LIVE', 'DRY_RUN'] as const;
export type KeeperMode = (typeof KEEPER_MODE)[number];

// keeper's kinds plus the indexer's "could not tell" for a Rebalance with no matching record
export const TX_KIND = [...KEEPER_TX_KINDS, 'unknown'] as const;
export type TxKind = (typeof TX_KIND)[number];

export const CHAIN_EVENT = ['Rebalance', 'ZeroBurn', 'Deposit', 'Withdraw'] as const;
export type ChainEventKind = (typeof CHAIN_EVENT)[number];

// /vaults/{id}/events merged timeline
export const EVENT = [
  'cycle',
  'regime',
  'standing',
  'finding',
  'tx',
  'deposit',
  'withdraw',
  'zero-burn',
  'config',
  'source',
] as const;
export type EventKind = (typeof EVENT)[number];

// /stream sse event names
export const STREAM_EVENT = ['status', 'cycle', 'tx', 'standing', 'regime', 'finding', 'sample', 'source'] as const;
export type StreamEvent = (typeof STREAM_EVENT)[number];

export const FINDING_SOURCE = ['monitor', 'ui'] as const;
export type FindingSource = (typeof FINDING_SOURCE)[number];

export const FINDING_SEVERITY = ['info', 'warning', 'critical'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITY)[number];

// monitor/src/checks.ts keys (0.3.0) + 0.4.0's rpc-failing + the ui's own rules
export const FINDING = [
  'gas-warn',
  'gas-floor',
  'gas', // monitor 0.4.0 folds gas-warn/gas-floor into one family with severity escalation
  'out-of-band',
  'rebalance-overdue',
  'limit-stranded',
  'paused',
  'feed-stale',
  'clamp-blocking',
  'divergence',
  'monitor-rpc-failing',
  'keeper-unreachable',
  'keeper-stalled',
  'keeper-chain-disagree',
  'config-drift',
  'dry-run-live',
  'state-lost',
  'chain-rpc-shared',
  'full-range',
  'foreign-recipient',
] as const;
export type FindingKey = (typeof FINDING)[number];

export const SOURCE = ['keeper', 'monitor', 'rpc', 'rpc-fallback'] as const;
export type SourceName = (typeof SOURCE)[number];

export const DEPOSIT_STATE = ['open', 'blocked'] as const;
export type DepositState = (typeof DEPOSIT_STATE)[number];

export const WINDOW = ['24h', '7d', '30d', 'launch'] as const;
export type WindowName = (typeof WINDOW)[number];

export const SAMPLE_STEP = [60, 300, 3600, 86400] as const;
export type SampleStep = (typeof SAMPLE_STEP)[number];

export const COST_SOURCE = ['receipts', 'estimate'] as const;
export type CostSource = (typeof COST_SOURCE)[number];

export const CONFIG_SOURCE = ['keeper', 'cache', 'none'] as const;
export type ConfigSource = (typeof CONFIG_SOURCE)[number];

export const QUERY = [
  'outcome-histogram',
  'standing-durations',
  'gate-block-episodes',
  'arm-events',
  'rebalance-list',
  'rebalances-per-day',
  'composition-extremes',
  'deposit-flows',
  'fee-harvests',
  'time-in-range',
  'keeper-restarts',
  'source-outages',
] as const;
export type QueryName = (typeof QUERY)[number];

export const ERROR_CODE = [
  'bad-request',
  'not-found',
  'method-not-allowed',
  'rate-limited',
  'stream-limit',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODE)[number];

// what /api/v1 discovery publishes under `enums`
export const PUBLIC_ENUMS = {
  outcome: OUTCOME,
  standing: STANDING,
  standingSubcode: STANDING_SUBCODE,
  verdict: VERDICT,
  liveness: LIVENESS,
  finding: FINDING,
  findingSeverity: FINDING_SEVERITY,
  event: EVENT,
  streamEvent: STREAM_EVENT,
  txKind: TX_KIND,
  window: WINDOW,
  query: QUERY,
} as const;
