import adapter from '@sveltejs/adapter-node';

// adapted from rpc-status svelte.config.js (working tree, 2026-09-18): same
// adapter-node + express handoff; no envPrefix, so ORIGIN/PORT are read as-is
/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({
      out: 'build',
      precompress: false,
    }),
    alias: {
      $components: 'src/lib/components',
      $utils: 'src/lib/utils',
    },
  },
};

export default config;
