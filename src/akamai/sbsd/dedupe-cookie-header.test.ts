import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dedupeCookieHeader } from '#src/akamai/sbsd/solver.js';

test('a header with no duplicates is unchanged', () => {
  assert.equal(
    dedupeCookieHeader('a=1; bm_sz=2; _abck=3~-1~x'),
    'a=1; bm_sz=2; _abck=3~-1~x'
  );
});

test('an empty value loses to a real one, whichever came first', () => {
  // The observed case: the ledger endpoint refuses the header outright with
  // "conflicting duplicate cookie name 'bm_lso'", and an empty value is the
  // residue of a deletion rather than the live cookie.
  assert.equal(dedupeCookieHeader('bm_lso=; bm_lso=VALUE'), 'bm_lso=VALUE');
  assert.equal(dedupeCookieHeader('bm_lso=VALUE; bm_lso='), 'bm_lso=VALUE');
});

test('between two real values the newer one wins', () => {
  // Equal path specificity is ordered by creation time, so the later entry is
  // the one the server just set.
  assert.equal(dedupeCookieHeader('a=old; b=1; a=new'), 'a=new; b=1');
});

test('the position of the first occurrence is kept', () => {
  // The order the page presented is itself a reading; picking a later value
  // must not reshuffle it.
  assert.equal(dedupeCookieHeader('a=1; b=2; a=3; c=4'), 'a=3; b=2; c=4');
});

test('a value containing = survives intact', () => {
  assert.equal(dedupeCookieHeader('a=b=c==; a='), 'a=b=c==');
});

test('both entries empty collapses to one empty entry', () => {
  assert.equal(dedupeCookieHeader('a=; a='), 'a=');
});

test('whitespace and empty segments do not become cookies', () => {
  assert.equal(dedupeCookieHeader('  a=1 ;; ; b=2  '), 'a=1; b=2');
  assert.equal(dedupeCookieHeader(''), '');
  assert.equal(dedupeCookieHeader('   '), '');
});

test('a bare name with no = is kept as an empty value', () => {
  assert.equal(dedupeCookieHeader('a; b=2'), 'a=; b=2');
});
