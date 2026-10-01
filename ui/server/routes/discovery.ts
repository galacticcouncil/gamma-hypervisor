import { Router } from 'express';
import { ctx, discovery } from '../contract/serialize';
import { sendJson } from './util';

// GET /api/v1 — what an agent reads first: every endpoint, the schema, the
// stream, the unit conventions and every closed vocabulary.

export function discoveryRoutes(): Router {
  const r = Router();
  r.get('/', (req, res) => {
    const c = ctx();
    sendJson(req, res, c, discovery(c));
  });
  return r;
}
