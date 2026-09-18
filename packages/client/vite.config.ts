import { resolve } from 'node:path';

import { defineConfig } from 'vite';

const repoRoot = resolve(import.meta.dirname, '..', '..');

export default defineConfig({
  server: {
    // @rampart/config imports the JSON files in the repository-root config/ directory.
    fs: { allow: [repoRoot] },
  },
  build: {
    target: 'es2023',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
