import { sveltekit } from '@sveltejs/kit/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // tests compile .svelte with the bare plugin (no svelte-kit sync); $app/* come from test/stubs
  plugins: process.env.VITEST
    ? [svelte({ hot: false, configFile: false, compilerOptions: { hydratable: true } })]
    : [sveltekit()],
  resolve: {
    // vite does not read tsconfig paths; keep in step with tsconfig.json
    alias: { '@keeper': path.resolve(here, '../keeper/src') },
    // one zod / ethers instance even though ../keeper/src resolves them from keeper/node_modules
    // (tsx gets the same from the zod/ethers entries in tsconfig paths)
    dedupe: ['zod', 'ethers'],
  },
  server: {
    fs: { allow: ['..'] },
  },
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    alias: {
      $lib: path.resolve(here, 'src/lib'),
      '$app/environment': path.resolve(here, 'test/stubs/app-environment.js'),
      '$app/navigation': path.resolve(here, 'test/stubs/app-navigation.js'),
      '$app/stores': path.resolve(here, 'test/stubs/app-stores.js'),
    },
  },
});
