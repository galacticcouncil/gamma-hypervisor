import { z } from 'zod';
import {
  CycleRecord,
  Cooldown,
  Dwell,
  Gate,
  Plan,
  RegimeRec,
  Compound,
  OUTCOME_CODES,
  GATE_FAILED_AT,
  REGIMES,
  LIMIT_SIDES,
} from '@keeper/record';
import {
  CHAIN_EVENT,
  CONFIG_SOURCE,
  COST_SOURCE,
  DEPOSIT_STATE,
  ERROR_CODE,
  EVENT,
  FINDING,
  FINDING_SEVERITY,
  FINDING_SOURCE,
  KEEPER_MODE,
  LIVENESS,
  QUERY,
  SAMPLE_STEP,
  SOURCE,
  STREAM_EVENT,
  TX_KIND,
  VERDICT,
  WINDOW,
} from './enums';

// every public type, as zod, once. serialize.ts builds these; schema.ts turns
// them into json schema / openapi; the page reads the same objects. units by
// name: *Ts unix secs, *At iso utc, *Secs/*Ms durations, *Ticks, *Wei decimal
// string, *Bps int, *Frac/*Share in [0,1]. null = known-unknown; absent = n/a.

export {
  CycleRecord,
  Standing as KeeperStanding,
  Cooldown,
  Dwell,
  Gate,
  Plan,
  RegimeRec,
  Compound,
  Outcome,
  Tx as KeeperTx,
} from '@keeper/record';
export type { OutcomeCode, GateFailedAt, Standing as KeeperStandingT } from '@keeper/record';

// --- primitives ------------------------------------------------------------

export const int = z.number().int();
export const UnixTs = int.nonnegative();
export const Iso = z.string().datetime();
export const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const VaultId = z.string().regex(/^0x[0-9a-f]{40}$/); // lowercase
export const Hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const Wei = z.string().regex(/^\d+$/);
export const BigStr = z.string().regex(/^-?\d+$/);
export const Frac = z.number().min(0).max(1);
export const Ticks = z.tuple([int, int]);
export const Cursor = z.string().regex(/^c:\d+$/); // opaque public cursor

export const AsOf = z.object({ block: int.nonnegative(), ts: UnixTs });
export type AsOf = z.infer<typeof AsOf>;

export const Amount = z.object({
  raw: BigStr,
  decimals: int.nonnegative(),
  human: z.number(),
  symbol: z.string(),
});
export type Amount = z.infer<typeof Amount>;

// raw = 1.0001^tick (token1/token0 in raw units); human = raw × 10^(d0−d1)
export const Price = z.object({ raw: z.number(), human: z.number(), quote: z.string() });
export type Price = z.infer<typeof Price>;

// null until the identity read lands: `null` = known-unknown, never 0x000…0
export const Token = z.object({ address: Address.nullable(), symbol: z.string(), decimals: int.nonnegative().nullable() });
export type Token = z.infer<typeof Token>;

export const Envelope = z.object({ v: z.literal(1), generatedAt: Iso });
export type Envelope = z.infer<typeof Envelope>;

export const ApiError = Envelope.extend({
  error: z.object({ code: z.enum(ERROR_CODE), message: z.string(), hint: z.string() }),
});
export type ApiError = z.infer<typeof ApiError>;

// {items, next, complete}; rows are immutable so paging survives restarts
export function Page<T extends z.ZodTypeAny>(item: T) {
  return Envelope.extend({ items: z.array(item), next: Cursor.nullable(), complete: z.boolean() });
}

export const PageQuery = z.object({
  since: z.string().optional(), // c:<rowid> | iso | unix
  limit: z.coerce.number().int().min(1).max(2000).default(200),
  order: z.enum(['asc', 'desc']).default('asc'),
});
export type PageQuery = z.infer<typeof PageQuery>;

// scalar config values as the keeper's whitelist projection publishes them;
// urls arrive already reduced to {host}
export const ConfigValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.object({ host: z.string() })]);
export type ConfigValue = z.infer<typeof ConfigValue>;
export const PublicGlobalConfig = z.record(z.string(), ConfigValue);
export const PublicVaultConfig = z.record(z.string(), ConfigValue);
export type PublicGlobalConfig = z.infer<typeof PublicGlobalConfig>;
export type PublicVaultConfig = z.infer<typeof PublicVaultConfig>;

// --- keeper /status and /config as the collector receives them -------------

export const KeeperRoles = z.object({
  rebalancerOk: z.boolean(),
  adminOk: z.boolean(),
  exempted: z.boolean(),
  deadlock: z.boolean(),
  warnings: z.array(z.string()),
});
export type KeeperRoles = z.infer<typeof KeeperRoles>;

export const KeeperDwellState = z.object({ sinceTs: UnixTs, heldSecs: int.nonnegative(), met: z.boolean() });

export const KeeperVaultState = z.object({
  lastRebalanceTs: UnixTs,
  dwell: z.object({ rebalance: KeeperDwellState, refresh: KeeperDwellState, fold: KeeperDwellState }),
  regime: z.object({ regime: z.enum(REGIMES), sinceTs: UnixTs, calmSinceTs: UnixTs.nullable() }),
  priceTrail: z.object({ size: int.nonnegative(), move15mFrac: z.number().nullable(), move1hFrac: z.number().nullable() }),
  volBaseline: z.object({ median: z.number(), fetchedAtTs: UnixTs }).nullable(),
  lastCompoundTs: UnixTs,
});

export const KeeperStatusVault = z.object({
  id: VaultId,
  label: z.string(),
  tag: z.string(),
  pool: Address,
  token0: Token,
  token1: Token,
  tickSpacing: int.positive(),
  entrypoint: z.enum(['direct', 'proxy']),
  proxy: Address.nullable(),
  admin: Address.nullable(),
  feeRecipient: Address,
  owner: Address,
  dwellSecs: int.nonnegative(),
  roles: KeeperRoles.nullable(),
  state: KeeperVaultState,
  standing: z.object({
    code: z.enum(OUTCOME_CODES),
    subcode: z.enum(GATE_FAILED_AT).nullable(),
    sinceTs: UnixTs,
    seq: int.nonnegative(),
  }),
  last: CycleRecord.nullable(),
  ring: z.object({ size: int.nonnegative(), firstSeq: int.nonnegative(), lastSeq: int.nonnegative() }),
});
export type KeeperStatusVault = z.infer<typeof KeeperStatusVault>;

export const KeeperStatus = Envelope.extend({
  keeper: z.object({
    version: z.string(),
    bootAt: Iso,
    mode: z.enum(KEEPER_MODE),
    signer: Address,
    rpcHost: z.string(),
    pollMs: int.positive(),
    blockTimeSecs: z.number().positive(),
    head: z.object({ number: int.nonnegative(), ts: UnixTs, at: Iso }).nullable(),
    busy: z.boolean(),
    busySinceAt: Iso.nullable(),
    skippedWhileBusy: int.nonnegative(),
    cyclesTotal: int.nonnegative(),
    errorsTotal: int.nonnegative(),
    hookErrors: int.nonnegative(),
    listener: z.object({ requests: int.nonnegative(), slowResponses: int.nonnegative(), clients: int.nonnegative() }),
    configFingerprint: z.string(),
  }),
  vaults: z.array(KeeperStatusVault),
});
export type KeeperStatus = z.infer<typeof KeeperStatus>;

export const KeeperConfig = z.object({
  v: z.literal(1),
  source: z.enum(['env', 'VAULTS_FILE', 'VAULTS_JSON']),
  descriptorSha256: z.string().nullable(),
  global: PublicGlobalConfig,
  vaults: z.array(PublicVaultConfig),
  fingerprint: z.string(),
});
export type KeeperConfig = z.infer<typeof KeeperConfig>;

// --- monitor /status as the collector receives it --------------------------

export const MonitorFiring = z.object({
  key: z.string(),
  severity: z.enum(FINDING_SEVERITY),
  title: z.string(),
  detail: z.string(),
  onsetAt: Iso,
  lastNotifiedAt: Iso.nullable(),
});
export type MonitorFiring = z.infer<typeof MonitorFiring>;

const num = z.number().nullable();
export const MonitorSnapshot = z.object({
  checkedAt: Iso,
  gasWei: Wei.nullable(),
  tick: num,
  base: Ticks.nullable(),
  limit: Ticks.nullable(),
  drift: num,
  threshold: num,
  lastRebalanceTs: num,
  sinceSecs: num,
  allowanceSecs: num,
  limitOutsideBy: num,
  paused: z.boolean().nullable(),
  feedPx: num,
  poolPx: num,
  divergenceBps: num,
  oracleTick: num,
  twapTick: num,
  devTicks: num,
  spotDevTicks: num,
  feedAgeSecs: num,
  navToken1: num,
  limitValueToken1: num,
});
export type MonitorSnapshot = z.infer<typeof MonitorSnapshot>;

export const MonitorPool = z.object({
  id: VaultId,
  label: z.string(),
  thresholds: z.record(z.string(), ConfigValue),
  snapshot: MonitorSnapshot.nullable(),
  firing: z.array(MonitorFiring),
});

export const MonitorStatus = z.object({
  v: z.literal(1),
  version: z.string(),
  rpcHost: z.string(),
  bootAt: Iso,
  lastCycleAt: Iso.nullable(),
  lastCycleOk: z.boolean().nullable(),
  consecutiveFailures: int.nonnegative(),
  cycles: int.nonnegative(),
  stale: z.boolean(),
  // one signer, so the monitor publishes gas globally, not per pool — and it is
  // the only source for GAS_WARN_WEI (the keeper has no warn level)
  gas: z
    .object({ keeper: Address, wei: Wei.nullable(), warnWei: Wei.nullable(), floorWei: Wei.nullable() })
    .nullable()
    .default(null),
  // the monitor partitions its findings: this list is the vault === null ones
  firing: z.array(MonitorFiring).default([]),
  pools: z.array(MonitorPool),
  alerts: z.array(z.object({ at: Iso, severity: z.enum(FINDING_SEVERITY), title: z.string() })),
});
export type MonitorStatus = z.infer<typeof MonitorStatus>;

// --- public: sources, verdict, standing, findings ---------------------------

export const SourceState = z.object({
  configured: z.boolean(),
  reachable: z.boolean(),
  asOf: Iso.nullable(),
  ageSecs: int.nonnegative().nullable(),
  unreachableSince: Iso.nullable(),
  detail: z.string().nullable(),
});
export type SourceState = z.infer<typeof SourceState>;

export const Head = z.object({ number: int.nonnegative(), ts: UnixTs.nullable(), at: Iso });
export type Head = z.infer<typeof Head>;

export const Backfill = z.object({ from: int.nonnegative(), to: int.nonnegative(), done: z.boolean() });
export type Backfill = z.infer<typeof Backfill>;

export const Sources = z.object({
  keeper: SourceState,
  monitor: SourceState,
  chain: z.object({
    ok: z.boolean(),
    rpcHost: z.string(),
    head: Head.nullable(),
    fallbackHead: Head.nullable(),
    backfill: Backfill.nullable(),
  }),
  ui: z.object({ ssr: z.boolean(), commit: z.string().nullable() }),
});
export type Sources = z.infer<typeof Sources>;

export const Verdict = z.object({
  level: z.enum(VERDICT),
  code: z.string(),
  legit: z.boolean().nullable(),
  sinceTs: UnixTs.nullable(),
  sentence: z.string(),
});
export type Verdict = z.infer<typeof Verdict>;

export const LivenessV1 = z.enum(LIVENESS);

export const StandingV1 = z.object({
  code: z.enum(OUTCOME_CODES),
  subcode: z.enum(GATE_FAILED_AT).nullable(),
  sinceTs: UnixTs,
  secs: int.nonnegative(),
  cycles: int.nonnegative(),
});
export type StandingV1 = z.infer<typeof StandingV1>;

export const Finding = z.object({
  id: int.positive(),
  vault: VaultId.nullable(), // null = global
  source: z.enum(FINDING_SOURCE),
  key: z.enum(FINDING),
  severity: z.enum(FINDING_SEVERITY),
  title: z.string(),
  detail: z.string(),
  onsetAt: Iso,
  lastSeenAt: Iso,
  clearedAt: Iso.nullable(),
  active: z.boolean(),
  stale: z.boolean(), // source silent: kept, never blanked
});
export type Finding = z.infer<typeof Finding>;

export const Disagreement = z.object({
  key: z.string(),
  keeper: ConfigValue,
  chain: ConfigValue,
  sinceSecs: int.nonnegative(),
  detail: z.string(),
});
export type Disagreement = z.infer<typeof Disagreement>;

// --- public: the vault --------------------------------------------------------

export const Reading = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const GateRow = z.object({
  gate: z.string(),
  enabled: z.boolean(),
  reading: Reading,
  limit: Reading,
  op: z.string().nullable(),
  ratio: z.number().nullable(), // reading/limit, uncapped; the bar caps at 1
  verdict: z.string(),
  keeperSaw: Reading, // '=' when equal, the value when not, null when never evaluated
  agrees: z.boolean().nullable(),
});
export type GateRow = z.infer<typeof GateRow>;

export const Holding = z.object({
  code: z.enum(OUTCOME_CODES),
  subcode: z.enum(GATE_FAILED_AT).nullable(),
  sinceTs: UnixTs,
  blocks: z.array(z.string()), // what the hold is blocking, in words
});

export const Gas = z.object({
  signerBalanceWei: Wei.nullable(),
  floorWei: Wei.nullable(),
  warnWei: Wei.nullable(),
  runwayTx: int.nonnegative().nullable(),
  runwayDays: z.number().nullable(),
  costSource: z.enum(COST_SOURCE),
});
export type Gas = z.infer<typeof Gas>;

export const Caps = z.object({
  maxTranslation: int.nonnegative(),
  maxWidth: int.nonnegative(),
  minIntervalSecs: int.nonnegative(),
  lastRebalanceTs: UnixTs,
  exempted: z.boolean(),
});

export const Deposits = z.object({
  state: z.enum(DEPOSIT_STATE),
  reason: z.string().nullable(),
  threshold: int.nullable(), // ClearingV2 priceThreshold, ratio × 10_000
  deviationBps: z.number().nullable(),
  twapCheck: z.boolean().nullable(),
  whitelisted: z.boolean().nullable(),
  note: z.string().nullable(), // e.g. `out of base range` — informational, not a gate
});
export type Deposits = z.infer<typeof Deposits>;

export const ChainSide = z.object({
  asOf: AsOf,
  ageSecs: int.nonnegative(),
  spotTick: int,
  price: Price,
  base: z.object({
    lower: int,
    upper: int,
    inRange: z.boolean(),
    driftTicks: int.nonnegative(),
    thresholdTicks: int.nonnegative().nullable(),
  }),
  limit: z.object({
    lower: int,
    upper: int,
    side: z.enum(LIMIT_SIDES).nullable(),
    liquidity: BigStr,
    outsideByTicks: int.nonnegative(),
    stranded: z.boolean().nullable(),
  }),
  nav: z.object({ total0: Amount, total1: Amount, navToken1: z.number(), note: z.string() }),
  shares: z.object({ totalSupply: BigStr, sharePriceToken1: z.number().nullable(), maxTotalSupply: BigStr }),
  composition: z.object({ token0Share: Frac, baseShare: Frac, limitShare: Frac, twoXMinusOne: Frac }),
  gates: z.array(GateRow),
  caps: Caps.nullable(),
  feesOwed: z.object({ fees0: Amount, fees1: Amount, asOf: AsOf }).nullable(),
  idle: z.object({ idle0: Amount, idle1: Amount, asOf: AsOf }).nullable(),
  fee: z.object({ divisor: int.nonnegative().nullable(), protocolFrac0: Frac.nullable(), protocolFrac1: Frac.nullable() }),
  gas: Gas,
  roles: KeeperRoles.nullable(),
  deposits: Deposits,
});
export type ChainSide = z.infer<typeof ChainSide>;

export const KeeperSide = z.object({
  reachable: z.boolean(),
  asOf: AsOf.nullable(),
  ageSecs: int.nonnegative().nullable(),
  action: z.string().nullable(), // winner word + dwell, e.g. `TRIGGER 34m/34m`
  outcome: CycleRecord.shape.outcome.nullable(),
  standing: StandingV1.nullable(),
  dwell: Dwell.nullable(),
  cooldown: Cooldown.nullable(),
  gateSaw: Gate.nullable(),
  regime: z.object({
    regime: z.enum(REGIMES),
    sinceTs: UnixTs,
    lastEvaluatedAt: Iso.nullable(),
    inputs: z.object({ volRatio: z.number().nullable(), move15mFrac: z.number().nullable(), move1hFrac: z.number().nullable() }),
  }).nullable(),
  compound: z.object({ due: z.boolean(), dueInSecs: int.nullable(), lastTs: UnixTs.nullable() }).nullable(),
  lastTx: z.object({ hash: Hash, kind: z.enum(TX_KIND), ts: UnixTs.nullable() }).nullable(),
  lastError: z.object({ at: Iso, block: int.nonnegative(), message: z.string() }).nullable(),
  config: PublicVaultConfig.nullable(),
});
export type KeeperSide = z.infer<typeof KeeperSide>;

export const MonitorSide = z.object({
  reachable: z.boolean(),
  asOf: Iso.nullable(),
  ageSecs: int.nonnegative().nullable(),
  stale: z.boolean(),
  firing: z.array(MonitorFiring),
  snapshot: MonitorSnapshot.nullable(),
});
export type MonitorSide = z.infer<typeof MonitorSide>;

export const EconomicsSummary = z.object({
  window: z.enum(WINDOW),
  netVsBasketHodl: z.number().nullable(),
  netVs5050Hodl: z.number().nullable(),
  experimental: z.object({ feesFrac: z.number().nullable(), ilFrac: z.number().nullable() }),
  timeInBase: Frac.nullable(),
  txs: int.nonnegative(),
  avgCostWei: Wei.nullable(),
});
export type EconomicsSummary = z.infer<typeof EconomicsSummary>;

export const VaultRef = z.object({
  id: VaultId,
  label: z.string(),
  pool: Address.nullable(),
  token0: Token,
  token1: Token,
  tickSpacing: int.positive(),
  entrypoint: z.enum(['direct', 'proxy']),
});
export type VaultRef = z.infer<typeof VaultRef>;

export const VaultV1 = z.object({
  id: VaultId,
  label: z.string(),
  pair: z.string(),
  pool: Address.nullable(),
  tickSpacing: int.positive(),
  entrypoint: z.enum(['direct', 'proxy']),
  verdict: Verdict,
  liveness: LivenessV1,
  keeper: KeeperSide,
  chain: ChainSide.nullable(),
  monitor: MonitorSide,
  disagreements: z.array(Disagreement),
  economics: EconomicsSummary.nullable(),
});
export type VaultV1 = z.infer<typeof VaultV1>;

// --- public: envelopes per route ----------------------------------------------

export const KeeperSummary = z.object({
  configured: z.boolean(),
  reachable: z.boolean(),
  mode: z.enum(KEEPER_MODE).nullable(),
  version: z.string().nullable(),
  bootAt: Iso.nullable(),
  signer: Address.nullable(),
  rpcHost: z.string().nullable(),
  head: Head.nullable(),
  busy: z.boolean().nullable(),
  busySinceAt: Iso.nullable(),
  skippedWhileBusy: int.nonnegative().nullable(),
  cyclesTotal: int.nonnegative().nullable(),
  errorsTotal: int.nonnegative().nullable(),
  hookErrors: int.nonnegative().nullable(),
  configFingerprint: z.string().nullable(),
  gas: Gas.nullable(),
  liveness: LivenessV1,
});
export type KeeperSummary = z.infer<typeof KeeperSummary>;

export const StatusV1 = Envelope.extend({
  sources: Sources,
  keeper: KeeperSummary,
  vaults: z.array(VaultV1),
  findings: z.array(Finding),
});
export type StatusV1 = z.infer<typeof StatusV1>;

export const StatusQuery = z.object({
  vault: z.string().optional(),
  compact: z.coerce.number().int().min(0).max(1).default(0),
});

export const VaultsV1 = Envelope.extend({ items: z.array(VaultRef) });
export type VaultsV1 = z.infer<typeof VaultsV1>;

export const TxV1 = z.object({
  hash: Hash,
  vault: VaultId,
  kind: z.enum(TX_KIND),
  block: int.nonnegative(),
  ts: UnixTs,
  from: Address.nullable(),
  gasUsed: int.nonnegative().nullable(),
  gasPriceWei: Wei.nullable(),
  costWei: Wei.nullable(),
  costSource: z.enum(COST_SOURCE),
  status: int.min(0).max(1).nullable(),
  tick: int.nullable(),
  total0: BigStr.nullable(),
  total1: BigStr.nullable(),
  supply: BigStr.nullable(),
  base: Ticks.nullable(),
  limit: Ticks.nullable(),
  feeRecipient: Address.nullable(),
  flags: z.object({ fullRange: z.boolean(), foreignRecipient: z.boolean() }),
  plan: Plan.nullable(), // published only after landing
});
export type TxV1 = z.infer<typeof TxV1>;

export const TxsQuery = PageQuery.extend({ kind: z.enum(TX_KIND).optional() });

export const Episode = z.object({
  id: int.positive(),
  vault: VaultId,
  code: z.enum(OUTCOME_CODES),
  subcode: z.enum(GATE_FAILED_AT).nullable(),
  sinceTs: UnixTs,
  untilTs: UnixTs.nullable(),
  durationSecs: int.nonnegative(),
  cycles: int.nonnegative(),
  firstSeq: int.nonnegative(),
  lastSeq: int.nonnegative(),
  detail: z.string(),
});
export type Episode = z.infer<typeof Episode>;

export const EpisodesQuery = PageQuery.extend({
  active: z.coerce.number().int().min(0).max(1).optional(),
  code: z.enum(OUTCOME_CODES).optional(),
});

export const CyclesQuery = PageQuery.extend({
  outcome: z.string().optional(), // code[,code]
  raw: z.coerce.number().int().min(0).max(1).default(0),
});

export const CycleItem = z.object({
  id: int.positive(),
  cursor: Cursor,
  receivedAt: Iso,
  isTransition: z.boolean(),
  record: CycleRecord,
});
export type CycleItem = z.infer<typeof CycleItem>;

// /vaults/{id}: the block plus the two tails the drill opens with
export const VaultDetailV1 = Envelope.extend({ vault: VaultV1, cycles: z.array(CycleItem), txs: z.array(TxV1) });
export type VaultDetailV1 = z.infer<typeof VaultDetailV1>;

export const GatesV1 = Envelope.extend({
  vault: VaultId,
  asOf: AsOf.nullable(),
  keeperSawAt: Iso.nullable(),
  rows: z.array(GateRow),
  holding: Holding.nullable(),
});
export type GatesV1 = z.infer<typeof GatesV1>;

export const RegimeChange = z.object({
  id: int.positive(),
  vault: VaultId,
  ts: UnixTs,
  block: int.nonnegative(),
  from: z.enum(REGIMES),
  to: z.enum(REGIMES),
  reason: z.string().nullable(),
});
export type RegimeChange = z.infer<typeof RegimeChange>;

export const FlowEvent = z.object({
  hash: Hash,
  logIndex: int.nonnegative(),
  vault: VaultId,
  block: int.nonnegative(),
  ts: UnixTs,
  kind: z.enum(['Deposit', 'Withdraw']),
  sender: Address.nullable(),
  to: Address.nullable(),
  shares: BigStr,
  amount0: Amount,
  amount1: Amount,
});
export const FlowsV1 = Envelope.extend({
  vault: VaultId,
  items: z.array(FlowEvent),
  summary: z.object({
    deposits: int.nonnegative(),
    withdrawals: int.nonnegative(),
    depositors: int.nonnegative(),
    supply: BigStr.nullable(),
  }),
});
export type FlowsV1 = z.infer<typeof FlowsV1>;

export const ChainEvent = z.object({
  hash: Hash,
  logIndex: int.nonnegative(),
  vault: VaultId,
  block: int.nonnegative(),
  ts: UnixTs,
  kind: z.enum(CHAIN_EVENT),
  args: z.record(z.string(), z.unknown()),
});
export type ChainEvent = z.infer<typeof ChainEvent>;

// the samples table, camelCased; every column nullable except the key
export const Sample = z.object({
  vault: VaultId,
  ts: UnixTs,
  block: int.nonnegative().nullable(),
  spotTick: int.nullable(),
  sqrtPriceX96: BigStr.nullable(),
  priceHuman: z.number().nullable(),
  total0: BigStr.nullable(),
  total1: BigStr.nullable(),
  supply: BigStr.nullable(),
  maxTotalSupply: BigStr.nullable(),
  nav1: z.number().nullable(),
  sharePrice: z.number().nullable(),
  x: z.number().nullable(),
  baseLower: int.nullable(),
  baseUpper: int.nullable(),
  limitLower: int.nullable(),
  limitUpper: int.nullable(),
  inBase: z.boolean().nullable(),
  inLimit: z.boolean().nullable(),
  baseLiq: BigStr.nullable(),
  baseAmt0: BigStr.nullable(),
  baseAmt1: BigStr.nullable(),
  limitLiq: BigStr.nullable(),
  limitAmt0: BigStr.nullable(),
  limitAmt1: BigStr.nullable(),
  fees0: BigStr.nullable(),
  fees1: BigStr.nullable(),
  fees1Value: z.number().nullable(),
  idle0: BigStr.nullable(),
  idle1: BigStr.nullable(),
  oracleTick: int.nullable(),
  oraclePrice: z.number().nullable(),
  oracleAge: int.nullable(),
  twapTick: int.nullable(),
  twapWindow: int.nullable(),
  gateOk: z.boolean().nullable(),
  gateFailedAt: z.enum(GATE_FAILED_AT).nullable(),
  proxyLastRebalanceTs: UnixTs.nullable(),
  gasWei: Wei.nullable(),
  poolLiq: BigStr.nullable(),
  feeDivisor: int.nullable(),
  feeProtocol: int.nullable(),
  reservePaused: z.boolean().nullable(),
  clearingTwapCheck: z.boolean().nullable(),
  clearingThreshold: int.nullable(),
  clearingDevBps: z.number().nullable(),
  depositsOpen: z.boolean().nullable(),
});
export type Sample = z.infer<typeof Sample>;

export const SamplesQuery = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  step: z.coerce.number().pipe(z.union(SAMPLE_STEP.map((s) => z.literal(s)) as [z.ZodLiteral<number>, z.ZodLiteral<number>, ...z.ZodLiteral<number>[]])).default(60),
  fields: z.string().optional(), // comma list of Sample keys
});
export const SamplesV1 = Envelope.extend({
  vault: VaultId,
  step: z.number(),
  from: UnixTs,
  to: UnixTs,
  items: z.array(Sample.partial().required({ vault: true, ts: true })),
  truncated: z.boolean(), // hit the 5000-point cap
});
export type SamplesV1 = z.infer<typeof SamplesV1>;

export const WindowSpec = z.object({
  label: z.string(), // 24h | 7d | 30d | launch | <from>..<to>
  from: AsOf.nullable(),
  to: AsOf.nullable(),
});

export const EconomicsV1 = Envelope.extend({
  vault: VaultId,
  window: WindowSpec,
  perShare: z.object({
    spStart: z.number().nullable(),
    spEnd: z.number().nullable(),
    hodlBasket: z.number().nullable(),
    hodl5050: z.number().nullable(),
  }),
  netVsBasketHodl: z.number().nullable(),
  netVs5050Hodl: z.number().nullable(),
  experimental: z.object({
    feesFrac: z.number().nullable(),
    ilFrac: z.number().nullable(), // il + idle rebase (residual) = net − fees
    feesPerShare: z.number().nullable(),
    skim: z.object({
      amount0: Amount.nullable(),
      amount1: Amount.nullable(),
      feeDivisor: int.nullable(),
      feeProtocol: int.nullable(),
    }),
  }),
  timeInRange: z.object({
    base: Frac.nullable(),
    limit: Frac.nullable(),
    twBaseShare: Frac.nullable(),
    bandExits: int.nonnegative().nullable(),
    limitStrandedFrac: Frac.nullable(),
  }),
  actions: z.object({ recenter: int.nonnegative(), refresh: int.nonnegative(), fold: int.nonnegative(), compound: int.nonnegative() }),
  cadence: z.object({
    perDay: z.number().nullable(),
    policyCapPerDay: z.number(),
    proxyCapPerDay: z.number().nullable(),
    minGapOk: z.boolean().nullable(),
  }),
  cost: z.object({
    avgCostWei: z.record(z.enum(TX_KIND), Wei.nullable()),
    totalWei: Wei.nullable(),
    costSource: z.enum(COST_SOURCE),
  }),
  gas: z.object({
    balanceWei: Wei.nullable(),
    burnPerDayWei: Wei.nullable(),
    runwayDays: z.number().nullable(),
    warnWei: Wei.nullable(),
    floorWei: Wei.nullable(),
  }),
  flows: z.object({
    deposits: int.nonnegative(),
    withdrawals: int.nonnegative(),
    depositors: int.nonnegative(),
    supplyStart: BigStr.nullable(),
    supplyEnd: BigStr.nullable(),
  }),
});
export type EconomicsV1 = z.infer<typeof EconomicsV1>;

// a window the serialiser does not know is a 400, not a silent 7d
export const EconomicsQuery = z.object({
  window: z
    .union([z.enum(WINDOW), z.string().regex(/^\d+\.\.\d+$/, 'expected 24h|7d|30d|launch or <from>..<to>')])
    .default('7d'),
});

export const TimelineEvent = z.object({
  id: int.positive(),
  ts: UnixTs,
  vault: VaultId.nullable(),
  kind: z.enum(EVENT),
  ref: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;

export const LogV1 = Envelope.extend({
  vault: VaultId,
  source: z.enum(['keeper', 'db']),
  lines: z.array(z.object({ ts: UnixTs.nullable(), line: z.string() })),
});
export type LogV1 = z.infer<typeof LogV1>;

export const DriftRow = z.object({
  vault: VaultId.nullable(),
  key: z.string(),
  descriptor: ConfigValue,
  keeper: ConfigValue,
});
export type DriftRow = z.infer<typeof DriftRow>;

export const VaultDescriptor = z.record(z.string(), ConfigValue); // one vaults.json entry, secrets impossible by construction
export type VaultDescriptor = z.infer<typeof VaultDescriptor>;

export const UiPublicConfig = z.object({
  keeper: z.object({ configured: z.boolean() }),
  monitor: z.object({ configured: z.boolean() }),
  rpcHost: z.string(),
  headFallback: z.object({ configured: z.boolean() }),
  chainRpcShared: z.boolean().nullable(),
  commit: z.string().nullable(),
});
export type UiPublicConfig = z.infer<typeof UiPublicConfig>;

export const ConfigV1 = Envelope.extend({
  keeper: z.object({
    source: z.enum(CONFIG_SOURCE),
    fetchedAt: Iso.nullable(),
    config: KeeperConfig.nullable(),
  }),
  descriptor: z.object({ sha256: z.string(), vaults: z.array(VaultDescriptor) }).nullable(),
  drift: z.array(DriftRow),
  monitor: z.object({ thresholds: z.record(z.string(), z.record(z.string(), ConfigValue)) }).nullable(),
  ui: UiPublicConfig,
});
export type ConfigV1 = z.infer<typeof ConfigV1>;

export const MonitorV1 = Envelope.extend({
  configured: z.boolean(),
  reachable: z.boolean(),
  asOf: Iso.nullable(),
  status: MonitorStatus.nullable(),
});
export type MonitorV1 = z.infer<typeof MonitorV1>;

export const FindingsQuery = PageQuery.extend({
  active: z.coerce.number().int().min(0).max(1).optional(),
  vault: z.string().optional(),
});

export const QueryParams = z
  .object({
    vault: z.string().optional(),
    from: z.coerce.number().int().nonnegative().optional(),
    to: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(1000),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.to - q.from <= 90 * 86400, {
    message: 'window exceeds 90d',
    path: ['to'],
  });
export type QueryParams = z.infer<typeof QueryParams>;

export const QueryV1 = Envelope.extend({
  name: z.enum(QUERY),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
});
export type QueryV1 = z.infer<typeof QueryV1>;

export const QueriesV1 = Envelope.extend({
  items: z.array(z.object({ name: z.enum(QUERY), description: z.string(), params: z.array(z.string()) })),
});
export type QueriesV1 = z.infer<typeof QueriesV1>;

export const StreamFrame = z.object({
  event: z.enum(STREAM_EVENT),
  id: z.string(), // events_log rowid
  data: z.record(z.string(), z.unknown()),
});
export type StreamFrame = z.infer<typeof StreamFrame>;

export const HealthV1 = z.object({
  ok: z.boolean(),
  db: z.boolean(),
  collectors: z.record(z.string(), z.object({ lastTickAt: Iso.nullable(), ok: z.boolean() })),
});
export type HealthV1 = z.infer<typeof HealthV1>;

export const DiscoveryV1 = Envelope.extend({
  name: z.literal('gamma-ui'),
  commit: z.string().nullable(),
  publicUrl: z.string().nullable(),
  endpoints: z.record(z.string(), z.string()),
  schema: z.string(),
  openapi: z.string(),
  stream: z.string(),
  conventions: z.object({ units: z.record(z.string(), z.string()) }),
  enums: z.record(z.string(), z.array(z.union([z.string(), z.number()]))),
});
export type DiscoveryV1 = z.infer<typeof DiscoveryV1>;

// unit conventions, published verbatim under /api/v1.conventions.units
export const UNITS: Readonly<Record<string, string>> = {
  '*Ts': 'unix seconds',
  '*At': 'ISO-8601 UTC',
  '*Secs / *Ms': 'durations',
  '*Tick / *Ticks': 'uniswap v3 ticks',
  '*Wei': 'decimal string',
  '*Bps': 'integer basis points',
  '*Frac / *Share': 'fraction in [0,1]',
  '*Mult': 'multiples of tickSpacing',
  Amount: '{raw, decimals, human, symbol}',
  Price: '{raw = 1.0001^tick, human = raw × 10^(d0−d1), quote}',
  null: 'known-unknown',
  absent: 'not applicable',
};

// what /api/v1/schema publishes as $defs, keyed by public name
export const PUBLIC_SCHEMAS = {
  CycleRecord,
  Envelope,
  ApiError,
  AsOf,
  Amount,
  Price,
  Token,
  Sources,
  Verdict,
  StandingV1,
  Finding,
  Disagreement,
  GateRow,
  Gas,
  Deposits,
  ChainSide,
  KeeperSide,
  MonitorSide,
  EconomicsSummary,
  VaultRef,
  VaultV1,
  VaultDetailV1,
  KeeperSummary,
  StatusV1,
  VaultsV1,
  TxV1,
  Episode,
  CycleItem,
  GatesV1,
  RegimeChange,
  FlowsV1,
  ChainEvent,
  Sample,
  SamplesV1,
  EconomicsV1,
  TimelineEvent,
  LogV1,
  ConfigV1,
  UiPublicConfig,
  MonitorV1,
  QueryV1,
  QueriesV1,
  StreamFrame,
  HealthV1,
  DiscoveryV1,
} as const;
