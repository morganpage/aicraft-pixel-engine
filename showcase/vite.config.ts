import { defineConfig } from 'vite';

// Showcase-only Vite config. The library is imported via relative paths
// (../src/<module>); no alias, no symlink, no package.json dependency.
//
// `root: 'showcase'` makes this a self-contained app rooted at the
// showcase/ directory. `base: './'` makes the built index.html portable to
// any deploy path.
export default defineConfig({
  root: 'showcase',
  base: './',
  // Honour PORT when set, so tooling that assigns a free port (and then opens
  // that URL) actually reaches the dev server. Without this Vite ignores the
  // assignment, picks its own port by auto-incrementing from 5173, and the
  // caller ends up pointed at nothing.
  server: {
    port: Number((globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env?.PORT) || 5173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
