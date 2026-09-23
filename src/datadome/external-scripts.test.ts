import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  externalScriptUrl,
  extractExternalScriptUrls,
} from '#src/datadome/external-scripts.js';

const documentUrl =
  'https://geo.captcha-delivery.com/interstitial/?initialCid=abc&cid=def';

describe('dd external script urls', () => {
  it('lists captcha-delivery.com script srcs in document order', () => {
    const html = `
      <script>var ddm = {};</script>
      <script defer src="https://ct.captcha-delivery.com/i.js?v=1#frag"></script>
      <script src='/static/x.js' defer></script>
    `;
    assert.deepEqual(extractExternalScriptUrls(html, documentUrl), [
      'https://ct.captcha-delivery.com/i.js?v=1',
      'https://geo.captcha-delivery.com/static/x.js',
    ]);
  });

  it('returns nothing for an inline-only document', () => {
    assert.deepEqual(
      extractExternalScriptUrls('<script>var ddm = {};</script>', documentUrl),
      []
    );
  });

  it('skips other hosts, data-src, and tags inside script bodies', () => {
    const html = `
      <script data-src="https://ct.captcha-delivery.com/a.js"></script>
      <script src="https://example.com/b.js"></script>
      <script>var s = '<script src="https://ct.captcha-delivery.com/c.js">';</script>
      <script defer src="https://ct.captcha-delivery.com/c.js"></script>
      <script defer src="https://ct.captcha-delivery.com/c.js#again"></script>
    `;
    assert.deepEqual(extractExternalScriptUrls(html, documentUrl), [
      'https://ct.captcha-delivery.com/c.js',
    ]);
  });

  it('refuses what the API refuses', () => {
    assert.equal(
      externalScriptUrl('http://ct.captcha-delivery.com/i.js'),
      undefined
    );
    assert.equal(
      externalScriptUrl('https://ct.captcha-delivery.com:8443/i.js'),
      undefined
    );
    assert.equal(
      externalScriptUrl('https://u:p@ct.captcha-delivery.com/i.js'),
      undefined
    );
    assert.equal(
      externalScriptUrl('https://captcha-delivery.com.evil/i.js'),
      undefined
    );
  });
});
