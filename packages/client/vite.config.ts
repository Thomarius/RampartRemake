import { resolve } from 'node:path';

import { defineConfig } from 'vite';

const repoRoot = resolve(import.meta.dirname, '..', '..');

export default defineConfig({
  /**
   * Audio lives in the repository's `assets/` directory, outside this package.
   *
   * Pointing Vite's public directory at it means the same files are served at the same
   * URLs in both worlds: the dev server hands them straight out, and `vite build`
   * copies them into `dist/`, which is exactly what the production server already
   * serves. Neither the server nor the Dockerfile needs to know audio exists.
   *
   * The manifest's `basePath` is `audio` because the contents of this directory are
   * served at the site root, so `assets/audio/sfx/x.ogg` is `/audio/sfx/x.ogg`.
   */
  publicDir: resolve(repoRoot, 'assets'),
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
