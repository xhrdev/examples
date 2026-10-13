import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSensorScript } from '#src/akamai/route-fetch.js';

const pad = (n: number): string => 'x'.repeat(n);

test('a large script that names bmak is the sensor', () => {
  assert.equal(isSensorScript(`${pad(60_000)};var bmak={};`), true);
});

/**
 * The finnair/uline case: an Akamai script on the sensor's path shape, over
 * 100 KB, with no `bmak`. Treating it as the sensor parked the session on it.
 */
test('a large script without bmak is not', () => {
  assert.equal(isSensorScript(pad(104_238)), false);
});

test('a small script is not, even if it mentions bmak', () => {
  assert.equal(isSensorScript('window.bmak = 1;'), false);
});
