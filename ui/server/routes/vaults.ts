import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { PageQuery } from '../contract/types';
import { renderVault, WIDTH } from '../contract/text';
import { compositeEtag } from '../contract/etag';
import { ctx, gatesBody, listVaults, logBody, statusEtagParts, timelineItem, vaultDetail, vaultRef } from '../contract/serialize';
import { toIso } from '../contract/format';
import { cursorWhere, page, pageWindow, parseQuery, rows, sendJson, sendText, vaultOr404, wantsText } from './util';

// /api/v1/vaults, /vaults/{id}[.txt], /vaults/{id}/gates, /log, /events.
// `{id}` is the lowercase address or the label slug; a trailing `.txt` on the
// vault path renders the drill screen instead of json.

const LogQuery = z.object({ n: z.coerce.number().int().min(1).max(300).default(300) });

// the drill's etag is source-derived like /status: the body carries ages that
// tick every second, and a body hash would never answer 304
const detail: RequestHandler = (req, res) => {
  const c = ctx();
  const row = vaultOr404(req, res, c);
  if (!row) return;
  const all = listVaults(c.db);
  const index = all.findIndex((v) => v.id === row.id) + 1;
  const body = vaultDetail(c, row);
  const text = wantsText(req);
  const etag = compositeEtag([...statusEtagParts(c), row.id, text ? 'txt' : 'json']);
  if (text) {
    sendText(req, res, c, `${renderVault(body, { index, total: all.length, nowMs: c.nowMs })}\n`, { etag, width: WIDTH });
    return;
  }
  sendJson(req, res, c, body, { etag });
};

export function vaultRoutes(): Router {
  const r = Router();

  r.get('/vaults', (req, res) => {
    const c = ctx();
    sendJson(req, res, c, { v: 1, generatedAt: toIso(c.nowMs), items: listVaults(c.db).map(vaultRef) });
  });

  r.get('/vaults/:id', detail);

  r.get('/vaults/:id/gates', (req, res) => {
    const c = ctx();
    const row = vaultOr404(req, res, c);
    if (!row) return;
    sendJson(req, res, c, gatesBody(c, row), { etag: compositeEtag([...statusEtagParts(c), row.id, 'gates']) });
  });

  r.get('/vaults/:id/log', (req, res) => {
    const c = ctx();
    const row = vaultOr404(req, res, c);
    if (!row) return;
    const q = parseQuery(req, res, LogQuery);
    if (!q) return;
    const body = logBody(c, row, q.n);
    if (wantsText(req)) {
      sendText(req, res, c, `${body.lines.map((l) => l.line).join('\n')}\n`);
      return;
    }
    sendJson(req, res, c, body);
  });

  r.get('/vaults/:id/events', (req, res) => {
    const c = ctx();
    const row = vaultOr404(req, res, c);
    if (!row) return;
    const q = parseQuery(req, res, PageQuery);
    if (!q) return;
    const w = pageWindow(q);
    const cur = cursorWhere(w);
    const found = rows(
      c,
      `SELECT * FROM events_log WHERE (vault_id = :v OR vault_id IS NULL) AND ${cur.clause} ${w.sinceTs === null ? '' : 'AND ts >= :sinceTs'}
       ORDER BY id ${w.order === 'asc' ? 'ASC' : 'DESC'} LIMIT :lim`,
      { v: row.id, sinceId: cur.param, sinceTs: w.sinceTs, lim: w.limit + 1 },
    );
    const items = found.map(timelineItem);
    sendJson(req, res, c, page(c, items, (x) => x.id, w.limit), { lastRowTs: items.length ? items[items.length - 1].ts : null });
  });

  return r;
}
