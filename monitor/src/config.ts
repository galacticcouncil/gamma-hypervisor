import { z } from 'zod';
import { ethers } from 'ethers';

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const posInt = z.coerce.number().int().positive();

// swarm renders an unset variable as '', which z.string().url() rejects and
// z.coerce.number() turns into 0 — treat blank as absent for every optional key.
const blank = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (v === '' ? undefined : v), s.optional());

// z.coerce.boolean() makes "false" true, so parse booleans by hand (keeper idiom).
const boolEnv = (def: boolean) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? def : v === true || v === 'true' || v === '1' || v === 'yes'),
    z.boolean(),
  );

// the flat per-pool addresses a VAULTS_FILE deploy leaves behind in the service
// env are never read (pools.ts:201) — drop them before parsing so a stale or
// malformed leftover cannot fail boot.
const PER_POOL_ADDR = ['VAULT', 'POOL', 'CLEARING', 'REBALANCE_PROXY', 'PRICE_FEED'] as const;
const dropFlatPool = (v: unknown) => {
  if (!v || typeof v !== 'object') return v;
  const e = v as Record<string, unknown>;
  if (!e.VAULTS_FILE || e.VAULTS_FILE === '') return v;
  const o = { ...e };
  for (const k of PER_POOL_ADDR) delete o[k];
  return o;
};

const Env = z
  .object({
    // --- global: one rpc, one signer, one webhook, one loop -------------------
    RPC_URL: z.string().url(),
    KEEPER: addr,
    /** Discord webhook. Absent => alerts are logged only, which is a valid dry run. */
    DISCORD_WEBHOOK: blank(z.string().url()),
    CHECK_INTERVAL_SECS: posInt.default(300),
    /** Re-send a still-firing alert only this often, so a stuck condition does not spam. */
    REALERT_SECS: posInt.default(21600),
    /** Warn above the keeper's own GAS_FLOOR_WEI, so there is time to act BEFORE it stops. */
    GAS_WARN_WEI: z.string().regex(/^\d+$/).default('2000000000000000'),   // 0.002
    GAS_FLOOR_WEI: z.string().regex(/^\d+$/).default('1000000000000000'),  // 0.001, mirror the keeper
    /** read-only status listener; 0 = off. overlay only, never publish a port. */
    STATUS_PORT: z.coerce.number().int().min(0).max(65535).default(0),
    /** consecutive failed cycles before one monitor-rpc-failing critical; 0 = off. */
    FAIL_ALERT_CYCLES: z.coerce.number().int().min(0).default(3),
    /** the shared vaults.json; when set the per-pool keys below are ignored. */
    VAULTS_FILE: blank(z.string()),
    ONCE: z.enum(['true', 'false']).default('false'),

    // --- per pool, flat env: exactly one pool, as before VAULTS_FILE existed ---
    VAULT: blank(addr),
    /** derived from vault.pool() when absent. */
    POOL: blank(addr),
    /** no clearing => the paused check is off. */
    CLEARING: blank(addr),
    REBALANCE_PROXY: blank(addr),
    /** no feed => every oracle check (stale, clamp, divergence) is off. */
    PRICE_FEED: blank(addr),
    /** which pool side PRICE_FEED prices; the other side is assumed usd-pegged. */
    PRICE_FEED_SIDE: z.enum(['token0', 'token1']).default('token0'),

    /**
     * Liveness is measured as WORK THAT WAS DUE AND DID NOT HAPPEN, never as
     * "no transactions lately".
     *
     * The nonce is not a liveness signal. A correctly-running keeper sends
     * nothing for days: it rebalances only when drift exceeds its threshold, and
     * its hourly compound is a no-op whenever the vault holds no idle balance
     * (`compound: nothing idle to sweep`). Alerting on a static nonce produced a
     * day of false criticals on a keeper that was healthy throughout.
     *
     * So: mirror the keeper's own rebalance trigger from chain state, and alert
     * only when it has been tripped for longer than the keeper could legitimately
     * take to act.
     */
    /** Must match the keeper's REBALANCE_THRESHOLD_MULT. */
    REBALANCE_THRESHOLD_MULT: posInt.default(11),
    /** Must match the keeper's MIN_INTERVAL_SECS — it may not act sooner. */
    MIN_INTERVAL_SECS: posInt.default(21600),
    /**
     * Grace on top of minInterval before a tripped trigger counts as a failure.
     * Covers dwell (DWELL_SECS), the oracle-agreement gate, and regime holds.
     */
    REBALANCE_GRACE_SECS: posInt.default(7200),
    /**
     * The keeper is RIGHT to hold while pool and oracle disagree — that is the
     * anti-manipulation gate. Above this, a missed rebalance is expected, not a
     * fault, so the check stands down. Must match the keeper's ORACLE_MAX_DEV_TICKS.
     */
    ORACLE_MAX_DEV_TICKS: posInt.default(50),
    /**
     * The keeper clamps the POOL TWAP against the oracle, not spot, so the
     * watchdog has to build the same number or it disagrees with the thing it is
     * watching. All three must match the keeper's TWAP_ENABLED / TWAP_WINDOW_SECS /
     * MIN_TWAP_WINDOW_SECS.
     */
    TWAP_ENABLED: boolEnv(true),
    TWAP_WINDOW_SECS: posInt.default(3600),
    MIN_TWAP_WINDOW_SECS: posInt.default(600),
    /**
     * Mirrors the keeper's LIMIT_REFRESH_ENABLED / LIMIT_REFRESH_TICKS. A one-sided
     * limit routinely holds most of NAV, and it can sit entirely past spot earning
     * nothing while the base stays comfortably inside its drift threshold —
     * invisible to every other check here.
     */
    LIMIT_REFRESH_ENABLED: boolEnv(true),
    LIMIT_REFRESH_TICKS: posInt.default(120),
    /** Pool vs oracle. Matches the deploy config's MAX_DIVERGENCE_BPS. */
    DIVERGENCE_BPS: posInt.default(200),
    /** Feed age ceiling; mirrors the keeper's ORACLE_MAX_AGE_SECS. */
    STALE_SECONDS: posInt.default(28800),
  })
  .superRefine((e, ctx) => {
    if (e.VAULTS_FILE) return;
    for (const k of ['VAULT', 'REBALANCE_PROXY'] as const) {
      if (!e[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: 'required unless VAULTS_FILE is set' });
    }
  });

export type Config = z.infer<typeof Env> & {
  gasWarn: ethers.BigNumber;
  gasFloor: ethers.BigNumber;
  rpcHost: string;
};

/** hostname only — the one form of the url that may appear in a log line or a response. */
export function rpcHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = Env.safeParse(dropFlatPool(env));
  if (!r.success) {
    // keys and rules only; a value could be the webhook
    const issues = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`invalid monitor config: ${issues}`);
  }
  const e = r.data;
  return {
    ...e,
    gasWarn: ethers.BigNumber.from(e.GAS_WARN_WEI),
    gasFloor: ethers.BigNumber.from(e.GAS_FLOOR_WEI),
    rpcHost: rpcHost(e.RPC_URL),
  };
}
