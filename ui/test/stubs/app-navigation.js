// $app/navigation for vitest: nothing navigates, every call is recorded
export const calls = [];

const record = (name) => (...args) => {
  calls.push({ name, args });
  return Promise.resolve();
};

export const goto = record('goto');
export const replaceState = record('replaceState');
export const pushState = record('pushState');
export const invalidate = record('invalidate');
export const invalidateAll = record('invalidateAll');
export const preloadData = record('preloadData');
export const preloadCode = record('preloadCode');
export const afterNavigate = () => {};
export const beforeNavigate = () => {};
export const onNavigate = () => {};
export const disableScrollHandling = () => {};
