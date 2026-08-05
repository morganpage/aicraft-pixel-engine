/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

// Vitest config for the showcase's SLOW scenario suite — the multi-thousand-frame
// full-planet volcano simulations.
//
// Excluded from the default `showcase:test` run (see `vitest.config.ts`) so the
// normal feedback loop stays fast. Run explicitly via
// `npm run showcase:test:scenario`, or together with the fast suite via
// `npm run showcase:test:all` (CI).
//
// `testTimeout` is raised per-test in the file itself (the `beforeAll` golden
// trajectory runs once for ~22s); a generous global timeout keeps a single
// runaway frame loop from hanging the suite indefinitely.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['showcase/tests/**/*.scenario.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // The golden trajectory `beforeAll` is the long pole; allow headroom.
    hookTimeout: 120_000,
    testTimeout: 90_000,
  },
});
