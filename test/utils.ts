import { fileURLToPath } from 'node:url';
import { dirname as pathDirname } from 'node:path';

/**
 * This is an ESM replacement for `__filename`.
 *
 * Use it like this: `__filename(import.meta)`.
 *
 * https://gist.github.com/khalidx/1c670478427cc0691bda00a80208c8cc
 */
const __filename = (meta: ImportMeta): string => fileURLToPath(meta.url);

/**
 * This is an ESM replacement for `__dirname`.
 *
 * Use it like this: `__dirname(import.meta)`.
 *
 * https://gist.github.com/khalidx/1c670478427cc0691bda00a80208c8cc
 */
const dirname = (meta: ImportMeta): string => pathDirname(__filename(meta));

export const __dirname = dirname(import.meta);
