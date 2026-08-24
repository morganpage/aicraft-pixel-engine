/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

// Vitest config for the recipes' pure-logic tests. The DOM-touching recipes
// (radial-camera, dirty-chunk-renderer) are covered by `recipes:typecheck`
// and by the games that use them; only clock and census logic runs here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['recipes/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
