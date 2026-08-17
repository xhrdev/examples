import assert from 'node:assert/strict';
import { test } from 'node:test';

import { solverBaseUrl, solverWsUrl } from '#src/solver-url.js';

test('a bare host keeps the self-hosted default: plain http on :3000', () => {
  assert.equal(solverBaseUrl('10.0.0.5'), 'http://10.0.0.5:3000');
  assert.equal(solverBaseUrl('solver.internal'), 'http://solver.internal:3000');
});

test('a full URL is used verbatim, so TLS survives', () => {
  assert.equal(solverBaseUrl('https://trial.xhr.dev'), 'https://trial.xhr.dev');
  assert.equal(solverBaseUrl('http://10.0.0.5:8080'), 'http://10.0.0.5:8080');
});

test('a trailing slash does not double up when paths are joined', () => {
  assert.equal(
    solverBaseUrl('https://trial.xhr.dev/'),
    'https://trial.xhr.dev'
  );
  assert.equal(
    new URL('/dd/solve', solverBaseUrl('https://trial.xhr.dev/')).href,
    'https://trial.xhr.dev/dd/solve'
  );
});

test('the websocket scheme follows the base URL', () => {
  // Sending ws:// to a TLS listener fails to connect; sending wss:// to a
  // plain one is the same mistake in reverse. Neither should be possible.
  assert.equal(
    solverWsUrl('https://trial.xhr.dev', '/akamai/session'),
    'wss://trial.xhr.dev/akamai/session'
  );
  assert.equal(
    solverWsUrl('10.0.0.5', '/akamai/session'),
    'ws://10.0.0.5:3000/akamai/session'
  );
});
