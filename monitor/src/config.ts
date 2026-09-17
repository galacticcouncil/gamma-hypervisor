import { z } from 'zod';
import { ethers } from 'ethers';

const Env = z.object({
  RPC_URL: z.string().url(),
  KEEPER: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  VAULT: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  POOL: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  CLEARING: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  REBALANCE_PROXY: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  PRICE_FEED: z.string().regex(/^0x[0-9a-fA-F]{40}$/),

  /** Discord webhook. Absent => alerts are logged only, which is a valid dry run. */
  DISCORD_WEBHOOK: z.string().url().optional(),

  CHECK_INTERVAL_SECS: z.coerce.number().int().positive().default(300),
  /** Re-send a still-firing alert only this often, so a stuck condition does not spam. */
  REALERT_SECS: z.coerce.number().int().positive().default(21600),

  /** Warn above the keeper's own GAS_FLOOR_WEI, so there is time to act BEFORE it stops. */
  GAS_WARN_WEI: z.string().regex(/^\d+$/).default('2000000000000000'),   // 0.002
  GAS_FLOOR_WEI: z.string().regex(/^\d+$/).default('1000000000000000'),  // 0.001, mirror the keeper

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
  REBALANCE_THRESHOLD_MULT: z.coerce.number().int().positive().default(11),
  /** Must match the keeper's MIN_INTERVAL_SECS — it may not act sooner. */
  MIN_INTERVAL_SECS: z.coerce.number().int().positive().default(21600),
  /**
   * Grace on top of minInterval before a tripped trigger counts as a failure.
   * Covers dwell (DWELL_BLOCKS), the oracle-agreement gate, and regime holds.
   */
  REBALANCE_GRACE_SECS: z.coerce.number().int().positive().default(7200),
  /**
   * The keeper is RIGHT to hold while pool and oracle disagree — that is the
   * anti-manipulation gate. Above this, a missed rebalance is expected, not a
   * fault, so the check stands down. Must match the keeper's ORACLE_MAX_DEV_TICKS.
   */
  ORACLE_MAX_DEV_TICKS: z.coerce.number().int().positive().default(50),
  /**
   * The keeper clamps the POOL TWAP against the oracle, not spot, so the
   * watchdog has to build the same number or it disagrees with the thing it is
   * watching. Both must match the keeper's TWAP_WINDOW_SECS / MIN_TWAP_WINDOW_SECS.
   */
  TWAP_WINDOW_SECS: z.coerce.number().int().positive().default(3600),
  MIN_TWAP_WINDOW_SECS: z.coerce.number().int().positive().default(600),
  /**
   * Mirrors the keeper's LIMIT_REFRESH_TICKS. A one-sided limit routinely holds
   * most of NAV, and it can sit entirely past spot earning nothing while the
   * base stays comfortably inside its drift threshold — invisible to every
   * other check here.
   */
  LIMIT_REFRESH_TICKS: z.coerce.number().int().positive().default(120),
  /** Pool vs oracle. Matches the deploy config's MAX_DIVERGENCE_BPS. */
  DIVERGENCE_BPS: z.coerce.number().int().positive().default(200),
  /** Feed age ceiling; mirrors STALE_SECONDS on the deploy side. */
  STALE_SECONDS: z.coerce.number().int().positive().default(28800),
  ONCE: z.enum(['true', 'false']).default('false'),
});

export type Config = z.infer<typeof Env> & {
  gasWarn: ethers.BigNumber;
  gasFloor: ethers.BigNumber;
};

export function loadConfig(): Config {
  const e = Env.parse(process.env);
  return {
    ...e,
    gasWarn: ethers.BigNumber.from(e.GAS_WARN_WEI),
    gasFloor: ethers.BigNumber.from(e.GAS_FLOOR_WEI),
  };
}
