// the one status payload (/api/v1/status), seeded by the layout's ssr load and kept fresh by
// services/api.js. pages read the derived stores; nothing here talks to the network.
import { derived, get, writable } from 'svelte/store';
import { slugOf, summarize } from '../utils/text';

export const status = writable(null);

// what the status bar draws; `ssr` false = the first paint had no data (load threw)
export const meta = writable({ lastRefreshTime: null, loading: false, sourceError: '', ssr: true, live: false });

// measured terminal width in cells; 78 until the browser measures it
export const cols = writable(78);

export const vaults = derived(status, (s) => s?.vaults ?? []);
export const summary = derived(vaults, (v) => summarize(v));
export const dry = derived(status, (s) => s?.keeper?.mode === 'DRY_RUN');
export const vaultRefs = derived(vaults, (v) => v.map((x) => ({ id: slugOf(x.label), label: x.label, address: x.id })));

export function seed(data) {
  if (!data) return;
  if (get(status) == null && data.status) {
    status.set(data.status);
    meta.update((m) => ({ ...m, lastRefreshTime: data.status.generatedAt ?? null }));
  }
  meta.update((m) => ({ ...m, ssr: data.ssr !== false }));
}

export function apply(next, { at = Date.now() } = {}) {
  if (next) status.set(next);
  meta.update((m) => ({ ...m, lastRefreshTime: at, loading: false, sourceError: '' }));
}

export function failed(message) {
  meta.update((m) => ({ ...m, loading: false, sourceError: message }));
}

export function loading(on = true) {
  meta.update((m) => ({ ...m, loading: on }));
}

// /v/<id> accepts the lowercase address or the label slug
export function findVault(list, id) {
  if (!id) return null;
  const key = String(id).toLowerCase();
  return (list ?? []).find((v) => v.id === key || slugOf(v.label) === key) ?? null;
}

export function positionOf(list, vault) {
  const i = (list ?? []).findIndex((v) => v.id === vault?.id);
  return { index: i, total: list?.length ?? 0 };
}
