import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Route } from 'playwright-core';

import { failClosed } from '#src/akamai/sbsd/solver.js';

/**
 * The router is handed to Playwright, which does not give a rejecting handler
 * anywhere to reject to -- under Node 24 that ends the process. On
 * 2026-10-10 a single `route.fetch` timeout during `hilton` took down the
 * deployed canary that way (`Runtime.ExitError`). These pin what the wrapper
 * promises: nothing leaves the handler, and the request is aborted, never
 * continued.
 */
const fakeRoute = (
  overrides: { abort?: () => Promise<void> } = {}
): { aborted: () => number; route: Route } => {
  let aborts = 0;
  const route = {
    abort:
      overrides.abort ??
      (async () => {
        aborts++;
      }),
  } as unknown as Route;
  return { aborted: () => aborts, route };
};

test('a handler that succeeds is left alone', async () => {
  const { aborted, route } = fakeRoute();
  const faults: unknown[] = [];
  await failClosed(
    async () => undefined,
    (_route, error) => faults.push(error)
  )(route);
  assert.equal(aborted(), 0);
  assert.equal(faults.length, 0);
});

test('a handler that throws is aborted, reported, and does not reject', async () => {
  const { aborted, route } = fakeRoute();
  const faults: unknown[] = [];
  const boom = new Error('route.fetch: Timeout 30000ms exceeded.');
  await assert.doesNotReject(
    failClosed(
      async () => {
        throw boom;
      },
      (_route, error) => faults.push(error)
    )(route)
  );
  assert.equal(aborted(), 1, 'the request must be denied, not continued');
  assert.deepEqual(faults, [boom]);
});

test('a fault after the route was already handled does not become the new uncaught error', async () => {
  // Playwright throws "Route is already handled!" from abort() once the route
  // has been fulfilled or continued.
  const { route } = fakeRoute({
    abort: async () => {
      throw new Error('Route is already handled!');
    },
  });
  await assert.doesNotReject(
    failClosed(
      async () => {
        throw new Error('fault after fulfil');
      },
      () => undefined
    )(route)
  );
});

test('a reporter that throws cannot escape either', async () => {
  const { aborted, route } = fakeRoute();
  await assert.doesNotReject(
    failClosed(
      async () => {
        throw new Error('handler fault');
      },
      () => {
        throw new Error('logger fault');
      }
    )(route)
  );
  assert.equal(aborted(), 1, 'the abort still happens when reporting fails');
});

test('a non-Error throw is handled', async () => {
  const { aborted, route } = fakeRoute();
  await assert.doesNotReject(
    failClosed(
      async () => {
        throw 'a string';
      },
      () => undefined
    )(route)
  );
  assert.equal(aborted(), 1);
});
