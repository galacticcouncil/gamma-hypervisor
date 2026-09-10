import { z } from 'zod';
import { ethers } from 'ethers';

const Env = z.object({
  RPC_URL: z.string().url(),
  KEEPER: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  VAULT: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  POOL: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  CLEARING: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
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
   * A keeper with nothing to do is silent, so silence alone is not failure.
   * At COMPOUND_INTERVAL_SECS=3600 expect a transaction roughly hourly; 4h of
   * no nonce movement means it is wedged, crashed, or out of gas.
   */
  STALL_MINUTES: z.coerce.number().int().positive().default(240),
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
