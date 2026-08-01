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
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
