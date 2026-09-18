import { Router, type Request, type Response } from 'express';
import type { EventKind, StreamEvent } from '../contract/enums';
import { STREAM_EVENT } from '../contract/enums';
import { ctx, timelineItem, type Ctx } from '../contract/serialize';
import { bus, type CollectEvent } from '../collect/util';
import { eventsWake } from '../collect/types';
import { fail, redactionValues, rows } from './util';
import { redactJson } from '../contract/redact';

// GET /api/v1/stream — sse over events_log. ids are the table's rowids, so
// Last-Event-ID replay is exact and survives a ui restart. payloads are always
// json (a multi-line keeper line travels inside one), `: ping` every 15s,
// `retry: 5000`, 32 clients globally and 2 per ip, idle kick after 10 min.

export const REPLAY_MAX = 1000;
export const PING_MS = 15_000;
export const RETRY_MS = 5000;
export const GLOBAL_MAX = 32;
export const IDLE_KICK_MS = 600_000;
export const BACKLOG_MAX = 1024 * 1024;

const EVENT_STREAM: Record<EventKind, StreamEvent> = {
  cycle: 'cycle',
  regime: 'regime',
  standing: 'standing',
  finding: 'finding',
  tx: 'tx',
  deposit: 'tx',
  withdraw: 'tx',
  'zero-burn': 'tx',
  config: 'status',
  source: 'source',
};

interface Client {
  res: Response;
  vault: string | null;
  events: ReadonlySet<StreamEvent> | null;
  lastId: number;
  lastProgressMs: number;
}

const clients = new Set<Client>();
const perIp = new Map<string, number>();

export function streamClientCount(): number {
  return clients.size;
}

export function closeStreams(): void {
  for (const c of [...clients]) drop(c);
}

function drop(c: Client): void {
  if (!clients.has(c)) return;
  clients.delete(c);
  const ip = ipOf(c.res.req);
  const n = (perIp.get(ip) ?? 1) - 1;
  if (n <= 0) perIp.delete(ip);
  else perIp.set(ip, n);
  try {
    c.res.end();
  } catch {
    // the socket is already gone
  }
}

function ipOf(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function frame(c: Client, id: number, event: StreamEvent, payload: unknown): void {
  const data = JSON.stringify(payload);
  c.res.write(`id: ${id}\nevent: ${event}\ndata: ${data}\n\n`);
  c.lastId = Math.max(c.lastId, id);
  c.lastProgressMs = Date.now();
  if (c.res.writableLength > BACKLOG_MAX) drop(c);
}

function wants(c: Client, vault: string | null, event: StreamEvent): boolean {
  if (c.vault !== null && vault !== null && vault !== c.vault) return false;
  if (c.events !== null && !c.events.has(event)) return false;
  return true;
}

// everything is read back from events_log so the id, the kind and the payload a
// replaying client gets are byte-identical to the live frame
function flush(c: Client, cx: Ctx): void {
  const found = rows(cx, 'SELECT * FROM events_log WHERE id > :since ORDER BY id LIMIT :lim', { since: c.lastId, lim: REPLAY_MAX });
  if (found.length === 0) return;
  const values = redactionValues(cx);
  for (const r of found) {
    const item = timelineItem(r);
    const event = EVENT_STREAM[item.kind] ?? 'status';
    if (!wants(c, item.vault, event)) {
      c.lastId = Math.max(c.lastId, item.id);
      continue;
    }
    frame(c, item.id, event, redactJson({ v: 1, id: item.id, ts: item.ts, vault: item.vault, kind: item.kind, ref: item.ref, payload: item.payload }, values));
    if (!clients.has(c)) return;
  }
}

function parseLastEventId(req: Request, since: string | undefined): number | null {
  const raw = (req.get('last-event-id') ?? since ?? '').trim();
  if (!raw) return null;
  const n = Number(raw.replace(/^c:/, ''));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

let wired = false;
let timer: NodeJS.Timeout | null = null;

export function streamRoutes(): Router {
  const r = Router();

  const pump = (): void => {
    let cx: Ctx;
    try {
      cx = ctx();
    } catch {
      return;
    }
    const now = Date.now();
    for (const c of [...clients]) {
      try {
        flush(c, cx);
        if (now - c.lastProgressMs > IDLE_KICK_MS) {
          drop(c);
          continue;
        }
        c.res.write(': ping\n\n');
      } catch {
        drop(c);
      }
    }
  };

  const onWake = (): void => {
    if (clients.size === 0) return;
    let cx: Ctx;
    try {
      cx = ctx();
    } catch {
      return;
    }
    for (const c of [...clients]) {
      try {
        flush(c, cx);
      } catch {
        drop(c);
      }
    }
  };

  // one subscription per process, whatever how many apps a test builds
  if (!wired) {
    wired = true;
    bus.on('event', (_e: CollectEvent) => onWake());
    eventsWake.on('event', () => onWake());
  }

  r.get('/stream', (req, res) => {
    const cx = ctx();
    const ip = ipOf(req);
    const mine = perIp.get(ip) ?? 0;
    if (clients.size >= GLOBAL_MAX || mine >= cx.cfg.SSE_PER_IP) {
      res.setHeader('Retry-After', '30');
      fail(req, res, 429, 'stream-limit', clients.size >= GLOBAL_MAX ? 'stream capacity reached' : 'too many streams from this address');
      return;
    }

    const vaultQ = typeof req.query.vault === 'string' ? req.query.vault.toLowerCase() : null;
    const eventsQ =
      typeof req.query.events === 'string'
        ? new Set(
            req.query.events
              .split(',')
              .map((s) => s.trim())
              .filter((s): s is StreamEvent => (STREAM_EVENT as readonly string[]).includes(s)),
          )
        : null;

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(`retry: ${RETRY_MS}\n\n`);

    const lastId = parseLastEventId(req, typeof req.query.since === 'string' ? req.query.since : undefined);
    const newest = cx.db.get<{ id: number }>('SELECT MAX(id) AS id FROM events_log');
    const head = Number(newest?.id ?? 0);
    const client: Client = {
      res,
      vault: vaultQ,
      events: eventsQ && eventsQ.size ? eventsQ : null,
      lastId: lastId === null ? head : Math.max(lastId, head - REPLAY_MAX),
      lastProgressMs: Date.now(),
    };
    clients.add(client);
    perIp.set(ip, mine + 1);

    req.on('close', () => drop(client));
    req.on('error', () => drop(client));
    res.on('error', () => drop(client));
    res.socket?.on('error', () => drop(client));

    try {
      flush(client, cx);
    } catch {
      drop(client);
    }

    if (!timer) {
      timer = setInterval(pump, PING_MS);
      timer.unref?.();
    }
  });

  return r;
}
