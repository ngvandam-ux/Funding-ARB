import { defineConfig } from 'vitest/config'

// Pure-TS unit tests for src/lib/{math,normalize}.ts (CLAUDE.md hard rule #6).
// Kept separate from vite.config.ts to avoid the vite5 (vitest dep) vs vite6
// plugin-type clash — no vite plugins are needed for node-env unit tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
