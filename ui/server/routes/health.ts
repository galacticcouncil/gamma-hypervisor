import { Router } from 'express';
import { ctx, healthBody } from '../contract/serialize';

// /healthz — 200 when sqlite is writable and a collector ticked in the last
// 5 min, 503 otherwise. no url, path or hostname in the body.

export function healthRoutes(): Router {
  const r = Router();
  r.get('/healthz', (req, res) => {
    let body: { ok: boolean; db: boolean; collectors: Record<string, { lastTickAt: string | null; ok: boolean }> };
    try {
      body = healthBody(ctx());
    } catch {
      body = { ok: false, db: false, collectors: {} };
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(body.ok ? 200 : 503).json(body);
  });
  return r;
}
