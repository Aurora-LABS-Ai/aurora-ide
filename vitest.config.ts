import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

import { auroraCanvasRuntime } from './vite-canvas-plugin'

// https://vitejs.dev/config/
export default defineConfig({
  // The canvas plugin is shared with vite.config.ts rather than duplicated, so
  // tests resolve `virtual:aurora-canvas-*` against the REAL generated module —
  // the SDK export list a canvas is validated against is the one that ships.
  plugins: [react(), auroraCanvasRuntime()],
  // Mirrors tsconfig.app.json `paths` and vite.config.ts `resolve.alias`.
  // All three must agree or `@/…` resolves in the editor and fails at runtime.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
})
