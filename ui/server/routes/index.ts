import { Router } from 'express';
import { discoveryRoutes } from './discovery';
import { statusRoutes } from './status';
import { vaultRoutes } from './vaults';
import { historyRoutes } from './history';
import { sampleRoutes } from './samples';
import { findingRoutes } from './findings';
import { queryRoutes } from './queries';
import { schemaRoutes } from './schema';
import { streamRoutes } from './stream';
import { fail, getOnly } from './util';

// /api/v1: one router per group, GET only, one error envelope. anything the
// groups do not claim is a 404 with the same shape, never express' html.

export function apiRouter(): Router {
  const r = Router();
  r.use(getOnly);
  r.use((_req, res, next) => {
    res.setHeader('X-Api-Version', '1');
    next();
  });
  r.use(discoveryRoutes());
  r.use(statusRoutes());
  r.use(schemaRoutes());
  r.use(streamRoutes());
  r.use(findingRoutes());
  r.use(queryRoutes());
  r.use(vaultRoutes());
  r.use(historyRoutes());
  r.use(sampleRoutes());
  r.use((req, res) => fail(req, res, 404, 'not-found', 'no such endpoint'));
  return r;
}

export { getOnly };
