// colour schemes, all period-authentic. 'auto' follows the system:
// dark → ocean (PC Tools, the house default), light → paper. Applied as data-theme on <html> — app.html
// carries a tiny inline script so the first paint already has the right one.
import { writable } from 'svelte/store';
import { browser } from '$app/environment';

export const THEMES = [
  { id: 'auto', name: 'Auto (system)' },
  { id: 'ocean', name: 'PC Tools cyan' },
  { id: 'borland', name: 'Borland blue' },
  { id: 'nc', name: 'Norton Commander' },
  { id: 'cga', name: 'CGA magenta' },
  { id: 'phosphor', name: 'Green phosphor' },
  { id: 'amber', name: 'Amber phosphor' },
  { id: 'mono', name: 'White phosphor' },
  { id: 'paper', name: 'Paper white' },
];

const KEY = 'gamma-ui-theme';

function initial() {
  if (!browser) return 'auto';
  const saved = localStorage.getItem(KEY);
  return THEMES.some((t) => t.id === saved) ? saved : 'auto';
}

export const theme = writable(initial());

export function resolveTheme(mode) {
  if (mode !== 'auto') return mode;
  if (!browser) return 'ocean';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'paper' : 'ocean';
}

if (browser) {
  let mode = 'auto';
  const apply = () => {
    document.documentElement.dataset.theme = resolveTheme(mode);
  };

  theme.subscribe((value) => {
    mode = value;
    localStorage.setItem(KEY, value);
    apply();
  });

  // auto keeps following the system while the page is open
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', apply);
}
