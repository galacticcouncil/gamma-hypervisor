import { z } from 'zod';

// env -> config, once. urls never leave this module as anything but a host;
// loadConfig errors name the key and the rule, never the value.

const url = z.string().url();
const posInt = z.coerce.number().int().positive();

export const RATE_LIMIT_RE = /^(\d+)\/(\d+)(ms|s|m)$/;

// `60/10s` -> { max: 60, windowMs: 10000 }
export function parseRateLimit(s: string): { max: number; windowMs: number } {
  const m = RATE_LIMIT_RE.exec(s);
  if (!m) throw new Error('RATE_LIMIT: expected <count>/<window>(ms|s|m), e.g. 60/10s');
  const unit = { ms: 1, s: 1000, m: 60_000 }[m[3] as 'ms' | 's' | 'm'];
  return { max: Number(m[1]), windowMs: Number(m[2]) * unit };
}

export const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  RPC_URL: url,
  HEAD_FALLBACK_URL: url.optional(),
  VAULTS_FILE: z.string().min(1).default('/run/config/vaults.json'),
  KEEPER_URL: url.optional(),
  MONITOR_URL: url.optional(),
  KEEPER_POLL_MS: posInt.default(5000),
  MONITOR_POLL_MS: posInt.default(60_000),
  SAMPLE_SECS: posInt.default(60),
  FEES_EVERY_N: posInt.default(5),
  EVENTS_SECS: posInt.default(60),
  BACKFILL_CHUNK_BLOCKS: posInt.default(2000),
  DB_PATH: z.string().min(1).default('/data/gamma.db'),
  BACKUP_DIR: z.string().min(1).default('/backup'),
  RAW_RETENTION_HOURS: z.coerce.number().int().nonnegative().default(72), // 0 disables
  SAMPLE_RETENTION_DAYS: posInt.default(90),
  RATE_LIMIT: z.string().regex(RATE_LIMIT_RE, 'expected <count>/<window>(ms|s|m)').default('60/10s'),
  SSE_PER_IP: posInt.default(2),
  METRICS_TOKEN: z.string().min(1).optional(),
  PUBLIC_URL: url.optional(),
  ORIGIN: url.optional(),
  COMMIT: z.string().min(1).optional(),
});
export type EnvConfig = z.infer<typeof Env>;

export interface UiConfig extends EnvConfig {
  rateLimit: { max: number; windowMs: number };
  // hostnames only: the one form of an rpc url that may appear in a response
  rpcHost: string;
  headFallbackHost: string | null;
  keeperConfigured: boolean;
  monitorConfigured: boolean;
}

export function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return 'invalid';
  }
}

// swarm renders unset vars as '' — treat those as absent, like the monitor's webhook fix
function stripEmpty(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(Env.shape)) {
    const v = env[k];
    if (v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): UiConfig {
  const parsed = Env.safeParse(stripEmpty(env));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.') || '?'}: ${i.message}`);
    throw new Error(`invalid ui config:\n  ${lines.join('\n  ')}`);
  }
  const c = parsed.data;
  return {
    ...c,
    rateLimit: parseRateLimit(c.RATE_LIMIT),
    rpcHost: hostOf(c.RPC_URL),
    headFallbackHost: c.HEAD_FALLBACK_URL ? hostOf(c.HEAD_FALLBACK_URL) : null,
    keeperConfigured: c.KEEPER_URL !== undefined,
    monitorConfigured: c.MONITOR_URL !== undefined,
  };
}

let current: UiConfig | null = null;

// process config, loaded on first use so tests can import modules without an env
export function getConfig(): UiConfig {
  if (!current) current = loadConfig();
  return current;
}

// tests only: replace (or clear) the process config
export function setConfig(c: UiConfig | null): void {
  current = c;
}

// the ui's own config as /api/v1/config publishes it: no urls, hostnames or paths
export function publicConfig(cfg: UiConfig, keeperRpcHost: string | null) {
  return {
    keeper: { configured: cfg.keeperConfigured },
    monitor: { configured: cfg.monitorConfigured },
    rpcHost: cfg.rpcHost,
    headFallback: { configured: cfg.headFallbackHost !== null },
    chainRpcShared: keeperRpcHost === null ? null : cfg.rpcHost === keeperRpcHost,
    commit: cfg.COMMIT ?? null,
  };
}
