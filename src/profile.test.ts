import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FULL_VERSION_LIST,
  PROFILE,
  PROFILE_ID,
  SEC_CH_UA,
} from '#src/profile.js';

const emitted: Record<string, unknown> = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'py-src',
      'profile.json'
    ),
    'utf8'
  )
) as Record<string, unknown>;

/**
 * The whole point of generating the JSON. Python cannot import the TypeScript,
 * so the copy it reads is only trustworthy while something fails when the two
 * disagree — otherwise this is just the second hand-maintained profile the
 * repo already got burned by.
 *
 * If this fails, run `npm run emit:profile` and commit the result.
 */
test('py-src/profile.json is in sync with src/profile.ts', () => {
  assert.deepEqual(
    emitted,
    JSON.parse(JSON.stringify({ id: PROFILE_ID, ...PROFILE })),
    'py-src/profile.json has drifted — run `npm run emit:profile`'
  );
});

test('the profile id is derived from the version and os, never written out', () => {
  assert.equal(PROFILE_ID, `chrome-${PROFILE.chromeVersion}-${PROFILE.os}`);
});

test("sec-ch-ua carries every brand, in registry order, in Chrome's format", () => {
  assert.equal(
    SEC_CH_UA,
    '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"'
  );
  for (const { brand } of PROFILE.brands) assert.ok(SEC_CH_UA.includes(brand));
});

/**
 * The GREASE entry is the one brand that does not carry the Chrome version,
 * and getting that wrong is invisible: the header still looks well-formed.
 */
test('the full-version list pads GREASE and gives every real brand the full version', () => {
  const byBrand = new Map(FULL_VERSION_LIST.map((b) => [b.brand, b.version]));
  assert.equal(byBrand.get('Google Chrome'), PROFILE.chromeFullVersion);
  assert.equal(byBrand.get('Chromium'), PROFILE.chromeFullVersion);
  assert.equal(byBrand.get('Not=A?Brand'), '99.0.0.0');
});

/**
 * The declared window has to be internally consistent. A viewport taller than
 * the screen it claims to sit on is not a browser anyone has.
 */
test('the declared window fits inside the declared screen', () => {
  const { screen } = PROFILE;
  assert.ok(screen.innerHeight <= screen.outerHeight);
  assert.ok(screen.outerHeight <= screen.height);
  assert.ok(screen.availHeight <= screen.height);
  assert.ok(screen.innerWidth <= screen.width);
});
