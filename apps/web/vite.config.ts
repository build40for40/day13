import { defineConfig } from 'vitest/config'

// Parker is served at build40for40.com/parker/. Built into dist/parker so the assets directory mirrors the URL path.
export default defineConfig({
  base: '/parker/',
  build: { outDir: 'dist/parker', emptyOutDir: true },
  server: {
    // Same-origin for the brain in dev: `pnpm --filter @day13/brain dev` runs it on 8787.
    proxy: { '/day13/api': { target: 'http://localhost:8787', rewrite: (p) => p.replace(/^\/day13\/api/, '') } },
  },
  test: { environment: 'jsdom' },
})
