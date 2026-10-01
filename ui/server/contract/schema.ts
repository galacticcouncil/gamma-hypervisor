import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { PUBLIC_SCHEMAS } from './types';
import * as T from './types';
import { PUBLIC_ENUMS } from './enums';
import { weakEtag } from './etag';

// json schema 2020-12 ($defs) and openapi 3.1 from the same zod the serialiser
// builds, so /api/v1/schema cannot drift from a body. both documents are built
// once at boot and etag'd; nothing here reads state.

extendZodWithOpenApi(z);

export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

// zod-to-json-schema targets 2019-09 at the newest; the only 2020-12
// incompatibility it emits is the array form of `items` for tuples
function to2020(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(to2020);
  if (node === null || typeof node !== 'object') return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'items' && Array.isArray(v)) {
      out.prefixItems = v.map(to2020);
      out.items = src.additionalItems === undefined ? false : to2020(src.additionalItems);
      continue;
    }
    if (k === 'additionalItems') continue;
    out[k] = to2020(v);
  }
  return out;
}

export interface SchemaDoc {
  $schema: string;
  $id: string;
  title: string;
  description: string;
  $defs: Record<string, unknown>;
  enums: Record<string, ReadonlyArray<string | number>>;
}

let schemaDoc: SchemaDoc | null = null;

export function jsonSchemaDoc(publicUrl?: string | null): SchemaDoc {
  if (schemaDoc) return schemaDoc;
  const defs: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(PUBLIC_SCHEMAS)) {
    const one = zodToJsonSchema(schema as z.ZodTypeAny, {
      name,
      target: 'jsonSchema2019-09',
      definitionPath: '$defs',
      $refStrategy: 'root',
    }) as Record<string, unknown>;
    const inner = (one.$defs ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(inner)) defs[k] = to2020(v);
  }
  schemaDoc = {
    $schema: JSON_SCHEMA_DIALECT,
    $id: `${(publicUrl ?? '').replace(/\/+$/, '')}/api/v1/schema`,
    title: 'gamma-ui api v1',
    description: 'every public type of /api/v1, generated from the same zod the serialiser builds',
    $defs: defs,
    enums: PUBLIC_ENUMS as unknown as Record<string, ReadonlyArray<string | number>>,
  };
  return schemaDoc;
}

// --- openapi 3.1 --------------------------------------------------------------

const idParam = z.string().openapi({ param: { name: 'id', in: 'path' }, example: '0xa206d0959813f17c17c87147271c49065438648a' });

function register(reg: OpenAPIRegistry): Record<string, ReturnType<OpenAPIRegistry['register']>> {
  const out: Record<string, ReturnType<OpenAPIRegistry['register']>> = {};
  for (const [name, schema] of Object.entries(PUBLIC_SCHEMAS)) out[name] = reg.register(name, schema as z.ZodTypeAny);
  return out;
}

interface PathSpec {
  path: string;
  summary: string;
  response: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  vaultPath?: boolean;
  text?: boolean;
}

function paths(): PathSpec[] {
  const page = (item: z.ZodTypeAny) => T.Page(item);
  return [
    { path: '/api/v1', summary: 'discovery: endpoints, schema, enums, unit conventions', response: T.DiscoveryV1 },
    { path: '/api/v1/status', summary: 'sources, keeper summary, every vault, active findings', response: T.StatusV1, query: T.StatusQuery, text: true },
    { path: '/api/v1/vaults', summary: 'vault references in descriptor order', response: T.VaultsV1 },
    { path: '/api/v1/vaults/{id}', summary: 'one vault: the block, last 20 cycles, last 10 txs', response: T.VaultDetailV1, vaultPath: true, text: true },
    { path: '/api/v1/vaults/{id}/gates', summary: 'every gate as reading vs limit, as-of vs keeper-saw', response: T.GatesV1, vaultPath: true },
    { path: '/api/v1/vaults/{id}/cycles', summary: 'cycle records', response: page(T.CycleItem), query: T.CyclesQuery, vaultPath: true },
    { path: '/api/v1/vaults/{id}/episodes', summary: 'standing runs: how long blocked', response: page(T.Episode), query: T.EpisodesQuery, vaultPath: true },
    { path: '/api/v1/vaults/{id}/txs', summary: 'receipts with cost and compromise flags', response: page(T.TxV1), query: T.TxsQuery, vaultPath: true },
    { path: '/api/v1/vaults/{id}/flows', summary: 'Deposit / Withdraw with a summary', response: T.FlowsV1, vaultPath: true },
    { path: '/api/v1/vaults/{id}/samples', summary: 'chain samples, raw or from the hourly rollup', response: T.SamplesV1, query: T.SamplesQuery, vaultPath: true },
    { path: '/api/v1/vaults/{id}/economics', summary: 'both hodl benchmarks, fees vs il, time in range, cadence', response: T.EconomicsV1, query: T.EconomicsQuery, vaultPath: true },
    { path: '/api/v1/vaults/{id}/log', summary: 'keeper log ring, redacted a second time', response: T.LogV1, vaultPath: true },
    { path: '/api/v1/vaults/{id}/events', summary: 'merged timeline', response: page(T.TimelineEvent), query: T.PageQuery, vaultPath: true },
    { path: '/api/v1/findings', summary: 'monitor and ui findings with onset', response: page(T.Finding), query: T.FindingsQuery },
    { path: '/api/v1/config', summary: 'keeper config (redacted), descriptor, drift, monitor thresholds', response: T.ConfigV1 },
    { path: '/api/v1/monitor', summary: 'monitor /status normalised', response: T.MonitorV1 },
    { path: '/api/v1/queries', summary: 'the named queries and their parameters', response: T.QueriesV1 },
    { path: '/api/v1/queries/{name}', summary: 'run one named query', response: T.QueryV1, query: T.QueryParams },
  ];
}

let openapiDocCache: Record<string, unknown> | null = null;

export function openapiDoc(o: { publicUrl?: string | null; commit?: string | null } = {}): Record<string, unknown> {
  if (openapiDocCache) return openapiDocCache;
  const reg = new OPENAPI_REGISTRY();
  register(reg);
  for (const p of paths()) {
    const parameters: Record<string, unknown> = {};
    if (p.vaultPath) parameters.params = z.object({ id: idParam });
    if (p.query) parameters.query = p.query;
    reg.registerPath({
      method: 'get',
      path: p.path,
      summary: p.summary,
      request: Object.keys(parameters).length ? (parameters as never) : undefined,
      responses: {
        200: {
          description: p.summary,
          content: {
            'application/json': { schema: p.response },
            ...(p.text ? { 'text/plain': { schema: z.string().openapi({ description: '78-column text screen' }) } } : {}),
          },
        },
        304: { description: 'not modified (If-None-Match)' },
        404: { description: 'unknown vault or query', content: { 'application/json': { schema: T.ApiError } } },
        405: { description: 'GET only', content: { 'application/json': { schema: T.ApiError } } },
        429: { description: 'rate limited', content: { 'application/json': { schema: T.ApiError } } },
      },
    });
  }
  reg.registerPath({
    method: 'get',
    path: '/api/v1/stream',
    summary: 'sse: status cycle tx standing regime finding sample source; Last-Event-ID replays <= 1000',
    responses: { 200: { description: 'text/event-stream of json frames' } },
  });
  reg.registerPath({ method: 'get', path: '/healthz', summary: 'sqlite writable and a collector ticked in 5 min', responses: { 200: { description: 'ok' }, 503: { description: 'degraded' } } });

  const doc = new OpenApiGeneratorV31(reg.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'gamma-ui',
      version: '1',
      description: 'read-only api over the gamma keeper fleet. GET only; weak etags; `since=` cursors; null = known-unknown.',
      ...(o.commit ? { 'x-commit': o.commit } : {}),
    },
    servers: o.publicUrl ? [{ url: o.publicUrl.replace(/\/+$/, '') }] : [],
  }) as unknown as Record<string, unknown>;
  doc.jsonSchemaDialect = JSON_SCHEMA_DIALECT;
  openapiDocCache = doc;
  return doc;
}

// the registry class, aliased so the import stays a value in one place
const OPENAPI_REGISTRY = OpenAPIRegistry;

export interface BuiltDoc {
  body: string;
  etag: string;
}

let schemaBuilt: BuiltDoc | null = null;
let openapiBuilt: BuiltDoc | null = null;

export function schemaBody(publicUrl?: string | null): BuiltDoc {
  if (!schemaBuilt) {
    const body = JSON.stringify(jsonSchemaDoc(publicUrl));
    schemaBuilt = { body, etag: weakEtag(body) };
  }
  return schemaBuilt;
}

export function openapiBody(o: { publicUrl?: string | null; commit?: string | null } = {}): BuiltDoc {
  if (!openapiBuilt) {
    const body = JSON.stringify(openapiDoc(o));
    openapiBuilt = { body, etag: weakEtag(body) };
  }
  return openapiBuilt;
}

// tests only: drop the built documents
export function resetSchemaCache(): void {
  schemaDoc = null;
  openapiDocCache = null;
  schemaBuilt = null;
  openapiBuilt = null;
}
