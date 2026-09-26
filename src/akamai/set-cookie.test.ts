import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSetCookie } from '#src/akamai/set-cookie.js';

test('every set-cookie survives, not just the last one', () => {
  // The whole reason this exists: `route.fulfill` carries one header map and
  // Akamai sets four cookies at once. Losing `_abck` here is invisible later —
  // every round returns the same cookie and `rval` never leaves -1.
  const parsed = parseSetCookie('https://www.hilton.com/en/', [
    '_abck=ABC~-1~xyz; Path=/; Domain=.hilton.com; Secure; HttpOnly',
    'bm_sz=DEF; Path=/',
    'ak_bmsc=GHI; Path=/',
    'bm_sv=JKL; Path=/',
  ]);
  assert.deepEqual(
    parsed.map((cookie) => cookie.name),
    ['_abck', 'bm_sz', 'ak_bmsc', 'bm_sv']
  );
});

test('a cookie with no Domain belongs to the host that sent it', () => {
  const [cookie] = parseSetCookie('https://login.xfinity.com/', ['a=1']);
  assert.equal(cookie?.domain, 'login.xfinity.com');
  assert.equal(cookie?.path, '/');
  assert.equal(cookie?.secure, false);
  assert.equal(cookie?.httpOnly, false);
});

test('attribute names are matched without regard to case', () => {
  const [cookie] = parseSetCookie('https://example.com/', [
    'a=1; PATH=/x; DOMAIN=.example.com; SECURE; HTTPONLY',
  ]);
  assert.equal(cookie?.path, '/x');
  assert.equal(cookie?.domain, '.example.com');
  assert.equal(cookie?.secure, true);
  assert.equal(cookie?.httpOnly, true);
});

test('Max-Age wins over Expires, as the RFC says and browsers do', () => {
  const [cookie] = parseSetCookie('https://example.com/', [
    'a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=3600',
  ]);
  assert.ok(cookie?.expires !== undefined);
  assert.ok(cookie.expires > Date.now() / 1000);
});

test('a session cookie carries no expiry at all', () => {
  // `expires: NaN` would be sent to addCookies and rejected there, naming the
  // cookie rather than the header it came from.
  const [cookie] = parseSetCookie('https://example.com/', ['a=1; Path=/']);
  assert.equal(cookie?.expires, undefined);
});

test('a value containing = keeps all of it', () => {
  // Base64 payloads end in padding, and `_abck` is full of `=`.
  const [cookie] = parseSetCookie('https://example.com/', ['a=b=c==; Path=/']);
  assert.equal(cookie?.value, 'b=c==');
});

test('a header this cannot read is dropped, not thrown over', () => {
  // One malformed cookie is not a reason to fail the request that carried it.
  const parsed = parseSetCookie('https://example.com/', [
    'novalue',
    '=noname',
    'a=1',
  ]);
  assert.deepEqual(
    parsed.map((cookie) => cookie.name),
    ['a']
  );
});

test('no set-cookie at all is no cookies, not a throw', () => {
  assert.deepEqual(parseSetCookie('https://example.com/', undefined), []);
  assert.deepEqual(parseSetCookie('https://example.com/', []), []);
});
