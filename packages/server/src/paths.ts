import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repository root, resolved from this file's location: packages/server/src -> ../../..
 *
 * The production bundle is emitted to `packages/server/dist/`, which sits at the same
 * depth, so this holds for both. `loadConfigBundle` and the static client path are
 * both built on it — move either and the server stops finding its rules.
 */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
