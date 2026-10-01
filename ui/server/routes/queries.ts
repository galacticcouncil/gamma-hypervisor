import { Router } from 'express';
import { ctx } from '../contract/serialize';
import { listQueries, runQuery, QueryError } from '../db/queries';
import { toIso } from '../contract/format';
import { fail, sendJson } from './util';

// /api/v1/queries[/{name}] — named prepared statements only. params are zod
// validated (vault, from, to <= 90d apart, limit <= 5000); no free-form sql
// reaches sqlite.

export function queryRoutes(): Router {
  const r = Router();

  r.get('/queries', (req, res) => {
    const c = ctx();
    sendJson(req, res, c, { v: 1, generatedAt: toIso(c.nowMs), items: listQueries() });
  });

  r.get('/queries/:name', (req, res) => {
    const c = ctx();
    try {
      const out = runQuery(c.db, String(req.params.name), req.query as Record<string, unknown>, c.nowTs);
      sendJson(req, res, c, { v: 1, generatedAt: toIso(c.nowMs), ...out });
    } catch (e) {
      if (e instanceof QueryError) {
        fail(req, res, e.code === 'not-found' ? 404 : 400, e.code, e.message);
        return;
      }
      fail(req, res, 500, 'internal', 'query failed');
    }
  });

  return r;
}
