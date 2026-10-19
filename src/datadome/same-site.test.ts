import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sameSite } from '#src/datadome/same-site.js';

test('a regional redirect on the same registrable domain is the same site', () => {
  assert.equal(sameSite('www.kompass.com', 'us.kompass.com'), true);
  assert.equal(sameSite('kompass.com', 'www.kompass.com'), true);
  assert.equal(sameSite('www.kompass.com', 'www.kompass.com'), true);
});

test('multi-part public suffixes are not treated as the registrable domain', () => {
  assert.equal(sameSite('shop.example.co.uk', 'www.example.co.uk'), true);
  assert.equal(sameSite('www.example.com.au', 'login.example.com.au'), true);
  assert.equal(sameSite('www.example.co.uk', 'www.other.co.uk'), false);
  assert.equal(sameSite('www.example.com.au', 'www.other.com.au'), false);
});

test('unrelated domains do not match', () => {
  assert.equal(sameSite('www.kompass.com', 'www.kompass.fr'), false);
  assert.equal(sameSite('www.kompass.com', 'kompass.com.evil.example'), false);
  assert.equal(sameSite('www.kompass.com', 'notkompass.com'), false);
  assert.equal(sameSite('www.kompass.com', 'geo.captcha-delivery.com'), false);
});

test('private suffixes keep tenants apart', () => {
  assert.equal(sameSite('alice.github.io', 'bob.github.io'), false);
  assert.equal(sameSite('alice.github.io', 'www.alice.github.io'), true);
});

test('hosts with no registrable domain only match themselves', () => {
  assert.equal(sameSite('localhost', 'localhost'), true);
  assert.equal(sameSite('10.0.0.5', '10.0.0.5'), true);
  assert.equal(sameSite('10.0.0.5', '10.0.0.6'), false);
  assert.equal(sameSite('localhost', 'www.kompass.com'), false);
});
