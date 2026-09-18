import { Router } from 'express';
import { FindingsQuery } from '../contract/types';
import { configBody, ctx, findings, findVaultRow, monitorBody } from '../contract/serialize';
import { fail, page, pageWindow, parseQuery, sendJson } from './util';

// /api/v1/findings, /config, /monitor. a finding is never blanked because its
// source went quiet — it is flagged `stale` and kept.

export function findingRoutes(): Router {
  const r = Router();

  r.get('/findings', (req, res) => {
    const c = ctx();
    const q = parseQuery(req, res, FindingsQuery);
    if (!q) return;
    const w = pageWindow(q);
    let vault: string | null = null;
    if (q.vault) {
      const row = findVaultRow(c, q.vault);
      if (!row) return void fail(req, res, 404, 'not-found', 'unknown vault');
      vault = row.id;
    }
    // the cursor is the rowid, so the page is id-ordered here; severity sorting
    // is the fleet footer's job (serialize.findings does it for /status)
    const items = findings(c, { active: q.active === 1, vault, sinceId: w.sinceId ?? undefined, limit: w.limit + 1 }).sort((a, b) => a.id - b.id);
    sendJson(req, res, c, page(c, items, (x) => x.id, w.limit));
  });

  // the only body the 64-hex shape rule runs against: tx hashes never appear here
  r.get('/config', (req, res) => {
    const c = ctx();
    sendJson(req, res, c, configBody(c), { config: true });
  });

  r.get('/monitor', (req, res) => {
    const c = ctx();
    sendJson(req, res, c, monitorBody(c));
  });

  return r;
}
