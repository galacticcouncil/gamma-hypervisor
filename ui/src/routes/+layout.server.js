// first paint in one round trip. express sets the registry on globalThis before it imports
// build/handler.js:
//
//   globalThis.__gammaUi = { statusJson: () => StatusV1 }  // already redacted, as every route body is
//
// this file never imports server/ — vite would bundle a second copy of db/index.ts and open a
// second sqlite handle — and never fetches: a relative fetch from a server load goes to
// sveltekit's own router, not to express.

// sveltekit passes the request event; this load needs nothing from it
export function load() {
  try {
    const registry = globalThis.__gammaUi;
    const status = registry?.statusJson?.() ?? null;
    return { status, ssr: status != null };
  } catch {
    // the message would carry an internal url into the html; the page draws the
    // 'api unreachable' strip and the client poll takes over
    return { status: null, ssr: false };
  }
}
