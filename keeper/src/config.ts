import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ethers } from 'ethers';

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte 0x address');

// zod's z.coerce.boolean() treats any non-empty string as true ("false" -> true),
// so parse booleans explicitly.
const boolEnv = (def: boolean) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? def : v === 'true' || v === '1' || v === 'yes'),
    z.boolean(),
  );

const Env = z
  .object({
    RPC_URL: z.string().url().default('http://127.0.0.1:9999'),
    // Supply this directly, or name a file with PRIVATE_KEY_FILE (a Docker
    // secret) — see resolvePrivateKey(). Either way it lands here and is
    // validated by this one regex.
    PRIVATE_KEY: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, 'PRIVATE_KEY must be 0x + 64 hex (or set PRIVATE_KEY_FILE to a file holding one)'),
    VAULT: addr.default('0xE80EF6C516fd3b12037Ca1708e77a1d78AF8db5E'),

    // direct = Model A (signer is the vault owner, calls Hypervisor.rebalance).
    // proxy  = Model B (signer is the low-priv rebalancer key; calls go through
    //          RebalanceProxy, which enforces minInterval/maxTranslation/maxWidth
    //          on-chain). Prefer proxy anywhere beyond a throwaway local chain.
    ENTRYPOINT: z.enum(['direct', 'proxy']).default('direct'),
    REBALANCE_PROXY: addr.optional(),

    // Recipient of the protocol-fee cut (Hypervisor.fee is a DIVISOR: fee=5 ⇒ 20%
    // of accrued swap fees at every zeroBurn). Must be the Treasury in production;
    // required unless DRY_RUN so it can't silently default to the keeper key.
    FEE_RECIPIENT: addr.optional(),

    BASE_HALF_WIDTH_MULT: z.coerce.number().int().positive().default(10),
    LIMIT_WIDTH_MULT: z.coerce.number().int().positive().default(1),
    REBALANCE_THRESHOLD_MULT: z.coerce.number().int().nonnegative().default(5),

    // --- anti-manipulation gates (defaults are the hardened settings) ---
    MIN_INTERVAL_SECS: z.coerce.number().int().nonnegative().default(600),
    // How long the trigger must hold before a rebalance is armed.
    //
    // DWELL_SECS is the real knob: the gate means "this has been true
    // continuously for X seconds", and wall clock is the only unit in which
    // that statement is stable. DWELL_BLOCKS is the deprecated spelling —
    // it counted EVALUATED blocks, and evaluations are skipped while one is in
    // flight, so with several vaults in one process 900 of them take longer and
    // longer in real time. Left unset, DWELL_SECS is derived from DWELL_BLOCKS
    // times the block time measured at startup (see resolveDwellSecs).
    DWELL_BLOCKS: z.coerce.number().int().positive().default(3),
    DWELL_SECS: z.coerce.number().int().positive().optional(),
    TWAP_ENABLED: boolEnv(true),
    TWAP_WINDOW_SECS: z.coerce.number().int().positive().default(3600),
    // The window is clamped to the pool's oldest observation; below this floor the
    // keeper refuses to act rather than trusting a too-short average.
    MIN_TWAP_WINDOW_SECS: z.coerce.number().int().positive().default(600),
    MAX_DEV_TICKS: z.coerce.number().int().positive().default(100),
    // Escape hatch for throwaway local chains ONLY: run live without a TWAP gate.
    ALLOW_UNSAFE_SPOT: boolEnv(false),

    // --- limit refresh ---
    // Re-place a stranded limit order next to the price without moving the base
    // band (zero translation/width, so the RebalanceProxy caps are trivially
    // satisfied). Fires when spot sits more than LIMIT_REFRESH_TICKS outside
    // the limit range; shares the rebalance dwell, cooldown and price gates.
    LIMIT_REFRESH_ENABLED: boolEnv(true),
    LIMIT_REFRESH_TICKS: z.coerce.number().int().positive().default(120),

    // --- fold at balance ---
    // A limit order price has traded halfway through is a conversion the vault
    // has been paid for but not banked: left alone the second half converts too
    // and the position REFLECTS to 100% the other token (the flip-flop). Once
    // the limit's composition reaches FOLD_MIN_SHARE mixed, fire the same
    // zero-translation rebalance as a limit refresh — base ticks unchanged —
    // so the burn-and-remint folds the now-pairable inventory into the base
    // and re-parks only the residual one-sided. Backtested on three real DIA
    // tapes (30d whipsaw / 90d bear / launch tape): +0.7 / +1.2 / +2.2 pp vs
    // the recenter+refresh baseline, the only variant that won all three.
    //
    // OPT-IN: default false so merging cannot change the behaviour of the
    // running mainnet deployment; enabled per deployment in the stack config.
    FOLD_ENABLED: boolEnv(false),
    // Min-leg share of the LIMIT's own value that counts as "at balance".
    // 0.4 = fold once the limit is at least 40/60 mixed (the backtested value).
    FOLD_MIN_SHARE: z.coerce.number().min(0.05).max(0.5).default(0.4),
    // Ignore limits worth under this fraction of NAV: folding shares the 6h
    // rebalance cooldown, and a dust-sized fold wastes the slot. The backtests
    // ran without this floor; it only suppresses economically irrelevant folds.
    FOLD_MIN_LIMIT_SHARE: z.coerce.number().min(0).max(1).default(0.05),

    // Slippage bounds on the rebalance burn/mint legs, in bps of the expected
    // amount. COUPLED TO BASE_HALF_WIDTH_MULT: a position's composition swings
    // from all-token0 to all-token1 across the band, so the legs move roughly
    // 1/halfWidth faster than price. 1000 bps ≈ 0.3-0.6% of price drift headroom
    // at ±6% (mult 10); at the ±10% launch band (mult 16) the same 1000 bps buys
    // ≈ 0.5-1.0%. Re-derive whenever the band width changes.
    MINS_TOLERANCE_BPS: z.coerce.number().int().min(1).max(9999).default(1000),

    // --- external oracle clamp (Chainlink AggregatorV3 feeds) ---
    // NOT DIA getValue(string): DIA supplies the data, but Hydration serves it
    // through AggregatorV3 and every mainnet feed reverts on getValue(). One
    // contract per pair, so feeds are ADDRESSES, not key strings.
    ORACLE_ENABLED: boolEnv(false),
    ORACLE_FEED0: addr.optional(), // the volatile side's USD feed, e.g. DOT/USD
    ORACLE_FEED1: addr.optional(), // the other side's USD feed; omit if it is USD-pegged
    // Which pool side ORACLE_FEED0 prices. The pool tick is token1-per-token0, so
    // a feed on token1 must be inverted. Wrong value = oracle tick thousands of
    // ticks off = every rebalance silently skipped. aDOT/HOLLAR sorts aDOT first.
    ORACLE_FEED0_SIDE: z.enum(['token0', 'token1']).default('token0'),
    ORACLE_MAX_AGE_SECS: z.coerce.number().int().positive().default(600),
    ORACLE_MAX_DEV_TICKS: z.coerce.number().int().positive().default(200),

    // --- volatility regime (garden spec note-gamma-adot-hollar-alm-spec D3) ---
    // v3 cannot raise its fee, so the vault quotes wider or stops quoting.
    REGIME_ENABLED: boolEnv(false),
    // Widened band half-width (multiples of tickSpacing) while elevated.
    // Spec asks for ~±20%: ln(1.20)/ln(1.0001)/60 = 30 at spacing 60.
    ELEVATED_HALF_WIDTH_MULT: z.coerce.number().int().positive().default(30),
    // 1h vol at or above this multiple of its 30-day median is "elevated".
    VOL_RATIO_ELEVATED: z.coerce.number().positive().default(3),
    // Fractional moves, not percent: 0.02 = 2%.
    MOVE_15M_ELEVATED: z.coerce.number().positive().default(0.02),
    MOVE_1H_EXTREME: z.coerce.number().positive().default(0.08),
    // Continuous calm required before leaving `extreme`.
    REGIME_REENTRY_SECS: z.coerce.number().int().positive().default(7200),

    // --- vol baseline (neckwork indexer) ---
    // Supplies ONLY the 30-day median, which cannot come from the chain. If it is
    // unset or unreachable the keeper drops that one trigger and keeps running on
    // the feed-move triggers — it is never a reason to stop.
    INDEXER_URL: z.string().url().optional(),
    // The indexer tracks DOT, not aDOT. It does not need to: aDOT is 1:1 with DOT.
    INDEXER_BASE_ASSET: z.coerce.number().int().nonnegative().default(5),
    INDEXER_QUOTE_ASSET: z.coerce.number().int().nonnegative().default(10),
    INDEXER_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    VOL_BASELINE_DAYS: z.coerce.number().int().positive().default(30),
    VOL_BASELINE_REFRESH_SECS: z.coerce.number().int().positive().default(3600),

    // --- money-market reserve pause check ---
    // A PAUSED reserve makes aToken transfers revert and the pool seizes, so every
    // rebalance would fail on-chain. Aave protocol data provider + the UNDERLYING
    // asset address (DOT), not the aToken.
    MM_DATA_PROVIDER: addr.optional(),
    MM_UNDERLYING: addr.optional(),

    // --- compound cadence (spec D4) ---
    // Harvest fees and re-mint the SAME ticks. Separate from the rebalance floor:
    // compounding does not move the band, and its cadence sets how often the
    // protocol fee actually reaches the recipient.
    COMPOUND_ENABLED: boolEnv(false),
    /**
     * Minimum fees, in token1 raw units, before a sweep is worth its gas.
     *
     * Fees accrue INSIDE the Uniswap position, not as the vault's balance, so
     * the sweep is gated on `idle + accrued` rather than idle alone — gating on
     * idle meant the compound could never see the fees it exists to collect,
     * because the only thing that makes them idle is the compound itself.
     *
     * 0 sweeps whenever anything has accrued. A compound costs a few
     * millionths of a WETH, so even small sweeps pay for themselves; the knob
     * exists for chains where that stops being true.
     */
    COMPOUND_MIN_FEES1: z.string().regex(/^\d+$/).default('0'),
    // Small and frequent, deliberately. What an attacker can extract by sandwiching
    // a sweep scales with the pile it tips in, so a short interval keeps every
    // individual sweep under the threshold where attacking it beats the swap fee.
    COMPOUND_INTERVAL_SECS: z.coerce.number().int().positive().default(300),
    // Admin address. Compound goes through Admin.compound (onlyAdvisor), which is
    // a different role from the rebalancer the proxy holds.
    ADMIN_ADDRESS: addr.optional(),

    GAS_FLOOR_WEI: z.string().regex(/^\d+$/).default('0'),
    GAS_LIMIT: z.coerce.number().int().positive().default(3_000_000),
    // Markup over the chain's own eth_gasPrice quote, in percent.
    //
    // Pricing MUST be pinned rather than left to ethers: ethers v5's
    // getFeeData() attaches a HARDCODED 1.5 gwei maxPriorityFeePerGas, while
    // Hydration's entire base fee is ~0.0054 gwei — an unpinned transaction
    // pays ~276x what it needs to. Measured on mainnet 2026-09-09: base
    // 5,445,691 wei vs ethers' effective 1,505,445,691 wei, which at 288
    // compounds/day is 0.13 WETH/day instead of 0.00047.
    //
    // 20% is headroom against a quote moving between read and inclusion. It
    // must be > 0: an under-priced transaction on Hydration is dropped at
    // apply WITHOUT producing a receipt, and the caller then waits forever.
    GAS_PRICE_MARKUP_PCT: z.coerce.number().int().positive().default(20),
    CONFIRMATIONS: z.coerce.number().int().nonnegative().default(3),
    POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),

    // Startup scan for the vault's last Rebalance event (direct mode only —
    // proxy mode reads lastRebalance() on-chain), so restarts keep the cooldown.
    STARTUP_LOOKBACK_BLOCKS: z.coerce.number().int().positive().default(50_000),

    DRY_RUN: boolEnv(false),

    // --- status listener (read-only, stack overlay only; 0 = off) ---
    // GET-only node:http on STATUS_PORT serving a memory snapshot + the parsed
    // cycle records. Never publish the port and never put the keeper on the
    // gateway network — the redaction is a belt, the overlay is the trousers.
    STATUS_PORT: z.coerce.number().int().min(0).max(65535).default(0),
    STATUS_HOST: z.string().default('0.0.0.0'),
    // pre-serialised cycle records kept per vault
    STATUS_RING: z.coerce.number().int().min(1).max(65536).default(4096),

    // Per-vault display name: the log tag and the ui's row label. Optional so a
    // flat env keeps deriving `SYM0/SYM1` from the token symbols.
    LABEL: z.string().min(1).max(24).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.ENTRYPOINT === 'proxy' && !e.REBALANCE_PROXY) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['REBALANCE_PROXY'], message: 'required when ENTRYPOINT=proxy' });
    }
    if (e.ORACLE_ENABLED && !e.ORACLE_FEED0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ORACLE_FEED0'],
        message: 'ORACLE_FEED0 (an AggregatorV3 address) is required when ORACLE_ENABLED=true',
      });
    }
    if (!e.DRY_RUN && !e.FEE_RECIPIENT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FEE_RECIPIENT'],
        message: 'required for live runs — the protocol-fee cut must go to the Treasury, not default to the keeper key',
      });
    }
    if (e.COMPOUND_ENABLED && !e.ADMIN_ADDRESS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ADMIN_ADDRESS'],
        message: 'COMPOUND_ENABLED needs ADMIN_ADDRESS — compound is Admin.compound, not a vault call',
      });
    }
    if (e.REGIME_ENABLED && !e.MM_DATA_PROVIDER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MM_DATA_PROVIDER'],
        message:
          'REGIME_ENABLED needs MM_DATA_PROVIDER + MM_UNDERLYING: an unreadable reserve-pause ' +
          'state is treated as paused, so without it the keeper would sit in `extreme` forever',
      });
    }
    if (e.REGIME_ENABLED && !e.MM_UNDERLYING) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MM_UNDERLYING'],
        message: 'MM_UNDERLYING (the underlying reserve asset, e.g. DOT) is required when REGIME_ENABLED=true',
      });
    }
    if (!e.DRY_RUN && !e.TWAP_ENABLED && !e.ALLOW_UNSAFE_SPOT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TWAP_ENABLED'],
        message:
          'live keeper without a TWAP gate re-centers on raw spot (manipulable). ' +
          'Set TWAP_ENABLED=true, or ALLOW_UNSAFE_SPOT=true on a throwaway local chain.',
      });
    }
  });

/**
 * One vault's settings: the global layer unioned with that vault's overrides,
 * flattened back to exactly the shape a single-vault keeper had. Deliberately
 * flat — every `ctx.cfg.FOO` in keeper.ts / mins.ts / preflight.ts reads the
 * same as it did when there was only one vault.
 */
export type Config = z.infer<typeof Env> & {
  gasFloorWei: ethers.BigNumber;
  compoundMinFees1: ethers.BigNumber;
};

// ---------------------------------------------------------------------------
// Multi-vault layering
//
// The flat environment is the DEFAULTS layer. VAULTS_JSON / VAULTS_FILE carry a
// list of PARTIAL overrides, each merged over those defaults and then validated
// with the same refinements, per vault. Nothing currently deployed changes
// meaning: with neither set, the list is synthesised from VAULT and the result
// is byte-for-byte the old single-vault parse.
// ---------------------------------------------------------------------------

/** One signer, one RPC connection, one process — these cannot vary per vault. */
export const GLOBAL_KEYS = [
  'RPC_URL',
  'PRIVATE_KEY',
  'POLL_INTERVAL_MS',
  'CONFIRMATIONS',
  'GAS_LIMIT',
  'GAS_PRICE_MARKUP_PCT',
  'GAS_FLOOR_WEI',
  'DRY_RUN',
  'STARTUP_LOOKBACK_BLOCKS',
  'INDEXER_URL',
  'INDEXER_TIMEOUT_MS',
  'MM_DATA_PROVIDER',
  'STATUS_PORT',
  'STATUS_HOST',
  'STATUS_RING',
] as const;

/**
 * Everything a vault may override.
 *
 * BASE_HALF_WIDTH_MULT is in here and must stay here: it is denominated in the
 * pool's tickSpacing, and a different fee tier is a different spacing, so a
 * shared value would mean a different band width on every pool.
 */
export const VAULT_KEYS = [
  'VAULT',
  'ENTRYPOINT',
  'REBALANCE_PROXY',
  'ADMIN_ADDRESS',
  'FEE_RECIPIENT',
  'BASE_HALF_WIDTH_MULT',
  'LIMIT_WIDTH_MULT',
  'REBALANCE_THRESHOLD_MULT',
  'LIMIT_REFRESH_ENABLED',
  'LIMIT_REFRESH_TICKS',
  'FOLD_ENABLED',
  'FOLD_MIN_SHARE',
  'FOLD_MIN_LIMIT_SHARE',
  'MIN_INTERVAL_SECS',
  'DWELL_BLOCKS',
  'DWELL_SECS',
  'TWAP_ENABLED',
  'TWAP_WINDOW_SECS',
  'MIN_TWAP_WINDOW_SECS',
  'MAX_DEV_TICKS',
  'ALLOW_UNSAFE_SPOT',
  'MINS_TOLERANCE_BPS',
  'ORACLE_ENABLED',
  'ORACLE_FEED0',
  'ORACLE_FEED1',
  'ORACLE_FEED0_SIDE',
  'ORACLE_MAX_AGE_SECS',
  'ORACLE_MAX_DEV_TICKS',
  'REGIME_ENABLED',
  'REGIME_REENTRY_SECS',
  'ELEVATED_HALF_WIDTH_MULT',
  'VOL_RATIO_ELEVATED',
  'VOL_BASELINE_DAYS',
  'VOL_BASELINE_REFRESH_SECS',
  'MOVE_15M_ELEVATED',
  'MOVE_1H_EXTREME',
  'MM_UNDERLYING',
  'INDEXER_BASE_ASSET',
  'INDEXER_QUOTE_ASSET',
  'COMPOUND_ENABLED',
  'COMPOUND_MIN_FEES1',
  'COMPOUND_INTERVAL_SECS',
  'LABEL',
] as const;

export type GlobalKey = (typeof GLOBAL_KEYS)[number];
export type VaultKey = (typeof VAULT_KEYS)[number];
export type EnvKey = keyof z.infer<typeof Env>;

// Compile-time proof that the split is a partition of the schema: a new setting
// added above without being classified fails the build here rather than being
// silently un-overridable.
type _Unclassified = Exclude<EnvKey, GlobalKey | VaultKey>;
type _Unknown = Exclude<GlobalKey | VaultKey, EnvKey>;
const _partitionIsTotal: [_Unclassified] extends [never] ? true : never = true;
const _partitionIsSound: [_Unknown] extends [never] ? true : never = true;
void _partitionIsTotal;
void _partitionIsSound;

/** The process-wide half. `Chain` carries this; vaults never see a different one. */
export type GlobalConfig = Pick<Config, GlobalKey | 'gasFloorWei'>;

export interface KeeperConfig {
  global: GlobalConfig;
  vaults: Config[];
}

type RawEnv = Record<string, string>;

/**
 * The signing key, from a file when one is named.
 *
 * Swarmpit renders stack environment in its API and its UI, so a key in
 * `PRIVATE_KEY` is readable by anyone with Swarmpit access — and with several
 * vaults on one signer that key holds `rebalancers[vault]` and
 * `advisors[vault]` on every pool at once. `PRIVATE_KEY_FILE` lets it come from
 * a Docker secret at /run/secrets/... instead, which never reaches the rendered
 * environment.
 *
 * Resolved BEFORE zod so the file and the variable go through exactly the same
 * validation — there is no second, weaker path to a signing key.
 *
 * Setting both is an error rather than a precedence rule. An operator who has
 * set both cannot know which key is signing, and for a key that moves real
 * liquidity "we quietly picked one" is a worse outcome than a failed deploy.
 */
function resolvePrivateKey(out: RawEnv): void {
  const path = process.env.PRIVATE_KEY_FILE;
  if (!path) return;
  if (out.PRIVATE_KEY !== undefined) {
    throw new Error(
      'both PRIVATE_KEY and PRIVATE_KEY_FILE are set — unset one. ' +
        'Refusing to guess which key should sign.',
    );
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e: any) {
    throw new Error(`PRIVATE_KEY_FILE ${path}: cannot read (${e?.message ?? e})`);
  }
  // Secret files are routinely written with a trailing newline, and `docker
  // secret create` from a shell here-string adds one. Trimming is not optional.
  const key = raw.trim();
  if (key === '') throw new Error(`PRIVATE_KEY_FILE ${path}: file is empty`);
  out.PRIVATE_KEY = key;
}

function rawDefaults(): RawEnv {
  const out: RawEnv = {};
  for (const k of [...GLOBAL_KEYS, ...VAULT_KEYS]) {
    const v = process.env[k];
    if (v !== undefined && v !== '') out[k] = v;
  }
  resolvePrivateKey(out);
  return out;
}

/**
 * JSON gives real booleans and numbers; the schema reads strings out of the
 * environment. Normalise so `"TWAP_ENABLED": true` and `TWAP_ENABLED=true` mean
 * the same thing — boolEnv() compares against the STRING 'true', so a raw JSON
 * boolean would otherwise parse as false.
 */
function normalise(key: string, v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined; // explicit "inherit nothing"
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new Error(`vault override ${key}: expected a string, number or boolean, got ${typeof v}`);
}

// vaults.json is shared with the monitor and the ui; their keys ride along, and
// json has no comments, so a leading underscore is the file's comment convention
export const SIBLING_KEY_RE = /^(_|(MONITOR|UI)_)/;

function mergeVault(defaults: RawEnv, override: Record<string, unknown>, where: string): RawEnv {
  const merged: RawEnv = { ...defaults };
  for (const [k, v] of Object.entries(override)) {
    if (SIBLING_KEY_RE.test(k)) continue;
    if (!(VAULT_KEYS as readonly string[]).includes(k)) {
      const global = (GLOBAL_KEYS as readonly string[]).includes(k);
      throw new Error(
        `${where}: ${k} is ${global ? 'a GLOBAL setting — set it in the environment, not per vault' : 'not a known keeper setting'}`,
      );
    }
    const s = normalise(k, v);
    if (s === undefined) delete merged[k];
    else merged[k] = s;
  }
  return merged;
}

function parseVault(raw: RawEnv, where: string): Config {
  const r = Env.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`${where}: ${issues}`);
  }
  const e = r.data;
  return {
    ...e,
    gasFloorWei: ethers.BigNumber.from(e.GAS_FLOOR_WEI),
    compoundMinFees1: ethers.BigNumber.from(e.COMPOUND_MIN_FEES1),
  };
}

function readVaultList(): Record<string, unknown>[] | undefined {
  // VAULTS_FILE wins: a file is the deliberate, reviewable form, and a leftover
  // inline VAULTS_JSON in a stack file must not quietly beat it.
  const file = process.env.VAULTS_FILE;
  const inline = process.env.VAULTS_JSON;
  const [src, where] = file
    ? [readFileSync(file, 'utf8'), `VAULTS_FILE ${file}`]
    : inline
      ? [inline, 'VAULTS_JSON']
      : [undefined, ''];
  if (src === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(src);
  } catch (e: any) {
    throw new Error(`${where}: not valid JSON (${e?.message ?? e})`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${where}: expected a JSON array of vault objects`);
  if (parsed.length === 0) throw new Error(`${where}: empty vault list`);
  return parsed.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new Error(`${where}[${i}]: expected an object of per-vault overrides`);
    }
    return v as Record<string, unknown>;
  });
}

/**
 * The whole configuration: one global layer plus N fully-merged vault configs.
 *
 * Fails fast and loudly — a config error is operator error, and a keeper that
 * starts half-configured is worse than one that refuses to start.
 */
export function loadKeeperConfig(): KeeperConfig {
  const defaults = rawDefaults();
  const overrides = readVaultList() ?? [{}]; // no list: the flat env IS the one vault
  const where = process.env.VAULTS_FILE
    ? `VAULTS_FILE ${process.env.VAULTS_FILE}`
    : process.env.VAULTS_JSON
      ? 'VAULTS_JSON'
      : 'env';

  const vaults = overrides.map((o, i) => {
    const label = overrides.length === 1 && where === 'env' ? 'config' : `${where}[${i}]`;
    const merged = mergeVault(defaults, o, label);
    const cfg = parseVault(merged, `${label}${merged.VAULT ? ` (${merged.VAULT})` : ''}`);
    return cfg;
  });

  const seen = new Map<string, number>();
  for (const [i, v] of vaults.entries()) {
    const key = v.VAULT.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(
        `duplicate vault address ${v.VAULT} at ${where}[${first}] and ${where}[${i}] — ` +
          'two contexts on one vault would race each other for the signer nonce',
      );
    }
    seen.set(key, i);
  }

  const g = vaults[0];
  const global = Object.fromEntries([
    ...GLOBAL_KEYS.map((k) => [k, g[k]]),
    ['gasFloorWei', g.gasFloorWei],
  ]) as GlobalConfig;

  return { global, vaults };
}

/**
 * Single-vault config, exactly as before multi-vault existed.
 *
 * Still the right entry point for anything that is inherently one-vault (the
 * tests, `smoke.ts` on a selected vault). `loadKeeperConfig()` is what the
 * keeper itself uses.
 */
export function loadConfig(): Config {
  return parseVault(rawDefaults(), 'config');
}

/**
 * Resolve the dwell gate to wall-clock seconds.
 *
 * DWELL_BLOCKS counted *evaluated* blocks, and the keeper skips blocks while an
 * evaluation is in flight — so the same number meant a longer and longer real
 * interval as vaults were added to the process. The gate has always meant "the
 * trigger has held continuously for X", so say that in seconds.
 *
 * Mainnet runs DWELL_BLOCKS=900 at Hydration's ~2.25s blocks, which this
 * derives as 2025s (~34 min) — the interval it has actually been enforcing.
 */
export function resolveDwellSecs(
  cfg: Pick<Config, 'DWELL_SECS' | 'DWELL_BLOCKS'>,
  blockTimeSecs: number,
): { secs: number; derived: boolean; note: string } {
  if (cfg.DWELL_SECS !== undefined) {
    return { secs: cfg.DWELL_SECS, derived: false, note: `DWELL_SECS=${cfg.DWELL_SECS}` };
  }
  const secs = Math.max(1, Math.round(cfg.DWELL_BLOCKS * blockTimeSecs));
  return {
    secs,
    derived: true,
    note:
      `derived from deprecated DWELL_BLOCKS=${cfg.DWELL_BLOCKS} x ${blockTimeSecs.toFixed(2)}s/block ` +
      `measured at startup = ${secs}s (~${(secs / 60).toFixed(0)} min) — set DWELL_SECS explicitly`,
  };
}


/**
 * Pick one vault out of the configured list, for the one-shot tools.
 *
 * With a single vault configured there is nothing to choose. With several, the
 * caller must say which — guessing would run the wrong pool, and the cost of
 * that is a real transaction on real liquidity.
 */
export function selectVault(vaults: Config[], selector?: string): Config {
  if (selector) {
    const hit = vaults.find((v) => v.VAULT.toLowerCase() === selector.toLowerCase());
    if (hit) return hit;
    if (vaults.length > 1) {
      throw new Error(
        `no configured vault matches ${selector}. Configured: ${vaults.map((v) => v.VAULT).join(', ')}`,
      );
    }
  }
  if (vaults.length === 1) return vaults[0];
  throw new Error(
    `several vaults configured — pass --vault <address> to choose one: ${vaults.map((v) => v.VAULT).join(', ')}`,
  );
}

/** `--vault 0x…` or `--vault=0x…` from a process argv. */
export function vaultFlag(argv: string[]): string | undefined {
  const i = argv.indexOf('--vault');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--vault='));
  return eq ? eq.slice('--vault='.length) : undefined;
}
