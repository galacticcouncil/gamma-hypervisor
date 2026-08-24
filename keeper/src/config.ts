import 'dotenv/config';
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
    PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'PRIVATE_KEY must be 0x + 64 hex'),
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
    DWELL_BLOCKS: z.coerce.number().int().positive().default(3),
    TWAP_ENABLED: boolEnv(true),
    TWAP_WINDOW_SECS: z.coerce.number().int().positive().default(3600),
    // The window is clamped to the pool's oldest observation; below this floor the
    // keeper refuses to act rather than trusting a too-short average.
    MIN_TWAP_WINDOW_SECS: z.coerce.number().int().positive().default(600),
    MAX_DEV_TICKS: z.coerce.number().int().positive().default(100),
    // Escape hatch for throwaway local chains ONLY: run live without a TWAP gate.
    ALLOW_UNSAFE_SPOT: boolEnv(false),

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
    ORACLE_FEED0: addr.optional(), // token0/USD, e.g. mainnet DOT/USD
    ORACLE_FEED1: addr.optional(), // token1/USD; omit if token1 is the USD side
    ORACLE_MAX_AGE_SECS: z.coerce.number().int().positive().default(600),
    ORACLE_MAX_DEV_TICKS: z.coerce.number().int().positive().default(200),

    GAS_FLOOR_WEI: z.string().regex(/^\d+$/).default('0'),
    GAS_LIMIT: z.coerce.number().int().positive().default(3_000_000),
    CONFIRMATIONS: z.coerce.number().int().nonnegative().default(3),
    POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),

    // Startup scan for the vault's last Rebalance event (direct mode only —
    // proxy mode reads lastRebalance() on-chain), so restarts keep the cooldown.
    STARTUP_LOOKBACK_BLOCKS: z.coerce.number().int().positive().default(50_000),

    DRY_RUN: boolEnv(false),
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

export type Config = z.infer<typeof Env> & { gasFloorWei: ethers.BigNumber };

export function loadConfig(): Config {
  const e = Env.parse(process.env);
  return { ...e, gasFloorWei: ethers.BigNumber.from(e.GAS_FLOOR_WEI) };
}
