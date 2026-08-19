/**
 * Write `py-src/profile.json` from `src/profile.ts`.
 *
 *   npm run emit:profile
 *
 * The Python clients cannot import TypeScript, and a second hand-maintained
 * copy of the identity is the exact failure this repo already had once — the
 * Akamai scripts sat two major versions behind DataDome because nothing made
 * the drift visible. So Python reads a generated copy instead.
 *
 * The output is committed. A generated file in git looks redundant until you
 * remember the Python examples are meant to run after `pip install -r
 * requirements.txt` alone, with no Node in the picture. `src/profile.test.ts`
 * fails if the committed JSON drifts from the TypeScript, so the generated
 * copy cannot quietly go stale.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROFILE, PROFILE_ID } from '#src/profile.js';

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'py-src',
  'profile.json'
);

writeFileSync(
  out,
  `${JSON.stringify({ id: PROFILE_ID, ...PROFILE }, null, 2)}\n`
);

console.log(`wrote ${out} (${PROFILE_ID})`);
