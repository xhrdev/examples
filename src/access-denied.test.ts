/**
 * The denial/fault split, which the load-test summary reports on.
 *
 * Worth pinning: getting this wrong in either direction is quiet. Too narrow
 * and refusals keep landing in `Error (timeout/crash)` next to real crashes,
 * which is the bug this replaced. Too broad and a genuine fault gets counted
 * as the site declining us, which reads as a working run that measured
 * something.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isAccessDenied } from '#src/access-denied.js';

describe('access denied', () => {
  it('counts the HTTP clients refusal — a status on re-request', () => {
    assert.equal(
      isAccessDenied(new Error('verification failed: HTTP 403')),
      true
    );
  });

  it('counts the browser refusal — a fresh challenge instead of clearance', () => {
    assert.equal(
      isAccessDenied(new Error('The target returned a recurrent challenge')),
      true
    );
  });

  it('does not count a solver fault as the site declining us', () => {
    for (const message of [
      'solver returned HTTP 500: DD solve error',
      'Solver acceptance timeout (120s)',
      'fetch failed',
      'the challenge iframe never loaded',
      'DataDome reports this IP is banned',
      'rate limit hit: the solver returned HTTP 429',
    ]) {
      assert.equal(isAccessDenied(new Error(message)), false, message);
    }
  });

  it('does not count a 200 or a 500 as a refusal', () => {
    assert.equal(
      isAccessDenied(new Error('verification failed: HTTP 500')),
      false
    );
    assert.equal(
      isAccessDenied(new Error('verification failed: HTTP 200')),
      false
    );
  });

  it('tolerates a non-error', () => {
    assert.equal(isAccessDenied(undefined), false);
    assert.equal(isAccessDenied(null), false);
  });
});
