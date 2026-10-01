import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { z } from 'zod';
import type { Config } from './config';

/**
 * One pool = one vault the watchdog mirrors. Either the flat environment
 * (exactly one pool, as before) or the shared vaults.json (VAULTS_FILE) — the
 * same descriptor the keeper and the ui read, with the monitor's own settings
 * under MONITOR_* keys.
 */

/** the keeper values this watchdog mirrors, plus its own grace/divergence. */
export interface Thresholds {
  REBALANCE_THRESHOLD_MULT: number;
  MIN_INTERVAL_SECS: number;
  REBALANCE_GRACE_SECS: number;
  TWAP_ENABLED: boolean;
  TWAP_WINDOW_SECS: number;
  MIN_TWAP_WINDOW_SECS: number;
  /** null when no feed is configured: the oracle checks are off. */
  ORACLE_MAX_DEV_TICKS: number | null;
  STALE_SECONDS: number | null;
  LIMIT_REFRESH_ENABLED: boolean;
  LIMIT_REFRESH_TICKS: number;
  DIVERGENCE_BPS: number;
}

/** what env or the descriptor say; nothing here needs the chain. */
export interface PoolSpec {
  /** lowercase vault address. */
  id: string;
  label: string | null;
  vault: string;
  /** null = derive from vault.pool() at boot. */
  pool: string | null;
  proxy: string;
  clearing: string | null;
  feed: string | null;
  feed1: string | null;
  feed0Side: 'token0' | 'token1';
  thresholds: Thresholds;
}

/** a spec after one boot-time read of pool address, decimals and symbols. */
export interface Pool extends PoolSpec {
  label: string;
  pool: string;
  dec0: number;
  dec1: number;
  sym0: string;
  sym1: string;
}

/** flat env key → descriptor key. null = derived, no key at all. */
export const KEY_MAP = {
  VAULT: 'VAULT',
  REBALANCE_PROXY: 'REBALANCE_PROXY',
  POOL: null,
  CLEARING: 'MONITOR_CLEARING',
  PRICE_FEED: 'ORACLE_FEED0',
  PRICE_FEED_SIDE: 'ORACLE_FEED0_SIDE',
  STALE_SECONDS: 'ORACLE_MAX_AGE_SECS',
  REBALANCE_GRACE_SECS: 'MONITOR_GRACE_SECS',
  DIVERGENCE_BPS: 'MONITOR_DIVERGENCE_BPS',
  REBALANCE_THRESHOLD_MULT: 'REBALANCE_THRESHOLD_MULT',
  MIN_INTERVAL_SECS: 'MIN_INTERVAL_SECS',
  ORACLE_MAX_DEV_TICKS: 'ORACLE_MAX_DEV_TICKS',
  TWAP_ENABLED: 'TWAP_ENABLED',
  TWAP_WINDOW_SECS: 'TWAP_WINDOW_SECS',
  MIN_TWAP_WINDOW_SECS: 'MIN_TWAP_WINDOW_SECS',
  LIMIT_REFRESH_ENABLED: 'LIMIT_REFRESH_ENABLED',
  LIMIT_REFRESH_TICKS: 'LIMIT_REFRESH_TICKS',
} as const;

export type PoolSource = 'env' | 'VAULTS_FILE';

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const posInt = z.coerce.number().int().positive();
const nonneg = z.coerce.number().int().nonnegative();
// json carries real booleans; a hand-written file may carry the env spelling
const jbool = z.preprocess(
  (v) => (typeof v === 'string' ? v === 'true' || v === '1' || v === 'yes' : v),
  z.boolean(),
);

// the descriptor spells "unset" as json null (the keeper drops the inherited
// default on null); drop those keys so an optional one falls back to its default
// and a mirrored one still fails as missing rather than as a type error.
const dropNulls = (v: unknown) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== null) o[k] = x;
  return o;
};

// the monitor's view of one descriptor entry: keeper keys it mirrors, its own
// MONITOR_* keys, everything else (UI_*, the rest of VAULT_KEYS) passes through.
// mirrored values are required outright — a descriptor that leans on a default
// here while the keeper runs another value is the mis-mirror class this exists
// to prevent.
const Entry = z
  .object({
    VAULT: addr,
    LABEL: z.string().max(24).optional(),
    REBALANCE_PROXY: addr,
    MONITOR_CLEARING: addr.optional(),
    MONITOR_GRACE_SECS: posInt.default(7200),
    MONITOR_DIVERGENCE_BPS: posInt.default(200),
    ORACLE_ENABLED: jbool,
    ORACLE_FEED0: addr.optional(),
    ORACLE_FEED1: addr.optional(),
    ORACLE_FEED0_SIDE: z.enum(['token0', 'token1']).default('token0'),
    ORACLE_MAX_AGE_SECS: posInt.optional(),
    ORACLE_MAX_DEV_TICKS: posInt.optional(),
    TWAP_ENABLED: jbool,
    TWAP_WINDOW_SECS: posInt.optional(),
    MIN_TWAP_WINDOW_SECS: posInt.optional(),
    REBALANCE_THRESHOLD_MULT: nonneg,
    MIN_INTERVAL_SECS: nonneg,
    LIMIT_REFRESH_ENABLED: jbool,
    LIMIT_REFRESH_TICKS: posInt.optional(),
  })
  .passthrough()
  .superRefine((e, ctx) => {
    const need = (k: string, when: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: `required when ${when}` });
    if (e.ORACLE_ENABLED) {
      if (!e.ORACLE_FEED0) need('ORACLE_FEED0', 'ORACLE_ENABLED=true');
      if (e.ORACLE_MAX_AGE_SECS === undefined) need('ORACLE_MAX_AGE_SECS', 'ORACLE_ENABLED=true');
      if (e.ORACLE_MAX_DEV_TICKS === undefined) need('ORACLE_MAX_DEV_TICKS', 'ORACLE_ENABLED=true');
    }
    if (e.TWAP_ENABLED) {
      if (e.TWAP_WINDOW_SECS === undefined) need('TWAP_WINDOW_SECS', 'TWAP_ENABLED=true');
      if (e.MIN_TWAP_WINDOW_SECS === undefined) need('MIN_TWAP_WINDOW_SECS', 'TWAP_ENABLED=true');
    }
    if (e.LIMIT_REFRESH_ENABLED && e.LIMIT_REFRESH_TICKS === undefined) need('LIMIT_REFRESH_TICKS', 'LIMIT_REFRESH_ENABLED=true');
  });

export function specFromEnv(cfg: Config): PoolSpec {
  if (!cfg.VAULT || !cfg.REBALANCE_PROXY) throw new Error('VAULT and REBALANCE_PROXY are required without VAULTS_FILE');
  const feed = cfg.PRICE_FEED ?? null;
  return {
    id: cfg.VAULT.toLowerCase(),
    label: null,
    vault: cfg.VAULT,
    pool: cfg.POOL ?? null,
    proxy: cfg.REBALANCE_PROXY,
    clearing: cfg.CLEARING ?? null,
    feed,
    feed1: null,
    feed0Side: cfg.PRICE_FEED_SIDE,
    thresholds: {
      REBALANCE_THRESHOLD_MULT: cfg.REBALANCE_THRESHOLD_MULT,
      MIN_INTERVAL_SECS: cfg.MIN_INTERVAL_SECS,
      REBALANCE_GRACE_SECS: cfg.REBALANCE_GRACE_SECS,
      TWAP_ENABLED: cfg.TWAP_ENABLED,
      TWAP_WINDOW_SECS: cfg.TWAP_WINDOW_SECS,
      MIN_TWAP_WINDOW_SECS: cfg.MIN_TWAP_WINDOW_SECS,
      ORACLE_MAX_DEV_TICKS: feed ? cfg.ORACLE_MAX_DEV_TICKS : null,
      STALE_SECONDS: feed ? cfg.STALE_SECONDS : null,
      LIMIT_REFRESH_ENABLED: cfg.LIMIT_REFRESH_ENABLED,
      LIMIT_REFRESH_TICKS: cfg.LIMIT_REFRESH_TICKS,
      DIVERGENCE_BPS: cfg.DIVERGENCE_BPS,
    },
  };
}

export function specsFromDescriptor(doc: unknown, where = 'VAULTS_FILE'): PoolSpec[] {
  if (!Array.isArray(doc)) throw new Error(`${where}: expected a JSON array of vault objects`);
  if (doc.length === 0) throw new Error(`${where}: no vaults`);
  const specs = doc.map((raw, i) => {
    const r = Entry.safeParse(dropNulls(raw));
    if (!r.success) {
      const issues = r.error.issues.map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`).join('; ');
      throw new Error(`${where}[${i}]: ${issues}`);
    }
    const e = r.data;
    const feed = e.ORACLE_ENABLED ? e.ORACLE_FEED0! : null;
    return {
      id: e.VAULT.toLowerCase(),
      label: e.LABEL ?? null,
      vault: e.VAULT,
      pool: null,
      proxy: e.REBALANCE_PROXY,
      clearing: e.MONITOR_CLEARING ?? null,
      feed,
      feed1: feed ? e.ORACLE_FEED1 ?? null : null,
      feed0Side: e.ORACLE_FEED0_SIDE,
      thresholds: {
        REBALANCE_THRESHOLD_MULT: e.REBALANCE_THRESHOLD_MULT,
        MIN_INTERVAL_SECS: e.MIN_INTERVAL_SECS,
        REBALANCE_GRACE_SECS: e.MONITOR_GRACE_SECS,
        TWAP_ENABLED: e.TWAP_ENABLED,
        TWAP_WINDOW_SECS: e.TWAP_WINDOW_SECS ?? 0,
        MIN_TWAP_WINDOW_SECS: e.MIN_TWAP_WINDOW_SECS ?? 0,
        ORACLE_MAX_DEV_TICKS: feed ? e.ORACLE_MAX_DEV_TICKS! : null,
        STALE_SECONDS: feed ? e.ORACLE_MAX_AGE_SECS! : null,
        LIMIT_REFRESH_ENABLED: e.LIMIT_REFRESH_ENABLED,
        LIMIT_REFRESH_TICKS: e.LIMIT_REFRESH_TICKS ?? 0,
        DIVERGENCE_BPS: e.MONITOR_DIVERGENCE_BPS,
      },
    } satisfies PoolSpec;
  });
  const dup = specs.map((s) => s.id).find((id, i, a) => a.indexOf(id) !== i);
  if (dup) throw new Error(`${where}: vault ${dup} listed twice`);
  return specs;
}

export function loadPoolSpecs(cfg: Config): { source: PoolSource; specs: PoolSpec[] } {
  if (!cfg.VAULTS_FILE) return { source: 'env', specs: [specFromEnv(cfg)] };
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(cfg.VAULTS_FILE, 'utf8'));
  } catch (e) {
    throw new Error(`VAULTS_FILE: cannot read or parse (${(e as Error).message})`);
  }
  return { source: 'VAULTS_FILE', specs: specsFromDescriptor(doc) };
}

// --- boot-time chain reads -------------------------------------------------

export interface ChainReader {
  pool(vault: string): Promise<string>;
  tokens(vault: string): Promise<[string, string]>;
  decimals(token: string): Promise<number>;
  symbol(token: string): Promise<string>;
}

const ABI = {
  vault: [
    'function pool() view returns (address)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
  ],
  erc20: ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'],
};

export function ethersReader(p: ethers.providers.Provider): ChainReader {
  const vault = (a: string) => new ethers.Contract(a, ABI.vault, p);
  const erc20 = (a: string) => new ethers.Contract(a, ABI.erc20, p);
  return {
    pool: async (v) => String(await vault(v).pool()),
    tokens: async (v) => {
      const c = vault(v);
      const [t0, t1] = await Promise.all([c.token0(), c.token1()]);
      return [String(t0), String(t1)];
    },
    decimals: async (t) => Number(await erc20(t).decimals()),
    symbol: async (t) => String(await erc20(t).symbol()),
  };
}

// decimals are load-bearing (the tick↔price math and nav shift by whole decades
// on a wrong value), so they must read; symbols only name the pool.
export async function resolvePool(spec: PoolSpec, r: ChainReader): Promise<Pool> {
  const pool = spec.pool ?? (await r.pool(spec.vault));
  const [t0, t1] = await r.tokens(spec.vault);
  const [dec0, dec1] = await Promise.all([r.decimals(t0), r.decimals(t1)]);
  if (!Number.isInteger(dec0) || !Number.isInteger(dec1)) throw new Error(`${spec.id}: token decimals unreadable`);
  const [sym0, sym1] = await Promise.all([r.symbol(t0).catch(() => '?'), r.symbol(t1).catch(() => '?')]);
  return { ...spec, pool, dec0, dec1, sym0, sym1, label: spec.label ?? `${sym0}/${sym1}` };
}

export async function resolvePools(specs: PoolSpec[], r: ChainReader): Promise<Pool[]> {
  const out: Pool[] = [];
  for (const s of specs) out.push(await resolvePool(s, r));
  return out;
}

/** one line per pool for the boot banner: which optional gates are on. */
export function describePool(p: PoolSpec): string {
  const t = p.thresholds;
  const gates = [
    p.feed ? `oracle dev<=${t.ORACLE_MAX_DEV_TICKS} age<=${t.STALE_SECONDS}s` : 'oracle off',
    t.TWAP_ENABLED ? `twap ${t.TWAP_WINDOW_SECS}s/${t.MIN_TWAP_WINDOW_SECS}s` : 'twap off',
    p.clearing ? 'clearing' : 'clearing off',
    t.LIMIT_REFRESH_ENABLED ? `limit refresh >${t.LIMIT_REFRESH_TICKS}` : 'limit refresh off',
  ];
  return `${p.label ?? p.id}  vault ${p.vault}  ${gates.join('  ')}`;
}
