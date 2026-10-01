// /api/v1 client: etag'd json fetches and a Last-Event-ID sse reader with reconnect. error
// messages are from a fixed table; nothing from a response body is ever surfaced as text.
import { browser } from '$app/environment';

const etags = new Map();
const bodies = new Map();

const MESSAGES = {
  network: 'api unreachable',
  404: 'not found',
  429: 'rate limited',
  500: 'api error',
};

export class ApiError extends Error {
  constructor(status, code) {
    super(MESSAGES[status] ?? MESSAGES.network);
    this.status = status;
    this.code = code ?? null;
  }
}

// GET with If-None-Match; a 304 hands back the cached body and `changed: false`
export async function getJson(path, { signal } = {}) {
  const headers = { accept: 'application/json' };
  const etag = etags.get(path);
  if (etag) headers['if-none-match'] = etag;
  let res;
  try {
    res = await fetch(path, { headers, signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(0);
  }
  if (res.status === 304 && bodies.has(path)) return { data: bodies.get(path), changed: false, status: 304 };
  if (!res.ok) {
    let code = null;
    try {
      code = (await res.json())?.error?.code ?? null;
    } catch {
      // not json; the fixed message stands
    }
    throw new ApiError(res.status, code);
  }
  const data = await res.json();
  const tag = res.headers.get('etag');
  if (tag) etags.set(path, tag);
  bodies.set(path, data);
  return { data, changed: true, status: 200 };
}

export function cached(path) {
  return bodies.get(path) ?? null;
}

export const api = {
  status: () => getJson('/api/v1/status'),
  vault: (id) => getJson(`/api/v1/vaults/${encodeURIComponent(id)}`),
  gates: (id) => getJson(`/api/v1/vaults/${encodeURIComponent(id)}/gates`),
  cycles: (id, q = {}) => getJson(`/api/v1/vaults/${encodeURIComponent(id)}/cycles${query(q)}`),
  txs: (id, q = {}) => getJson(`/api/v1/vaults/${encodeURIComponent(id)}/txs${query(q)}`),
  economics: (id, window) => getJson(`/api/v1/vaults/${encodeURIComponent(id)}/economics${query({ window })}`),
  samples: (id, q = {}) => getJson(`/api/v1/vaults/${encodeURIComponent(id)}/samples${query(q)}`),
  log: (id, n = 300) => getJson(`/api/v1/vaults/${encodeURIComponent(id)}/log${query({ n })}`),
  config: () => getJson('/api/v1/config'),
};

export function query(q) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q ?? {})) if (v != null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

// poll a path every `ms`; the first tick runs at once. returns stop()
export function poll(path, ms, onData, onError) {
  if (!browser) return () => {};
  let timer = null;
  let stopped = false;
  let controller = null;
  const tick = async () => {
    if (stopped) return;
    controller = new AbortController();
    try {
      const r = await getJson(path, { signal: controller.signal });
      if (!stopped) onData(r.data, r.changed);
    } catch (e) {
      if (!stopped && e?.name !== 'AbortError') onError?.(e);
    }
    if (!stopped) timer = setTimeout(tick, ms);
  };
  tick();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    },
    now() {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      controller?.abort();
      tick();
    },
  };
}

// sse over fetch so Last-Event-ID travels on our own reconnects too. frames are json; `retry:`
// sets the reconnect delay (server says 5000); backoff doubles to 60s while the api is down
export function stream({ path = '/api/v1/stream', vault, events, lastEventId = null, onEvent, onOpen, onError } = {}) {
  if (!browser || typeof ReadableStream === 'undefined') return { close() {}, get lastEventId() { return lastEventId; } };
  let closed = false;
  let controller = null;
  let retryMs = 5000;
  let backoff = retryMs;
  const url = `${path}${query({ vault, events })}`;

  const connect = async () => {
    if (closed) return;
    controller = new AbortController();
    const headers = { accept: 'text/event-stream' };
    if (lastEventId) headers['last-event-id'] = lastEventId;
    try {
      const res = await fetch(url, { headers, signal: controller.signal, cache: 'no-store' });
      if (!res.ok || !res.body) throw new ApiError(res.status);
      onOpen?.();
      backoff = retryMs;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let at;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, at);
          buf = buf.slice(at + 2);
          dispatch(frame);
        }
      }
    } catch (e) {
      if (closed || e?.name === 'AbortError') return;
      onError?.(e instanceof ApiError ? e : new ApiError(0));
    }
    if (closed) return;
    setTimeout(connect, backoff);
    backoff = Math.min(60000, backoff * 2);
  };

  const dispatch = (frame) => {
    let event = 'message';
    let id = null;
    const data = [];
    for (const raw of frame.split('\n')) {
      if (!raw || raw.startsWith(':')) continue;
      const colon = raw.indexOf(':');
      const field = colon < 0 ? raw : raw.slice(0, colon);
      const value = colon < 0 ? '' : raw.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
      else if (field === 'retry' && /^\d+$/.test(value)) retryMs = Number(value);
    }
    if (id != null) lastEventId = id;
    if (!data.length) return;
    let parsed = null;
    try {
      parsed = JSON.parse(data.join('\n'));
    } catch {
      return; // payloads are always json; anything else is dropped
    }
    onEvent?.({ event, id, data: parsed });
  };

  connect();
  return {
    close() {
      closed = true;
      controller?.abort();
    },
    get lastEventId() {
      return lastEventId;
    },
  };
}
