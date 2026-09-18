import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AddressInfo } from 'node:net';
import {
  ConfigV1,
  DiscoveryV1,
  EconomicsV1,
  Episode,
  FlowsV1,
  GatesV1,
  LogV1,
  MonitorV1,
  Page,
  QueriesV1,
  QueryV1,
  SamplesV1,
  StatusV1,
  TimelineEvent,
  TxV1,
  VaultDetailV1,
  VaultsV1,
  CycleItem,
  Finding,
} from '../server/contract/types';
import { setConfig } from '../server/config';
import { closeDb, setDb, type Db } from '../server/db/index';
import { createApp, publishSsrRegistry } from '../server/index';
import { resetHealthProbe, setSources } from '../server/contract/serialize';
import { resetLearnedSecrets } from '../server/routes/util';
import { resetSchemaCache } from '../server/contract/schema';
import { closeStreams } from '../server/routes/stream';
import {
  chainState,
  keeperState,
  monitorState,
  poisons,
  seedDb,
  testConfig,
  TX_HASH,
  VAULT_ID,
  VAULT_LABEL,
  NOW,
} from './fixtures';

// every route and the sse stream, driven against a fixture db poisoned with the
// sentinel key, a credentialed url and the ui's own internal urls: no body may
// carry any of them, while a real 64-hex tx hash must survive.

const cfg = testConfig();
let db: Db;
let app: Express;

const GETS = [
  '/api/v1',
  '/api/v1/status',
  '/api/v1/status.txt',
  '/api/v1/status?compact=1',
  `/api/v1/status?vault=${VAULT_ID}`,
  '/api/v1/vaults',
  `/api/v1/vaults/${VAULT_ID}`,
  '/api/v1/vaults/adot-hollar',
  `/api/v1/vaults/${VAULT_ID}.txt`,
  `/api/v1/vaults/${VAULT_ID}/gates`,
  `/api/v1/vaults/${VAULT_ID}/cycles`,
  `/api/v1/vaults/${VAULT_ID}/cycles?raw=1&order=desc`,
  `/api/v1/vaults/${VAULT_ID}/cycles?outcome=gate-blocked`,
  `/api/v1/vaults/${VAULT_ID}/episodes`,
  `/api/v1/vaults/${VAULT_ID}/episodes?active=1`,
  `/api/v1/vaults/${VAULT_ID}/txs`,
  `/api/v1/vaults/${VAULT_ID}/txs?kind=compound`,
  `/api/v1/vaults/${VAULT_ID}/flows`,
  `/api/v1/vaults/${VAULT_ID}/samples`,
  `/api/v1/vaults/${VAULT_ID}/samples?step=3600`,
  `/api/v1/vaults/${VAULT_ID}/economics`,
  `/api/v1/vaults/${VAULT_ID}/economics?window=launch`,
  `/api/v1/vaults/${VAULT_ID}/log`,
  `/api/v1/vaults/${VAULT_ID}/events`,
  '/api/v1/findings',
  '/api/v1/findings?active=1',
  '/api/v1/config',
  '/api/v1/monitor',
  '/api/v1/queries',
  '/api/v1/queries/outcome-histogram',
  '/api/v1/queries/gate-block-episodes',
  '/api/v1/schema',
  '/api/v1/openapi.json',
  '/healthz',
];

beforeEach(() => {
  setConfig(cfg);
  db = seedDb();
  setDb(db);
  setSources({ keeper: keeperState(), monitor: monitorState(), chain: chainState() });
  resetLearnedSecrets();
  resetSchemaCache();
  resetHealthProbe();
  app = createApp({ cfg });
});

afterEach(() => {
  closeStreams();
  setSources(null);
  setDb(null);
  db.close();
});

afterAll(() => {
  setConfig(null);
  closeDb();
});

describe('routes', () => {
  it('answers every documented path with 200 and v:1', async () => {
    for (const path of GETS) {
      const res = await request(app).get(path);
      expect([path, res.status]).toEqual([path, 200]);
      if (path.endsWith('.txt')) continue;
      if (path.startsWith('/api/v1/schema') || path.startsWith('/api/v1/openapi')) continue;
      if (path === '/healthz') continue;
      expect([path, res.body.v]).toEqual([path, 1]);
      expect(typeof res.body.generatedAt).toBe('string');
      expect(res.headers['x-api-version']).toBe('1');
    }
  });

  it('parses every body back with the published zod type', async () => {
    const parse = async (path: string, schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }) => {
      const res = await request(app).get(path);
      const out = schema.safeParse(res.body);
      expect([path, out.success ? null : JSON.stringify(out.error).slice(0, 400)]).toEqual([path, null]);
    };
    await parse('/api/v1', DiscoveryV1);
    await parse('/api/v1/status', StatusV1);
    await parse('/api/v1/vaults', VaultsV1);
    await parse(`/api/v1/vaults/${VAULT_ID}`, VaultDetailV1);
    await parse(`/api/v1/vaults/${VAULT_ID}/gates`, GatesV1);
    await parse(`/api/v1/vaults/${VAULT_ID}/cycles`, Page(CycleItem));
    await parse(`/api/v1/vaults/${VAULT_ID}/episodes`, Page(Episode));
    await parse(`/api/v1/vaults/${VAULT_ID}/txs`, Page(TxV1));
    await parse(`/api/v1/vaults/${VAULT_ID}/flows`, FlowsV1);
    await parse(`/api/v1/vaults/${VAULT_ID}/samples`, SamplesV1);
    await parse(`/api/v1/vaults/${VAULT_ID}/economics`, EconomicsV1);
    await parse(`/api/v1/vaults/${VAULT_ID}/log`, LogV1);
    await parse(`/api/v1/vaults/${VAULT_ID}/events`, Page(TimelineEvent));
    await parse('/api/v1/findings', Page(Finding));
    await parse('/api/v1/config', ConfigV1);
    await parse('/api/v1/monitor', MonitorV1);
    await parse('/api/v1/queries', QueriesV1);
    await parse('/api/v1/queries/outcome-histogram', QueryV1);
  });

  it('serves a sample stamped off the step grid and decimates by bucket', async () => {
    // the sampler stamps wall clock, so a real ts is almost never a multiple of step
    const off = NOW - 37;
    db.exec('CREATE TEMP TABLE one AS SELECT * FROM samples ORDER BY ts DESC LIMIT 1');
    db.run('UPDATE one SET ts = :ts', { ts: off });
    db.run('INSERT INTO samples SELECT * FROM one');
    db.exec('DROP TABLE one');

    const res = await request(app).get(`/api/v1/vaults/${VAULT_ID}/samples?step=60`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { ts: number }) => i.ts)).toContain(off);

    const wide = await request(app).get(`/api/v1/vaults/${VAULT_ID}/samples?step=300`);
    expect(wide.body.items.length).toBeGreaterThan(0);
    expect(wide.body.items.length).toBeLessThan(res.body.items.length);
    const buckets = new Set(wide.body.items.map((i: { ts: number }) => Math.floor(i.ts / 300)));
    expect(buckets.size).toBe(wide.body.items.length);
  });

  it('serves the schema as 2020-12 $defs and openapi 3.1 from the same zod', async () => {
    const schema = await request(app).get('/api/v1/schema');
    expect(schema.body.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(Object.keys(schema.body.$defs)).toContain('VaultV1');
    expect(Object.keys(schema.body.$defs)).toContain('CycleRecord');
    expect(JSON.stringify(schema.body)).not.toContain('"items":[');
    const openapi = await request(app).get('/api/v1/openapi.json');
    expect(openapi.body.openapi).toBe('3.1.0');
    expect(openapi.body.servers[0].url).toBe('https://gamma.play.hydration.cloud');
    expect(Object.keys(openapi.body.paths)).toContain('/api/v1/vaults/{id}/gates');
  });
});

describe('redaction', () => {
  it('leaks no sentinel key, credentialed url or internal url in any body', async () => {
    const bad = poisons(cfg);
    for (const path of GETS) {
      const res = await request(app).get(path);
      const body = typeof res.text === 'string' && res.text.length ? res.text : JSON.stringify(res.body);
      for (const needle of bad) {
        expect([path, needle, body.includes(needle)]).toEqual([path, needle, false]);
      }
    }
  });

  it('leaks nothing through the ssr registry either — the html inlines that body', () => {
    const body = JSON.stringify(publishSsrRegistry().statusJson());
    for (const needle of poisons(cfg)) expect([needle, body.includes(needle)]).toEqual([needle, false]);
  });

  it('keeps a real tx hash: redaction is by value, not by shape', async () => {
    const txs = await request(app).get(`/api/v1/vaults/${VAULT_ID}/txs`);
    expect(JSON.stringify(txs.body)).toContain(TX_HASH);
    const log = await request(app).get(`/api/v1/vaults/${VAULT_ID}/log`);
    expect(JSON.stringify(log.body)).toContain(TX_HASH);
    const cycles = await request(app).get(`/api/v1/vaults/${VAULT_ID}/cycles`);
    expect(cycles.body.items.length).toBeGreaterThan(0);
  });

  it('applies the 64-hex shape rule to /config and nowhere else', async () => {
    const config = await request(app).get('/api/v1/config');
    expect(JSON.stringify(config.body)).not.toMatch(/(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/);
    const status = await request(app).get('/api/v1/status');
    expect(JSON.stringify(status.body)).not.toContain('gamma_keeper');
  });

  it('never echoes an upstream url in an error body; hints come from the table', async () => {
    const res = await request(app).get('/api/v1/vaults/0xdead/cycles');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not-found');
    expect(res.body.error.hint).toMatch(/\/api\/v1\/vaults/);
    expect(JSON.stringify(res.body)).not.toContain('gamma_keeper');
  });
});

describe('http contract', () => {
  it('405s every method but GET and HEAD', async () => {
    for (const path of ['/api/v1/status', '/api/v1/vaults', '/healthz', '/metrics']) {
      const res = await request(app).post(path).send({});
      expect([path, res.status]).toEqual([path, 405]);
      expect(res.headers.allow).toBe('GET, HEAD');
      expect(res.body.error.code).toBe('method-not-allowed');
    }
    expect((await request(app).delete('/api/v1/status')).status).toBe(405);
    expect((await request(app).get('/api/v1/nope')).status).toBe(404);
  });

  it('weak-etags every GET and answers 304 on If-None-Match', async () => {
    for (const path of ['/api/v1/status', `/api/v1/vaults/${VAULT_ID}`, '/api/v1/config', '/api/v1/schema', `/api/v1/vaults/${VAULT_ID}/cycles`]) {
      const first = await request(app).get(path);
      const etag = first.headers.etag;
      expect([path, typeof etag]).toEqual([path, 'string']);
      expect(etag.startsWith('W/"')).toBe(true);
      const second = await request(app).get(path).set('If-None-Match', etag);
      expect([path, second.status]).toEqual([path, 304]);
    }
  });

  it('pages cycles on a monotonic opaque cursor', async () => {
    const first = await request(app).get(`/api/v1/vaults/${VAULT_ID}/cycles?limit=2`);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.complete).toBe(false);
    expect(first.body.next).toMatch(/^c:\d+$/);
    const ids = first.body.items.map((i: { id: number }) => i.id);
    expect(ids[1]).toBeGreaterThan(ids[0]);
    const second = await request(app).get(`/api/v1/vaults/${VAULT_ID}/cycles?limit=2&since=${first.body.next}`);
    for (const item of second.body.items) expect(item.id).toBeGreaterThan(ids[1]);
    const tail = await request(app).get(`/api/v1/vaults/${VAULT_ID}/cycles?limit=200`);
    expect(tail.body.complete).toBe(true);
    expect(tail.body.next).toBeNull();
  });

  it('rejects a bad query with the error envelope, not a stack', async () => {
    const res = await request(app).get(`/api/v1/vaults/${VAULT_ID}/cycles?limit=99999`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-request');
    expect(res.body.error.message).toMatch(/limit/);
    expect(res.body.error.hint).toBeTruthy();
    // an unknown window is a 400, never a silently relabelled 7d body
    const win = await request(app).get(`/api/v1/vaults/${VAULT_ID}/economics?window=90d`);
    expect(win.status).toBe(400);
    expect(win.body.error.code).toBe('bad-request');
    const range = await request(app).get(`/api/v1/vaults/${VAULT_ID}/economics?window=${NOW - 86400}..${NOW}`);
    expect(range.status).toBe(200);
  });

  it('renders .txt and Accept: text/plain at exactly 78 columns', async () => {
    for (const [path, headers] of [
      ['/api/v1/status.txt', {}],
      [`/api/v1/vaults/${VAULT_ID}.txt`, {}],
      ['/api/v1/vaults/adot-hollar.txt', {}],
      ['/api/v1/status', { Accept: 'text/plain' }],
      [`/api/v1/vaults/${VAULT_ID}`, { Accept: 'text/plain' }],
    ] as Array<[string, Record<string, string>]>) {
      const res = await request(app).get(path).set(headers);
      expect([path, res.status]).toEqual([path, 200]);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      const lines = res.text.split('\n').filter((l) => l.length > 0);
      for (const l of lines) expect([path, l, [...l].length]).toEqual([path, l, 78]);
      expect(lines.length).toBeGreaterThan(8);
    }
  });

  it('answers /metrics only for overlay ips or the token', async () => {
    const denied = await request(app).get('/metrics').set('X-Forwarded-For', '203.0.113.9');
    expect(denied.status).toBe(404);
    const allowed = await request(app).get('/metrics').set('X-Metrics-Token', cfg.METRICS_TOKEN as string);
    expect(allowed.status).toBe(200);
    expect(allowed.text).toMatch(/gamma_vault_liveness_rank/);
    for (const needle of poisons(cfg)) expect(allowed.text.includes(needle)).toBe(false);
  });

  it('rate limits per ip with Retry-After and exempts the stream', async () => {
    const tight = testConfig({ RATE_LIMIT: '2/10s' });
    const app2 = createApp({ cfg: tight });
    expect((await request(app2).get('/api/v1/vaults')).status).toBe(200);
    expect((await request(app2).get('/api/v1/vaults')).status).toBe(200);
    const limited = await request(app2).get('/api/v1/vaults');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('10');
    expect(limited.body.error.code).toBe('rate-limited');
    // the stream is exempt from the request limiter (it caps itself)
    const server = app2.listen(0);
    const port = (server.address() as AddressInfo).port;
    const ac = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/stream`, { headers: { accept: 'text/event-stream' }, signal: ac.signal });
      expect(res.status).toBe(200);
    } finally {
      ac.abort();
      closeStreams();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it('sets the cheap security headers and never echoes a hostile request id', async () => {
    const res = await request(app).get('/api/v1/vaults').set('X-Request-Id', '<img src=x onerror=alert(1)>');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-request-id']).not.toContain('<img');
    expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    const mine = await request(app).get('/api/v1/vaults').set('X-Request-Id', 'abc-123');
    expect(mine.headers['x-request-id']).toBe('abc-123');
  });

  it('reports /healthz without leaking a path', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.db).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(cfg.DB_PATH);
  });
});

describe('status body', () => {
  it('carries sources, the verdict sentence and the standing the fixture is in', async () => {
    const res = await request(app).get('/api/v1/status');
    const body = res.body as typeof StatusV1._output;
    expect(body.sources.keeper.reachable).toBe(true);
    expect(body.sources.chain.rpcHost).toBe('rpc.hydradx.cloud');
    expect(body.keeper.mode).toBe('LIVE');
    const v = body.vaults[0];
    expect(v.label).toBe(VAULT_LABEL);
    expect(v.keeper.standing?.code).toBe('gate-blocked');
    expect(v.keeper.standing?.subcode).toBe('oracle-dev');
    expect(v.verdict.level).toBe('held');
    expect(v.verdict.legit).toBe(true);
    expect(v.verdict.sentence).toMatch(/oracle clamp/);
    expect(v.liveness).toBe('blocked-legit');
    expect(v.chain?.asOf.block).toBeGreaterThan(0);
    expect(v.chain?.ageSecs).toBeLessThan(300);
    expect(v.chain?.price.quote).toBe('HOLLAR per aDOT');
    expect(v.chain?.nav.note).toMatch(/excludes fees/);
    expect(v.chain?.fee.divisor).toBe(255);
  });

  it('builds the gates drill with keeper-saw and the holding episode', async () => {
    const res = await request(app).get(`/api/v1/vaults/${VAULT_ID}/gates`);
    const rows = res.body.rows as Array<{ gate: string; reading: unknown; limit: unknown; keeperSaw: unknown; verdict: string }>;
    const names = rows.map((r) => r.gate);
    expect(names).toContain('twap vs oracle');
    expect(names).toContain('spot vs oracle');
    expect(names).toContain('oracle age');
    const clamp = rows.find((r) => r.gate === 'twap vs oracle');
    expect(clamp?.reading).toBe('111 tk');
    expect(clamp?.limit).toBe('<= 50');
    expect(clamp?.verdict).toBe('FAIL');
    expect(clamp?.keeperSaw).toBe('=');
    expect(res.body.holding.code).toBe('gate-blocked');
    expect(res.body.holding.subcode).toBe('oracle-dev');
  });

  it('takes the gas warn level from the monitor global block, not a per-pool threshold', async () => {
    const res = await request(app).get('/api/v1/status');
    // the monitor watches one signer, so GAS_WARN_WEI is never in pools[].thresholds
    expect(res.body.keeper.gas.warnWei).toBe('2000000000000000');
    expect(res.body.keeper.gas.floorWei).toBe('1000000000000000');
    const mon = await request(app).get('/api/v1/monitor');
    expect(mon.body.status.gas.warnWei).toBe('2000000000000000');
    setSources({ monitor: monitorState({ status: null, statusAt: null, reachable: false }) });
    const off = await request(app).get('/api/v1/status');
    expect(off.body.keeper.gas.warnWei).toBeNull();
  });

  it('keeps serving the keeper column as unreachable rather than failing', async () => {
    setSources({ keeper: keeperState({ reachable: false, consecutiveFailures: 4, unreachableSince: NOW - 400, status: null, statusAt: null }) });
    const res = await request(app).get('/api/v1/status');
    expect(res.status).toBe(200);
    expect(res.body.sources.keeper.reachable).toBe(false);
    expect(res.body.vaults[0].liveness).toBe('unreachable');
    expect(res.body.vaults[0].verdict.code).toBe('keeper-unreachable');
    expect(res.body.vaults[0].chain).not.toBeNull();
  });
});

describe('sse stream', () => {
  it('replays events_log rows by rowid and frames json only', async () => {
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/stream`, {
        headers: { accept: 'text/event-stream', 'last-event-id': '0' },
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !buf.includes('event: tx')) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
      }
      ac.abort();
      await reader.cancel().catch(() => undefined);
      expect(buf).toContain('retry: 5000');
      const ids = [...buf.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
      expect(ids.length).toBeGreaterThan(2);
      expect([...ids].sort((a, b) => a - b)).toEqual(ids);
      for (const m of buf.matchAll(/^data: (.*)$/gm)) expect(() => JSON.parse(m[1])).not.toThrow();
      for (const needle of poisons(cfg)) expect(buf.includes(needle)).toBe(false);
    } finally {
      closeStreams();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it('caps streams per ip with 429 and Retry-After', async () => {
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const acs: AbortController[] = [];
    try {
      for (let i = 0; i < cfg.SSE_PER_IP; i++) {
        const ac = new AbortController();
        acs.push(ac);
        const r = await fetch(`http://127.0.0.1:${port}/api/v1/stream`, { headers: { accept: 'text/event-stream' }, signal: ac.signal });
        expect(r.status).toBe(200);
      }
      const denied = await fetch(`http://127.0.0.1:${port}/api/v1/stream`, { headers: { accept: 'text/event-stream' } });
      expect(denied.status).toBe(429);
      expect(denied.headers.get('retry-after')).toBeTruthy();
      const body = (await denied.json()) as { error: { code: string } };
      expect(body.error.code).toBe('stream-limit');
    } finally {
      for (const ac of acs) ac.abort();
      closeStreams();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
