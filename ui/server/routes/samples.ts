import { Router } from 'express';
import { EconomicsQuery, SamplesQuery } from '../contract/types';
import { ctx, economicsBody, samplesBody } from '../contract/serialize';
import { parseQuery, sendJson, vaultOr404 } from './util';

// /vaults/{id}/samples and /economics. samples are capped at 5000 points and
// 90d; step >= 3600 is served from the hourly rollup. economics publishes both
// hodl benchmarks with fees / il under `experimental`.

const MAX_WINDOW_SECS = 90 * 86400;

export function sampleRoutes(): Router {
  const r = Router();

  r.get('/vaults/:id/samples', (req, res) => {
    const c = ctx();
    const row = vaultOr404(req, res, c);
    if (!row) return;
    const q = parseQuery(req, res, SamplesQuery);
    if (!q) return;
    const to = q.to ?? c.nowTs;
    const from = Math.max(q.from ?? to - 86400, to - MAX_WINDOW_SECS);
    const body = samplesBody(c, row, { from, to, step: q.step, fields: q.fields });
    sendJson(req, res, c, body, { lastRowTs: body.items.length ? body.items[body.items.length - 1].ts : null });
  });

  r.get('/vaults/:id/economics', (req, res) => {
    const c = ctx();
    const row = vaultOr404(req, res, c);
    if (!row) return;
    const q = parseQuery(req, res, EconomicsQuery);
    if (!q) return;
    sendJson(req, res, c, economicsBody(c, row, q.window));
  });

  return r;
}
