import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { getConfig, type UiConfig } from './config';
import { closeDb, getDb, type Db } from './db/index';
import { apiRouter } from './routes/index';
import { healthRoutes } from './routes/health';
import { metricsRoutes } from './routes/metrics';
import { closeStreams } from './routes/stream';
import { fail, getOnly, redactionValues } from './routes/util';
import { redactJson } from './contract/redact';
import { ctx, setSources, statusBody } from './contract/serialize';
import { openapiBody, schemaBody } from './contract/schema';
import { KeeperCollector } from './collect/keeper';
import { MonitorCollector } from './collect/monitor';
import { loadDescriptor, upsertVaults } from './collect/descriptor';
import { start as startChain, provider as chainProvider } from './collect/chain';
import { start as startEvents } from './collect/events';
import { live, resetCollectors } from './collect/types';
import { log, tick } from './collect/util';
import { startRetention } from './db/retention';
import { startRollup } from './db/rollup';
import { scheduleBackup } from './db/backup';

// express: trust proxy → request id → compression (never text/event-stream) →
// rate limit (sse exempt) → /api/v1 → /healthz → /metrics → static → the
// sveltekit handler, imported last and only if the page was built. the ssr
// registry is published on globalThis before that import so +layout.server.js
// never imports server/ (a second bundle = a second sqlite handle) and never
// fetches its own api.

const here = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = resolve(here, '../build');

export interface SsrRegistry {
  statusJson: () => unknown;
}

declare global {
  // eslint-disable-next-line no-var
  var __gammaUi: SsrRegistry | undefined;
}

// the page inlines whatever this returns into the html, so it goes through the
// same redaction pass as every route body (sendJson) — the ssr path has no other
export function publishSsrRegistry(): SsrRegistry {
  const reg: SsrRegistry = {
    statusJson: () => {
      const c = ctx();
      return redactJson(statusBody(c), redactionValues(c));
    },
  };
  globalThis.__gammaUi = reg;
  return reg;
}

// a client id is echoed back, so it is bounded and shaped; anything else is ours
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function requestId(): RequestHandler {
  return (req, res, next) => {
    const raw = req.get('x-request-id');
    res.setHeader('X-Request-Id', raw && REQUEST_ID_RE.test(raw) ? raw : randomUUID());
    next();
  };
}

// cheap and unconditional: the api serves text/plain screens and reflects client
// input, so nosniff is the one that matters. a csp waits on the inline theme
// bootstrap in app.html
function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  };
}

// sse must never be buffered or gzipped, and the request limiter would kill a
// long-lived stream's reconnects; the stream caps concurrency itself (32 global,
// 2 per ip) and its connects are capped below
const isStream = (req: Request): boolean => req.path.startsWith('/api/v1/stream');

// one connect can replay REPLAY_MAX rows, so the rate of connects is capped even
// though the request limiter skips the path
const STREAM_CONNECTS_PER_MIN = 10;

function streamLimiter(): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: STREAM_CONNECTS_PER_MIN,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      res.setHeader('Retry-After', '60');
      fail(req, res, 429, 'rate-limited', 'too many stream connects');
    },
  });
}

function limiter(cfg: UiConfig): RequestHandler {
  return rateLimit({
    windowMs: cfg.rateLimit.windowMs,
    limit: cfg.rateLimit.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => isStream(req),
    handler: (req, res) => {
      res.setHeader('Retry-After', String(Math.ceil(cfg.rateLimit.windowMs / 1000)));
      fail(req, res, 429, 'rate-limited', 'too many requests');
    },
  });
}

export interface AppOpts {
  cfg?: UiConfig;
  // mount express.static + the sveltekit handler (off in tests)
  page?: boolean;
}

export function createApp(o: AppOpts = {}): Express {
  const cfg = o.cfg ?? getConfig();
  const app = express();
  app.set('trust proxy', 1);
  app.set('etag', 'weak');
  app.set('x-powered-by', false);
  app.use(requestId());
  app.use(securityHeaders());
  app.use(
    compression({
      filter: (req, res) => {
        const type = String(res.getHeader('Content-Type') ?? '');
        if (type.includes('text/event-stream')) return false;
        return compression.filter(req, res);
      },
    }),
  );
  app.use('/api/v1/stream', streamLimiter());
  app.use(limiter(cfg));
  app.use('/api/v1', apiRouter());
  app.use(getOnly);
  app.use(healthRoutes());
  app.use(metricsRoutes());
  return app;
}

// the page: static assets then the adapter-node handler, both optional
export async function mountPage(app: Express): Promise<boolean> {
  const client = resolve(BUILD_DIR, 'client');
  if (existsSync(client)) app.use(express.static(client, { maxAge: '1h', index: false }));
  const handlerPath = resolve(BUILD_DIR, 'handler.js');
  if (!existsSync(handlerPath)) {
    log('ui', 'ui build missing — api only');
    return false;
  }
  publishSsrRegistry();
  try {
    const mod = (await import(handlerPath)) as { handler?: RequestHandler };
    if (typeof mod.handler !== 'function') {
      log('ui', 'ui build missing — api only');
      return false;
    }
    app.use(mod.handler);
    return true;
  } catch (e) {
    log('ui', `ui build not loadable (${(e as Error)?.message ?? 'error'}) — api only`);
    return false;
  }
}

// --- collectors and jobs ------------------------------------------------------

export interface Running {
  server: Server;
  close: () => Promise<void>;
}

function startCollectors(db: Db, cfg: UiConfig): () => Promise<void> {
  const keeper = new KeeperCollector({
    db,
    baseUrl: cfg.KEEPER_URL ?? null,
    pollMs: cfg.KEEPER_POLL_MS,
    onStateLost: (i) => log('collect/keeper', `keeper restarted (boot ${i.bootAt}) — dwell, regime and trail reset`),
  });
  const monitor = new MonitorCollector({ db, baseUrl: cfg.MONITOR_URL ?? null, pollMs: cfg.MONITOR_POLL_MS });
  const publish = (): void => setSources({ keeper: keeper.state(), monitor: monitor.state(), chain: live.chain });

  keeper.start();
  monitor.start();
  publish();
  const republish = setInterval(publish, 1000);
  republish.unref?.();

  // the chain sampler and the events indexer own their own provider and write
  // into `live`; constructed first so the descriptor can borrow the provider,
  // started after its first pass
  const chain = startChain({ db, cfg, live });
  const events = startEvents({ db, cfg, live });

  // the descriptor is re-read on a slow tick so a config bump lands without a
  // restart. the identity read needs a provider: without one every vault row
  // keeps null pool/tokens/decimals and the sampler skips it forever
  const descriptor = async (): Promise<void> => {
    try {
      const desc = loadDescriptor(cfg.VAULTS_FILE);
      await upsertVaults(db, desc, chainProvider());
      tick('descriptor', true);
    } catch (e) {
      tick('descriptor', false);
      log('collect/descriptor', `not loaded: ${(e as Error)?.message ?? 'error'}`);
    }
  };
  void descriptor().finally(() => {
    void Promise.resolve(chain.start());
    void Promise.resolve(events.start());
  });
  const descTimer = setInterval(() => void descriptor(), 300_000);
  descTimer.unref?.();

  const stopRetention = startRetention(db, { rawRetentionHours: cfg.RAW_RETENTION_HOURS, sampleRetentionDays: cfg.SAMPLE_RETENTION_DAYS });
  const stopRollup = startRollup(db);
  const stopBackup = scheduleBackup(db, cfg.BACKUP_DIR);

  return async () => {
    clearInterval(republish);
    clearInterval(descTimer);
    stopRetention();
    stopRollup();
    stopBackup();
    await Promise.resolve(events.stop());
    await Promise.resolve(chain.stop());
    monitor.stop();
    await keeper.stop();
    resetCollectors();
  };
}

export async function start(): Promise<Running> {
  const cfg = getConfig();
  const db = getDb();
  // both documents are built once here, not on the first request
  schemaBody(cfg.PUBLIC_URL ?? null);
  openapiBody({ publicUrl: cfg.PUBLIC_URL ?? null, commit: cfg.COMMIT ?? null });
  const app = createApp({ cfg });
  const stopCollectors = startCollectors(db, cfg);
  await mountPage(app);

  const server = app.listen(cfg.PORT, () => log('ui', `listening on :${cfg.PORT}${cfg.keeperConfigured ? '' : ' (keeper not configured)'}`));
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    closeStreams();
    await new Promise<void>((done) => server.close(() => done()));
    await stopCollectors();
    setSources(null);
    closeDb();
  };
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      log('ui', `${sig}: closing`);
      void close().then(() => process.exit(0));
    });
  }
  return { server, close };
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`;
if (isMain) {
  start().catch((e: unknown) => {
    console.error(`[ui] fatal: ${(e as Error)?.message ?? e}`);
    process.exit(1);
  });
}
