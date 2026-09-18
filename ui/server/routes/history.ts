import { Router } from 'express';
import { z } from 'zod';
import { CyclesQuery, EpisodesQuery, TxsQuery } from '../contract/types';
import { OUTCOME } from '../contract/enums';
import { ctx, cycleItem, episodeItem, flowsBody, txV1 } from '../contract/serialize';
import { cursorWhere, page, pageWindow, parseQuery, rows, sendJson, vaultOr404 } from './util';

// per-vault history: cycles (stored transitions + heartbeats, or the raw ring
// with raw=1), standing episodes, receipts, deposit / withdraw flows. every
// list pages on the opaque `c:<rowid>` cursor and rows are immutable.

const FlowsQuery = z.object({ since: z.string().optional(), limit: z.coerce.number().int().min(1).max(2000).default(200) });

export function historyRoutes(): Router {
  const r = Router();

  r.get('/vaults/:id/cycles', (req, res) => {
    const c = ctx();
    const row = vaultOr404(req, res, c);
    if (!row) return;
    const q = parseQuery(req, res, CyclesQuery);
    if (!q) return;
    const codes = (q.outcome ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => (OUTCOME as readonly string[]).includes(s));
    if (q.outcome && codes.length === 0) {
      return void parseQuery(req, res, z.object({ outcome: z.enum(OUTCOME) }));
    }
    const w = pageWindow(q);
    const cur = cursorWhere(w);
    const table = q.raw === 1 ? 'cycles_raw' : 'cycles';
    const where = [cur.clause, 'vault_id = :v'];
    if (w.sinceTs !== null) where.push('block_ts >= :sinceTs');
    if (codes.length) where.push(`outcome_code IN (${codes.map((x) => `'${x}'`).join(',')})`);
    const found = rows(c, `SELECT * FROM ${table} WHERE ${where.join(' AND ')} ORDER BY id ${w.order === 'asc' ? 'ASC' : 'DESC'} LIMIT :lim`, {
      v: row.id,
      sinceId: cur.param,
      sinceTs: w.sinceTs,
      lim: w.limit + 1,
    });
    const items = found.map(cycleItem).filter((x): x is NonNullable<typeof x> => x !== null);
    sendJson(req, res, c, page(c, items, (x) => x.id, w.limit), {
      lastRowTs: items.length ? items[items.length - 1].record.blockTs : null,
    });
  });

  r.get('/vaults/:id/episodes', (req, res) => {
    const c = ctx();
    const row = vaultOr404(req, res, c);
    if (!row) return;
    const q = parseQuery(req, res, EpisodesQuery);
    if (!q) return;
    const w = pageWindow(q);
    const cur = cursorWhere(w);
    const where = [cur.clause, 'vault_id = :v'];
    if (q.active === 1) where.push('until_ts IS NULL');
    if (q.code) where.push('code = :code');
    if (w.sinceTs !== null) where.push('since_ts >= :sinceTs');
    const found = rows(c, `SELECT * FROM episodes WHERE ${where.join(' AND ')} ORDER BY id ${w.order === 'asc' ? 'ASC' : 'DESC'} LIMIT :lim`, {
      v: row.id,
      sinceId: cur.param,
      sinceTs: w.sinceTs,
      code: q.code ?? null,
      lim: w.limit + 1,
    });
    const items = found.map((x) => episodeItem(x, c.nowTs));
    sendJson(req, res, c, page(c, items, (x) => x.id, w.limit), { lastRowTs: items.length ? (items[items.length - 1].untilTs ?? c.nowTs) : null });
  });

  r.get('/vaults/:id/txs', (req, res) => {
    const c = ctx();
    const row = vaultOr404(req, res, c);
    if (!row) return;
    const q = parseQuery(req, res, TxsQuery);
    if (!q) return;
    const w = pageWindow(q);
    const where = ['vault_id = :v'];
    if (q.kind) where.push('kind = :kind');
    if (w.sinceTs !== null) where.push('ts >= :sinceTs');
    if (w.sinceId !== null) where.push(`rowid ${w.order === 'asc' ? '>' : '<'} :sinceId`);
    const found = rows(c, `SELECT rowid AS rowid_, * FROM txs WHERE ${where.join(' AND ')} ORDER BY rowid ${w.order === 'asc' ? 'ASC' : 'DESC'} LIMIT :lim`, {
      v: row.id,
      kind: q.kind ?? null,
      sinceId: w.sinceId,
      sinceTs: w.sinceTs,
      lim: w.limit + 1,
    });
    const items = found.map((x) => ({ ...txV1(x), rowid: Number(x.rowid_) }));
    const body = page(c, items, (x) => x.rowid, w.limit);
    sendJson(
      req,
      res,
      c,
      { ...body, items: body.items.map(({ rowid: _rowid, ...tx }) => tx) },
      { lastRowTs: body.items.length ? body.items[body.items.length - 1].ts : null },
    );
  });

  r.get('/vaults/:id/flows', (req, res) => {
    const c = ctx();
    const row = vaultOr404(req, res, c);
    if (!row) return;
    const q = parseQuery(req, res, FlowsQuery);
    if (!q) return;
    const w = pageWindow({ since: q.since, limit: q.limit, order: 'desc' });
    sendJson(req, res, c, flowsBody(c, row, { sinceTs: w.sinceTs ?? 0, limit: q.limit }));
  });

  return r;
}
