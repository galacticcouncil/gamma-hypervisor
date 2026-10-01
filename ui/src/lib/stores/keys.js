// f-keys and views. the url is the state (/v/<id>?view=gates&window=30d); this store only
// carries what the bars need to draw and to build the next href. no key writes anything.
import { writable } from 'svelte/store';

// F2..F7 in bar order; `short` is the status-bar label, `hot` the Alt+letter menu key
export const VIEWS = [
  { id: 'fleet', label: 'Fleet', short: 'Fleet', hot: 'F', key: 'F2' },
  { id: 'vault', label: 'Vault', short: 'Vault', hot: 'V', key: 'F3' },
  { id: 'gates', label: 'Gates', short: 'Gates', hot: 'G', key: 'F4' },
  { id: 'history', label: 'History', short: 'Hist', hot: 'H', key: 'F5' },
  { id: 'econ', label: 'Econ', short: 'Econ', hot: 'E', key: 'F6' },
  { id: 'config', label: 'Config', short: 'Cfg', hot: 'C', key: 'F7' },
];

// F8 cycles these; the default stays out of the url
export const WINDOWS = ['24h', '7d', '30d', 'launch'];
export const DEFAULT_WINDOW = '7d';

export const showHelp = writable(false);

// set by the pages from the url and the status payload: the vault the drill is on, the view,
// the econ window, and the vault list (descriptor order) for the Vault menu and Tab
export const nav = writable({ vault: null, view: 'fleet', window: DEFAULT_WINDOW, vaults: [] });

export function nextWindow(current) {
  const i = WINDOWS.indexOf(current);
  return WINDOWS[(i + 1) % WINDOWS.length];
}

// what the url says; pages feed this into `nav` on every navigation
export function stateFromUrl(url) {
  const m = url.pathname.match(/^\/v\/([^/]+)/);
  const view = m ? url.searchParams.get('view') || 'vault' : 'fleet';
  const window = url.searchParams.get('window');
  return {
    vault: m ? decodeURIComponent(m[1]) : null,
    view: VIEWS.some((v) => v.id === view) ? view : m ? 'vault' : 'fleet',
    window: WINDOWS.includes(window) ? window : DEFAULT_WINDOW,
  };
}

// the href for a view given the current nav state; null when a drill has no vault to open
export function hrefFor(view, state, extra = {}) {
  if (view === 'fleet') return '/';
  const vault = extra.vault ?? state.vault ?? state.vaults?.[0]?.id ?? null;
  if (!vault) return null;
  const q = new URLSearchParams();
  if (view !== 'vault') q.set('view', view);
  const window = extra.window ?? state.window;
  if (window && window !== DEFAULT_WINDOW) q.set('window', window);
  for (const [k, v] of Object.entries(extra)) {
    if (k !== 'vault' && k !== 'window' && v != null) q.set(k, String(v));
  }
  const qs = q.toString();
  return `/v/${encodeURIComponent(vault)}${qs ? `?${qs}` : ''}`;
}

// Tab / Shift+Tab inside a drill: the next vault in descriptor order, wrapping
export function siblingVault(state, step = 1) {
  const ids = (state.vaults ?? []).map((v) => v.id);
  if (!ids.length) return null;
  const at = Math.max(0, ids.indexOf(state.vault));
  return ids[(at + step + ids.length) % ids.length];
}
