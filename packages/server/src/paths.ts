import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, resolved from this file's location: packages/server/src -> ../../.. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
