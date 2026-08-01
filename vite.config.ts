/// <reference types="vitest" />
import { defineConfig } from 'vite';

// Vite + Vitest configuration.
// Tests target the pure core layer, which is DOM-free, so a fast Node
// environment is used.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
  },
});
