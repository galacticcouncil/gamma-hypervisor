import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import { cacheControl, conditional, weakEtag } from '../contract/etag';
import { redactConfig, redactJson, redactText, redactValuesFrom, HEX64 } from '../contract/redact';
import type { ErrorCode } from '../contract/enums';
import { fit, toIso } from '../contract/format';
import { ctx, cursorOf, findVaultRow, keeperConfigOf, parseCursor, type Ctx } from '../contract/serialize';
import type { VaultRow } from '../collect/descriptor';

// every response leaves through here: the second redaction pass, the weak etag
// and 304, the cache-control rule and the one error envelope. hints come from a
// fixed table — an upstream message is never echoed.

export const HINTS: Readonly<Record<ErrorCode, string>> = {
  'bad-request': 'check the query parameters against /api/v1/schema',
  'not-found': 'list what exists at /api/v1/vaults or /api/v1/queries',
  'method-not-allowed': 'the api is read-only: GET (and HEAD) only',
  'rate-limited': 'retry after the Retry-After header; /api/v1/stream has its own connect limit, not the request one',
  'stream-limit': 'too many open streams; reconnect with Last-Event-ID after Retry-After',
  internal: 'the request was dropped on this side; retry, then read /healthz',
};

// values the ui learns are secret-shaped: any 64-hex in the keeper's /config
// projection. redaction is by value, not by shape — a tx hash elsewhere survives
const learned = new Set<string>();
let learnedFingerprint: string | null = null;

export function learnSecrets(v: unknown): void {
  const walk = (x: unknown): void => {
    if (typeof x === 'string') {
      for (const m of x.match(HEX64) ?? []) {
        const bare = m.startsWith('0x') ? m.slice(2) : m;
        learned.add(bare);
        learned.add(`0x${bare}`);
        learned.add(bare.toUpperCase());
        learned.add(`0x${bare.toUpperCase()}`);
        learned.add(bare.toLowerCase());
        learned.add(`0x${bare.toLowerCase()}`);
      }
      return;
    }
    if (Array.isArray(x)) {
      for (const y of x) walk(y);
      return;
    }
    if (x !== null && typeof x === 'object') for (const y of Object.values(x)) walk(y);
  };
  walk(v);
}

// tests only
export function resetLearnedSecrets(): void {
  learned.clear();
  learnedFingerprint = null;
}

function learnFromKeeper(c: Ctx): void {
  const cfg = keeperConfigOf(c);
  if (!cfg) return;
  if (cfg.fingerprint && cfg.fingerprint === learnedFingerprint) return;
  learnedFingerprint = cfg.fingerprint ?? null;
  learnSecrets(cfg);
}

export function redactionValues(c: Ctx): string[] {
  learnFromKeeper(c);
  return [...redactValuesFrom(c.cfg), ...learned].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
}

export interface SendOpts {
  // overrides the body hash, e.g. the composite /status etag
  etag?: string;
  // newest row in the body: > 5 min old makes the page immutable
  lastRowTs?: number | null;
  // config-shaped body: the 64-hex shape rule applies here and only here
  config?: boolean;
  // text bodies: re-fit every line to this many code points after redaction
  width?: number;
  status?: number;
}

// `generatedAt` is the clock, not the content: it never enters the hash, so an
// unchanged body still answers 304
function etagOf(clean: unknown): string {
  if (clean !== null && typeof clean === 'object' && 'generatedAt' in (clean as Record<string, unknown>)) {
    return weakEtag(JSON.stringify({ ...(clean as Record<string, unknown>), generatedAt: null }));
  }
  return weakEtag(JSON.stringify(clean));
}

export function sendJson(req: Request, res: Response, c: Ctx, body: unknown, o: SendOpts = {}): void {
  const values = redactionValues(c);
  const clean = o.config ? redactConfig(body, values) : redactJson(body, values);
  const text = JSON.stringify(clean);
  const etag = o.etag ?? etagOf(clean);
  cacheControl(res, o.lastRowTs ?? null, c.nowTs);
  if (o.status === undefined && conditional(req, res, etag)) return;
  if (o.status !== undefined) res.status(o.status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(text);
}

export function sendText(req: Request, res: Response, c: Ctx, body: string, o: SendOpts = {}): void {
  // a replacement can shorten a line, so a screen is re-fitted to its width
  // after redaction: `every emitted line is exactly 78` holds whatever leaked
  const redacted = redactText(body, redactionValues(c));
  const clean = o.width === undefined ? redacted : redacted.split('\n').map((l) => (l.length === 0 ? l : fit(l, o.width as number))).join('\n');
  const etag = o.etag ?? weakEtag(clean);
  cacheControl(res, o.lastRowTs ?? null, c.nowTs);
  if (conditional(req, res, etag)) return;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(clean);
}

export function fail(req: Request, res: Response, status: number, code: ErrorCode, message: string): void {
  const c = safeCtx();
  const body = { v: 1 as const, generatedAt: toIso(Date.now()), error: { code, message, hint: HINTS[code] } };
  res.setHeader('Cache-Control', 'no-store');
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(c ? redactJson(body, redactionValues(c)) : body));
}

function safeCtx(): Ctx | null {
  try {
    return ctx();
  } catch {
    return null;
  }
}

// GET (and HEAD) only; anything else is 405 with Allow
export function getOnly(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD') {
    next();
    return;
  }
  res.setHeader('Allow', 'GET, HEAD');
  fail(req, res, 405, 'method-not-allowed', `${req.method} is not allowed`);
}

export function parseQuery<S extends z.ZodTypeAny>(req: Request, res: Response, schema: S): z.infer<S> | null {
  const parsed = schema.safeParse(req.query);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  fail(req, res, 400, 'bad-request', `${issue.path.join('.') || 'query'}: ${issue.message}`);
  return null;
}

// `{id}` is a lowercase address or a label slug; `.txt` is stripped by the caller
export function vaultOr404(req: Request, res: Response, c: Ctx): VaultRow | null {
  const raw = String(req.params.id ?? '');
  const row = findVaultRow(c, raw.replace(/\.txt$/, ''));
  if (!row) {
    fail(req, res, 404, 'not-found', 'unknown vault');
    return null;
  }
  return row;
}

export function wantsText(req: Request): boolean {
  if (/\.txt$/.test(String(req.params.id ?? '')) || /\.txt$/.test(req.path)) return true;
  const accept = String(req.headers.accept ?? '');
  return /text\/plain/.test(accept) && !/application\/json/.test(accept);
}

// node:sqlite rejects a named parameter the statement does not mention, so
// conditional where-clauses bind only what survived into the sql
export function bindOnly<T extends Record<string, unknown>>(sql: string, params: T): Record<string, never> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (new RegExp(`:${k}\\b`).test(sql)) out[k] = v;
  return out as Record<string, never>;
}

export function rows(c: Ctx, sql: string, params: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return c.db.all(sql, bindOnly(sql, params));
}

// --- paging -------------------------------------------------------------------

export interface PageWindow {
  sinceId: number | null;
  sinceTs: number | null;
  limit: number;
  order: 'asc' | 'desc';
}

export function pageWindow(q: { since?: string; limit: number; order: 'asc' | 'desc' }): PageWindow {
  const cur = parseCursor(q.since);
  return { sinceId: cur.id, sinceTs: cur.ts, limit: q.limit, order: q.order };
}

export interface PageBody<T> {
  v: 1;
  generatedAt: string;
  items: T[];
  next: string | null;
  complete: boolean;
}

// rows are immutable, so `next` is the last row's id and paging survives a restart
export function page<T>(c: Ctx, rows: T[], idOf: (row: T) => number, limit: number): PageBody<T> {
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  return {
    v: 1,
    generatedAt: toIso(c.nowMs),
    items,
    next: more && items.length ? cursorOf(idOf(items[items.length - 1])) : null,
    complete: !more,
  };
}

// `id > :since` ascending, `id < :since` descending
export function cursorWhere(w: PageWindow, column = 'id'): { clause: string; param: number | null } {
  if (w.sinceId === null) return { clause: '1 = 1', param: null };
  return { clause: `${column} ${w.order === 'asc' ? '>' : '<'} :sinceId`, param: w.sinceId };
}
