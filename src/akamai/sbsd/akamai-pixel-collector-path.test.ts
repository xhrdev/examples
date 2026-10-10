import assert from 'node:assert/strict';
import { test } from 'node:test';

import { akamaiPixelCollectorPath } from '#src/akamai/sbsd/solver.js';

/**
 * Akamai's pairing for its third channel: `/akam/<n>/<hex>` serves the
 * collector, `/akam/<n>/pixel_<hex>` is what it POSTs to. Answering that POST
 * needs the script's text, and nothing at load time says which script belongs
 * to which endpoint — so the pairing is derived, and this is the test that
 * says so out loud.
 */
test('the collector is the target with pixel_ stripped off the basename', () => {
  // The two live samples: oakley's, and the one in the solver's own doc block.
  assert.equal(
    akamaiPixelCollectorPath('/akam/13/pixel_88bfc2e'),
    '/akam/13/88bfc2e'
  );
  assert.equal(
    akamaiPixelCollectorPath('/akam/13/pixel_653a34d9'),
    '/akam/13/653a34d9'
  );
});

test('the directory is left alone, however deep', () => {
  // `<n>` is a product counter, not always 13, and the deny-prefix machinery
  // keys on the directory — so the directory must survive untouched.
  assert.equal(akamaiPixelCollectorPath('/akam/7/pixel_abc'), '/akam/7/abc');
  assert.equal(
    akamaiPixelCollectorPath('/akam/13/sub/pixel_abc'),
    '/akam/13/sub/abc'
  );
});

test('a basename without the prefix is null, not a guess', () => {
  // The caller falls back to any script cached in the same directory. Inventing
  // a path here would send the wrong source to the sandbox and read as a solver
  // fault rather than as a convention that moved.
  assert.equal(akamaiPixelCollectorPath('/akam/13/88bfc2e'), null);
  assert.equal(akamaiPixelCollectorPath('/akam/13/beacon_88bfc2e'), null);
  assert.equal(akamaiPixelCollectorPath('/akam/13/'), null);
});

test('a bare prefix with nothing after it is null', () => {
  // `pixel_` alone leaves no stem, and `/akam/13/` is a directory rather than a
  // script: answering with the directory would fetch the wrong thing.
  assert.equal(akamaiPixelCollectorPath('/akam/13/pixel_'), null);
});
