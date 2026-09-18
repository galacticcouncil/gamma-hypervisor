import { Router } from 'express';
import { conditional } from '../contract/etag';
import { openapiBody, schemaBody } from '../contract/schema';
import { ctx } from '../contract/serialize';

// /api/v1/schema and /api/v1/openapi.json: built once at boot from the same zod
// the serialiser uses, so they cannot drift from a body. static, hence a long
// max-age and a body-hash etag.

export function schemaRoutes(): Router {
  const r = Router();

  r.get('/schema', (req, res) => {
    const c = ctx();
    const doc = schemaBody(c.cfg.PUBLIC_URL ?? null);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (conditional(req, res, doc.etag)) return;
    res.setHeader('Content-Type', 'application/schema+json; charset=utf-8');
    res.send(doc.body);
  });

  r.get('/openapi.json', (req, res) => {
    const c = ctx();
    const doc = openapiBody({ publicUrl: c.cfg.PUBLIC_URL ?? null, commit: c.cfg.COMMIT ?? null });
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (conditional(req, res, doc.etag)) return;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(doc.body);
  });

  return r;
}
