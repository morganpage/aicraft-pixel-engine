/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

// Dedicated Vitest config for the showcase — the FAST suite.
//
// The root `vite.config.ts` runs the LIBRARY test suite (DOM-free, pure
// deterministic core) under `environment: 'node'`. The showcase is a real
// consumer app whose DOM-coupled section code (`sections/*.ts`) imports
// browser APIs (`document`, `canvas`, `pointer` events) at runtime and can't
// be unit-tested under node without jsdom (forbidden by the zero-deps
// invariant). Instead, the pure logic the sections use — the grid→pixels
// renderer — is extracted into `helpers/renderer.ts` and tested here.
//
// This config runs the fast contracts only: it excludes `*.scenario.test.ts`,
// which hold the multi-thousand-frame full-planet volcano simulations. Those
// run via `showcase:vitest.scenario.config.ts` (`npm run showcase:test:scenario`)
// or both at once with `npm run showcase:test:all`. The split keeps the default
// `showcase:test` feedback loop at milliseconds instead of minutes.
export default defineConfig({
  test: {
    environment: 'node',
    // Resolved from the repo root (where `npm run showcase:test` invokes
    // vitest), so the glob includes the showcase/ prefix.
    include: ['showcase/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'showcase/tests/**/*.scenario.test.ts'],
  },
});
