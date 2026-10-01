import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';

// weak etags + 304. express already stamps a weak etag on every res.send and
// answers 304 when If-None-Match matches (app.set('etag','weak')); this adds
// the composite /status etag that changes only when a source did, the
// cache-control rule for history pages, and a conditional helper for bodies
// that are built once (schema, openapi).

export function weakEtag(body: string | Buffer): string {
  const h = createHash('sha1').update(body).digest('base64url').slice(0, 20);
  return `W/"${h}"`;
}

// W/"<keeperBootAt>-<keeperSeq>-<monitorCycleTs>-<sampleTs>"
export function compositeEtag(parts: ReadonlyArray<string | number | null | undefined>): string {
  const s = parts.map((p) => (p === null || p === undefined ? '_' : String(p).replace(/[^A-Za-z0-9:._-]/g, ''))).join('-');
  return `W/"${s}"`;
}

export function matches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const strip = (e: string) => e.trim().replace(/^W\//, '');
  return header.split(',').some((e) => strip(e) === strip(etag));
}

// sets ETag; when If-None-Match matches, ends with 304 and returns true
export function conditional(req: Request, res: Response, etag: string): boolean {
  res.setHeader('ETag', etag);
  if (matches(req.headers['if-none-match'] as string | undefined, etag)) {
    res.status(304).end();
    return true;
  }
  return false;
}

export const HISTORY_IMMUTABLE_AFTER_SECS = 300;

// history pages whose last row is > 5 min old are immutable; tails are not
export function cacheControl(res: Response, lastRowTs: number | null, nowSecs: number): void {
  if (lastRowTs !== null && nowSecs - lastRowTs > HISTORY_IMMUTABLE_AFTER_SECS) {
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  } else {
    res.setHeader('Cache-Control', 'no-cache');
  }
}
