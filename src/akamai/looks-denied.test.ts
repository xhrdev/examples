import assert from 'node:assert/strict';
import { test } from 'node:test';

import { looksDenied } from '#src/akamai/session.js';

test("Akamai's Access Denied page is denied", () => {
  assert.equal(
    looksDenied('<HTML><BODY><H1>Access Denied</H1></BODY></HTML>'),
    true
  );
});

test("coupang's 403 page is denied although it never says Access Denied", () => {
  const html =
    '<html><head><title>쿠팡!</title></head><body>' +
    '<h1>요청하신 페이지의 사용권한이 없습니다.</h1></body></html>';
  assert.equal(looksDenied(html), true);
});

test('a real page is not denied', () => {
  assert.equal(
    looksDenied(
      '<html><head><title>쿠팡</title></head><body>로켓배송</body></html>'
    ),
    false
  );
});

test("akamai's unfinished challenge interstitial is denied, not a page", () => {
  const html =
    '<!DOCTYPE html><html><head></head><body>' +
    '<div id="sec-if-cpt-container" role="main" style="display: none"></div>' +
    '</body></html>';
  assert.equal(looksDenied(html), true);
});
