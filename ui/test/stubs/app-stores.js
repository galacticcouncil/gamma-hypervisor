// $app/stores for vitest: a writable page store the spec points at a url before rendering
import { writable } from 'svelte/store';

function pageFor(href, params = {}) {
  const url = new URL(href, 'http://test.local');
  return { url, params, data: {}, route: { id: null }, status: 200, error: null, form: null, state: {} };
}

export const page = writable(pageFor('/'));
export const navigating = writable(null);
export const updated = { subscribe: writable(false).subscribe, check: async () => false };

export function setPage(href, params = {}) {
  page.set(pageFor(href, params));
}

export function getStores() {
  return { page, navigating, updated };
}
