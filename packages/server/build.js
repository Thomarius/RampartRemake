import { resolve } from 'node:path';

import { build } from 'esbuild';

/** Resolved from this file, so the script works from any working directory. */
const here = import.meta.dirname;

/**
 * Bundles the server into one file for the production image.
 *
 * Development still runs the TypeScript directly through tsx, and internal packages
 * still export source with no build step between them — that property is worth
 * keeping and this does not touch it. esbuild resolves the workspace links itself at
 * build time, so the whole simulation, AI and protocol arrive here as one file
 * without any package needing an emit config or a dist of its own.
 *
 * The output lands in `packages/server/dist/` and not somewhere tidier because
 * `paths.ts` walks three directories up to find the repository root, and `dist` sits
 * at exactly the same depth as `src`. Moving it changes where the server looks for
 * `config/` and the built client.
 */
await build({
  entryPoints: [resolve(here, 'src', 'main.ts')],
  outfile: resolve(here, 'dist', 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // ws probes for these two native accelerators inside a try/catch and runs happily
  // without them. They are the only optional dependencies in the tree, so leaving
  // them out is what lets the runtime image carry no node_modules at all.
  external: ['bufferutil', 'utf-8-validate'],
  // `ws` is CommonJS, and its `require` of Node builtins does not survive being
  // bundled into an ES module — the server dies on the first connection attempt with
  // "Dynamic require of events is not supported". This gives the bundle a real
  // `require` to fall back on, which is also what lets `ws` probe for the two
  // accelerators above and find them absent without crashing.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
