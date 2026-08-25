/**
 * The stylesheet collector, against the shapes DataDome actually serves and
 * the ones `/dd/solve` refuses.
 *
 * Worth testing rather than trusting: every URL here is re-validated by the
 * API, and one bad entry is a 400 for the whole request — so a solve that
 * used to work would start failing outright. These cases are the boundary
 * between "dropped quietly" and "sent and rejected".
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  collectStylesheetAssets,
  extractImportUrls,
  extractStylesheetUrls,
  stylesheetUrl,
} from '#src/datadome/stylesheets.js';

const documentUrl =
  'https://geo.captcha-delivery.com/captcha/?initialCid=abc&cid=def';

describe('dd stylesheet urls', () => {
  it('takes rel=stylesheet links and resolves them against the document', () => {
    const html = `
      <link rel="stylesheet" href="/captcha/assets/tpl/deadbeef/index.css">
      <link rel='stylesheet' href='https://static.captcha-delivery.com/a.css'>
      <link rel=stylesheet href=/bare.css>
    `;

    assert.deepEqual(extractStylesheetUrls(html, documentUrl), [
      'https://geo.captcha-delivery.com/captcha/assets/tpl/deadbeef/index.css',
      'https://static.captcha-delivery.com/a.css',
      'https://geo.captcha-delivery.com/bare.css',
    ]);
  });

  it('ignores links that are not stylesheets', () => {
    const html = `
      <link rel="preload" as="style" href="/preloaded.css">
      <link rel="icon" href="/favicon.ico">
      <link href="/no-rel.css">
    `;

    assert.deepEqual(extractStylesheetUrls(html, documentUrl), []);
  });

  it('accepts a stylesheet in a multi-token rel, as the solver does', () => {
    const html = '<link rel="alternate STYLESHEET" href="/alt.css">';

    assert.deepEqual(extractStylesheetUrls(html, documentUrl), [
      'https://geo.captcha-delivery.com/alt.css',
    ]);
  });

  it('drops anything the solver would answer 400 for', () => {
    // Each of these fails `normalizeDDStylesheetUrl` on the solver side, so
    // sending it would cost the solve rather than one asset.
    assert.equal(
      stylesheetUrl('http://geo.captcha-delivery.com/x.css'),
      undefined
    );
    assert.equal(stylesheetUrl('https://evil.example.com/x.css'), undefined);
    assert.equal(
      stylesheetUrl('https://u:p@geo.captcha-delivery.com/x.css'),
      undefined
    );
    assert.equal(stylesheetUrl('not a url'), undefined);
    assert.equal(stylesheetUrl(undefined), undefined);
  });

  it('does not treat a lookalike host as captcha-delivery.com', () => {
    assert.equal(
      stylesheetUrl('https://notcaptcha-delivery.com/x.css'),
      undefined
    );
    assert.equal(
      stylesheetUrl('https://captcha-delivery.com.evil.test/x.css'),
      undefined
    );
  });

  it('strips the fragment, so a canonical url is not sent twice', () => {
    assert.equal(
      stylesheetUrl('https://geo.captcha-delivery.com/x.css#frag'),
      'https://geo.captcha-delivery.com/x.css'
    );
  });
});

describe('dd stylesheet imports', () => {
  it('reads every @import spelling, resolved against the stylesheet', () => {
    const from = 'https://static.captcha-delivery.com/captcha/tpl/index.css';
    const css = `
      @import url("./font-face.css");
      @import url(bare.css);
      @import 'https://static.captcha-delivery.com/quoted.css';
    `;

    assert.deepEqual(extractImportUrls(css, from), [
      'https://static.captcha-delivery.com/captcha/tpl/font-face.css',
      'https://static.captcha-delivery.com/captcha/tpl/bare.css',
      'https://static.captcha-delivery.com/quoted.css',
    ]);
  });
});

describe('collecting dd stylesheet assets', () => {
  const html = '<link rel="stylesheet" href="/index.css">';

  it('follows imports — the roboto font-face is one level down', async () => {
    const bodies: Record<string, string> = {
      'https://geo.captcha-delivery.com/index.css':
        '@import url("https://static.captcha-delivery.com/common/fonts/roboto/font-face.css");',
      'https://static.captcha-delivery.com/common/fonts/roboto/font-face.css':
        '@font-face { font-family: Roboto }',
    };

    const assets = await collectStylesheetAssets({
      documentHtml: html,
      documentUrl,
      fetchAsset: async (url) => bodies[url] ?? assert.fail(`unasked: ${url}`),
    });

    assert.deepEqual(
      assets.map(({ url }) => url),
      Object.keys(bodies)
    );
  });

  it('terminates on an import cycle', async () => {
    const a = 'https://geo.captcha-delivery.com/index.css';
    const b = 'https://geo.captcha-delivery.com/b.css';

    const assets = await collectStylesheetAssets({
      documentHtml: html,
      documentUrl,
      fetchAsset: async (url) =>
        url === a ? `@import url("${b}");` : `@import url("${a}");`,
    });

    assert.deepEqual(
      assets.map(({ url }) => url),
      [a, b]
    );
  });

  it('stops at the 16 the solver accepts', async () => {
    const assets = await collectStylesheetAssets({
      documentHtml: html,
      documentUrl,
      // Every sheet imports a fresh one, so only the cap ends this.
      fetchAsset: async (url) =>
        `@import url("${url.replace(/[^/]+$/, `${Math.random()}.css`)}");`,
    });

    assert.equal(assets.length, 16);
  });

  it('drops an asset that will not fetch rather than failing the solve', async () => {
    const assets = await collectStylesheetAssets({
      documentHtml: html,
      documentUrl,
      fetchAsset: async () => {
        throw new Error('HTTP 404');
      },
    });

    assert.deepEqual(assets, []);
  });

  it('asks for nothing when the document references no stylesheets', async () => {
    const assets = await collectStylesheetAssets({
      documentHtml: '<html><body>no links</body></html>',
      documentUrl,
      fetchAsset: async () => assert.fail('should not fetch'),
    });

    assert.deepEqual(assets, []);
  });
});
