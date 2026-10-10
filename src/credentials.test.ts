import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  hasAnyCredentials,
  NOT_CONFIGURED_EXIT_CODE,
  resolveCredentials,
} from '#src/credentials.js';

test('a target-specific pair is used', () => {
  assert.deepEqual(
    resolveCredentials('oakley', {
      oakley_password: 'p',
      oakley_username: 'u',
    }),
    { password: 'p', username: 'u' }
  );
});

test('the generic pair is the fallback, so loadtest pass-through keeps working', () => {
  assert.deepEqual(
    resolveCredentials('oakley', { password: 'gp', username: 'gu' }),
    {
      password: 'gp',
      username: 'gu',
    }
  );
});

test('the target-specific pair wins over the generic one', () => {
  assert.deepEqual(
    resolveCredentials('oakley', {
      oakley_password: 'p',
      oakley_username: 'u',
      password: 'gp',
      username: 'gu',
    }),
    { password: 'p', username: 'u' }
  );
});

test('a half pair is absent, not half-used', () => {
  // A username with no password is a failed login that reads like a solver
  // result, which is the thing this module exists to keep out of the table.
  assert.equal(resolveCredentials('oakley', { oakley_username: 'u' }), null);
  assert.equal(resolveCredentials('oakley', { password: 'gp' }), null);
  assert.equal(
    resolveCredentials('oakley', { oakley_password: '', oakley_username: 'u' }),
    null
  );
});

test('a half target pair falls through to a whole generic pair', () => {
  assert.deepEqual(
    resolveCredentials('oakley', {
      oakley_username: 'u',
      password: 'gp',
      username: 'gu',
    }),
    { password: 'gp', username: 'gu' }
  );
});

test("another target does not read oakley's pair", () => {
  assert.equal(
    resolveCredentials('hilton', {
      oakley_password: 'p',
      oakley_username: 'u',
    }),
    null
  );
});

test('nothing configured is null', () => {
  assert.equal(resolveCredentials('oakley', {}), null);
});

test('the exit code does not collide with the other infrastructural ones', () => {
  // 3 is a spent rate-limit budget, 4 a banned exit IP; smoke.js keys on all three.
  assert.equal(NOT_CONFIGURED_EXIT_CODE, 5);
});

test('the banner sees a target-scoped pair, which it used to miss', () => {
  assert.equal(
    hasAnyCredentials({ oakley_password: 'p', oakley_username: 'u' }),
    true
  );
  assert.equal(hasAnyCredentials({ password: 'p', username: 'u' }), true);
});

test('the banner wants a whole pair, and none is not set', () => {
  assert.equal(hasAnyCredentials({ oakley_username: 'u' }), false);
  assert.equal(hasAnyCredentials({ password: 'p' }), false);
  assert.equal(hasAnyCredentials({ api_key: 'k', host: 'h' }), false);
  assert.equal(hasAnyCredentials({}), false);
});
