import { Router, type RequestHandler } from 'express';
import { compositeEtag } from '../contract/etag';
import { StatusQuery } from '../contract/types';
import { renderFleet, WIDTH } from '../contract/text';
import { ctx, statusBody, statusEtagParts } from '../contract/serialize';
import { parseQuery, sendJson, sendText, wantsText } from './util';

// GET /api/v1/status[.txt] — the one call. never 5xx's because a source is
// down: sources.*.reachable says so and the body is still 200.

function handler(forceText: boolean): RequestHandler {
  return (req, res) => {
    const c = ctx();
    const q = parseQuery(req, res, StatusQuery);
    if (!q) return;
    const body = statusBody(c, { vault: q.vault ?? null, compact: q.compact === 1 });
    const text = forceText || wantsText(req);
    const etag = compositeEtag([...statusEtagParts(c), text ? 'txt' : 'json', q.vault ?? '', q.compact]);
    if (text) sendText(req, res, c, `${renderFleet(body, { nowMs: c.nowMs })}\n`, { etag, width: WIDTH });
    else sendJson(req, res, c, body, { etag });
  };
}

export function statusRoutes(): Router {
  const r = Router();
  r.get('/status', handler(false));
  r.get('/status.txt', handler(true));
  return r;
}
