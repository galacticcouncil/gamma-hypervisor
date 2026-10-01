import { dirname } from 'node:path';
import type { UiConfig } from '../config';

// second-pass redaction on everything the ui re-serves. the keeper scrubs its
// key by value before a line leaves its process; the ui never knows the key,
// so here it is patterns (credentialed urls, webhooks, ethers' url="…" /
// requestBody="…"), the ui's own internal urls/paths by value, and — on
// config-shaped bodies only — the 64-hex shape. tx hashes elsewhere survive.

export const REDACTED = '[redacted]';

export const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // //user:pass@host
  [/(\/\/)[^\/\s@"'<>]+:[^\/\s@"'<>]+@/g, `$1${REDACTED}@`],
  // discord webhook urls, with or without the scheme
  [/discord(?:app)?\.com\/api\/webhooks\/[^\s"'<>]+/gi, `discord.com/api/webhooks/${REDACTED}`],
  // ethers v5 SERVER_ERROR embeds the url and body it sent
  [/\b(url|requestBody)=("[^"]*"|'[^']*'|[^\s,)]+)/g, `$1="${REDACTED}"`],
];

// json keys whose value is a credential by name, whatever the body
export const SECRET_KEY_RE = /(private[_-]?key|secret|token|webhook|passw(or)?d|mnemonic|seed[_-]?phrase|api[_-]?key)/i;

// 64 hex digits with or without 0x, not part of a longer hex run
export const HEX64 = /(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;

function hostForms(u: string | undefined): string[] {
  if (!u) return [];
  try {
    const p = new URL(u);
    const out = [u, p.host];
    if (p.hostname !== p.host) out.push(p.hostname);
    return out;
  } catch {
    return [u];
  }
}

// the ui's own internal urls, hostnames and paths as they appear in env
export function redactValuesFrom(cfg: UiConfig): string[] {
  const vals = new Set<string>();
  for (const v of [...hostForms(cfg.KEEPER_URL), ...hostForms(cfg.MONITOR_URL)]) vals.add(v);
  // rpc hosts are public by design; only the full urls (which may carry keys) go
  if (cfg.RPC_URL) vals.add(cfg.RPC_URL);
  if (cfg.HEAD_FALLBACK_URL) vals.add(cfg.HEAD_FALLBACK_URL);
  vals.add(cfg.DB_PATH);
  vals.add(dirname(cfg.DB_PATH) + '/');
  vals.add(cfg.BACKUP_DIR);
  vals.add(cfg.VAULTS_FILE);
  if (cfg.METRICS_TOKEN) vals.add(cfg.METRICS_TOKEN);
  // short values would shred ordinary text; hostnames like `keeper` are still caught by the url form
  return [...vals].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
}

export function redactText(s: string, values: readonly string[] = []): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  for (const v of values) if (v && out.includes(v)) out = out.split(v).join(REDACTED);
  return out;
}

export function redactHex64(s: string): string {
  return s.replace(HEX64, REDACTED);
}

type Walk = (s: string, key: string | null) => string;

function walk(v: unknown, f: Walk, key: string | null = null): unknown {
  if (typeof v === 'string') return f(v, key);
  if (Array.isArray(v)) return v.map((x) => walk(x, f, key));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, f, k);
    return out;
  }
  return v;
}

// patterns + values on every string; credential-named keys blanked outright
export function redactJson<T>(v: T, values: readonly string[] = []): T {
  return walk(v, (s, key) => (key && SECRET_KEY_RE.test(key) ? REDACTED : redactText(s, values))) as T;
}

// config-shaped bodies: the above plus the 64-hex shape rule
export function redactConfig<T>(v: T, values: readonly string[] = []): T {
  return walk(v, (s, key) => (key && SECRET_KEY_RE.test(key) ? REDACTED : redactHex64(redactText(s, values)))) as T;
}
