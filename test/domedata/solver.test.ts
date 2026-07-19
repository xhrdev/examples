import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Page } from 'playwright-core';

import {
  buildCaptchaRelayUrl,
  buildInterstitialRelayBody,
  type CaptchaSolverResult,
  type DataDomeChallenge,
  parseChallenge,
  solveDataDome,
  solverCookieForChallengeDocument,
  validateSolverResult,
} from '#src/domedata/solver.js';

const CAPTCHA_CHALLENGE: DataDomeChallenge = {
  cid: 'active-cid',
  hsh: 'ACTIVEHASH',
  ir: 7,
  rt: 'c',
  s: 51825,
};
const CAPTCHA_REFERER =
  'https://geo.captcha-delivery.com/captcha/?initialCid=active-cid';
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=UTF-8';
const GEO_ORIGIN = 'https://geo.captcha-delivery.com';

function captchaCarrierUrl(
  payload: string,
  plv3: string,
  overrides: Readonly<Record<string, string>> = {}
): string {
  const field = (name: string, fallback: string): string =>
    overrides[name] ?? fallback;
  const fields: Array<readonly [string, string]> = [
    ['cid', field('cid', 'captcha-html-cid')],
    ['icid', field('icid', CAPTCHA_CHALLENGE.cid)],
    ['ccid', field('ccid', '')],
    ['userEnv', field('userEnv', 'user-env')],
    ['dm', field('dm', 'cd')],
    ['ddCaptchaChallenge', field('ddCaptchaChallenge', 'slider-challenge')],
    ['ddCaptchaEncodedPayload', payload],
    ['plv3', plv3],
    ['ddCaptchaEnv', field('ddCaptchaEnv', 'captcha-env')],
    [
      'ddCaptchaAudioChallenge',
      field('ddCaptchaAudioChallenge', 'audio-challenge'),
    ],
    ['hash', field('hash', CAPTCHA_CHALLENGE.hsh)],
    ['ua', field('ua', 'Chrome%2F149.0.0.0')],
    ['referer', field('referer', 'https%3a%2f%2finternal.example%2f')],
    ['parent_url', field('parent_url', 'https%3A%2F%2Finternal.example%2F')],
    ['x-forwarded-for', field('x-forwarded-for', '')],
    ['s', field('s', String(CAPTCHA_CHALLENGE.s))],
    ['ir', field('ir', String(CAPTCHA_CHALLENGE.ir))],
  ];
  return `${GEO_ORIGIN}/captcha/check?${fields
    .map(([name, value]) => `${name}=${value}`)
    .join('&')}`;
}

function captchaSolverResult(url: string): CaptchaSolverResult {
  return {
    origin: GEO_ORIGIN,
    referer: CAPTCHA_REFERER,
    type: 'captcha',
    url,
  };
}

describe('DataDome challenge parsing', () => {
  it('parses canonical interstitial and captcha document URLs', () => {
    assert.deepEqual(
      parseChallenge(
        `${GEO_ORIGIN}/interstitial/?initialCid=url-cid` +
          '&amp;hash=URLHASH&amp;s=7&amp;ir=4,5,6&amp;b=2'
      ),
      {
        b: 2,
        cid: 'url-cid',
        hsh: 'URLHASH',
        ir: '4,5,6',
        rt: 'i',
        s: 7,
      }
    );
    assert.deepEqual(
      parseChallenge(
        `${GEO_ORIGIN}/captcha/?initialCid=captcha-cid` +
          '&hash=CAPTCHAHASH&s=9&ir=12,34,56,78,90,123&cid=document-cid'
      ),
      {
        cid: 'captcha-cid',
        hsh: 'CAPTCHAHASH',
        ir: '12,34,56,78,90,123',
        rt: 'c',
        s: 9,
      }
    );
  });

  it('rejects incomplete and malformed challenge identities', () => {
    assert.equal(parseChallenge('plain target response'), null);
    assert.equal(
      parseChallenge(`${GEO_ORIGIN}/captcha/?initialCid=cid&hash=hash&ir=bad`),
      null
    );
    assert.equal(
      parseChallenge(`${GEO_ORIGIN}/captcha/?cid=document-cid&hash=hash`),
      null
    );
    assert.equal(
      parseChallenge(`${GEO_ORIGIN}/interstitial/?initialCid=cid`),
      null
    );
    assert.equal(
      parseChallenge('https://example.test/captcha/?initialCid=cid&hash=hash'),
      null
    );
  });
});

describe('interstitial carrier relay', () => {
  const nativeBody =
    'cid=active&hash=ACTIVEHASH&referer=https%3A%2F%2Finternal.example%2F' +
    '&payload=browser%2Bpayload&plv3=browser-wire&ps=9604';
  const solvedBody =
    'cid=active&hash=ACTIVEHASH&referer=https%3A%2F%2Finternal.example%2F' +
    '&payload=sandbox%252Bpayload&plv3=sandbox-wire&ps=9604';

  it('replaces only payload and plv3 without re-encoding the form', () => {
    assert.equal(
      buildInterstitialRelayBody(nativeBody, solvedBody),
      solvedBody
    );
  });

  it('preserves native non-sensor fields and tolerates solver schema drift', () => {
    const drifted = solvedBody
      .replace('hash=ACTIVEHASH', 'hash=solver-hash')
      .replace('ps=9604', 'ps=0')
      .concat('&solverOnly=value');
    assert.equal(buildInterstitialRelayBody(nativeBody, drifted), solvedBody);
  });

  it('rejects malformed, ambiguous, or mismatched carriers', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [nativeBody, solvedBody.replace('cid=active', 'cid=other')],
      [nativeBody, solvedBody.replace('&payload=', '&%70ayload=')],
      [nativeBody, `${solvedBody}&payload=duplicate`],
      [
        nativeBody,
        solvedBody.replace('payload=sandbox%252Bpayload&plv3=', 'plv3='),
      ],
    ];
    for (const [native, solved] of cases) {
      assert.throws(() => buildInterstitialRelayBody(native, solved));
    }
  });
});

describe('captcha carrier relay', () => {
  it('replaces only encoded payload and plv3 in the raw query', () => {
    const nativeUrl = captchaCarrierUrl('browser%2Bpayload', 'browser-wire');
    const solvedUrl = captchaCarrierUrl('sandbox%252Bpayload', 'sandbox-wire', {
      referer: 'https%3A%2F%2Finternal.example%2F',
    });
    const relayUrl = buildCaptchaRelayUrl({
      headers: {
        'Content-Type': FORM_CONTENT_TYPE,
        Referer: CAPTCHA_REFERER,
      },
      solved: captchaSolverResult(solvedUrl),
      url: nativeUrl,
    });

    const nativeSegments = nativeUrl.split('?')[1]?.split('&');
    const solvedSegments = solvedUrl.split('?')[1]?.split('&');
    const relaySegments = relayUrl.split('?')[1]?.split('&');
    assert.ok(nativeSegments);
    assert.ok(solvedSegments);
    assert.ok(relaySegments);
    assert.equal(relaySegments.length, nativeSegments.length);
    for (let index = 0; index < relaySegments.length; index += 1) {
      const fieldName: string | undefined = relaySegments[index]?.split('=')[0];
      assert.equal(
        relaySegments[index],
        fieldName === 'ddCaptchaEncodedPayload' || fieldName === 'plv3'
          ? solvedSegments[index]
          : nativeSegments[index]
      );
    }
    assert.match(
      relayUrl,
      /ddCaptchaEncodedPayload=sandbox%252Bpayload&plv3=sandbox-wire/
    );
    assert.match(relayUrl, /referer=https%3a%2f%2f/);
  });

  it('adds sandbox sensors when native sensor globals are absent', () => {
    const fullNative = captchaCarrierUrl('browser-payload', 'browser-wire');
    const nativeUrl = fullNative.replace(
      '&ddCaptchaEncodedPayload=browser-payload',
      ''
    );
    const solvedUrl = captchaCarrierUrl('sandbox-payload', 'sandbox-wire');
    const relayUrl = buildCaptchaRelayUrl({
      headers: {
        'content-type': FORM_CONTENT_TYPE,
        referer: CAPTCHA_REFERER,
      },
      solved: captchaSolverResult(solvedUrl),
      url: nativeUrl,
    });

    assert.equal(
      new URL(relayUrl).searchParams.get('ddCaptchaEncodedPayload'),
      'sandbox-payload'
    );
    assert.equal(new URL(relayUrl).searchParams.get('plv3'), 'sandbox-wire');
  });

  it('correlates by cid while preserving native non-sensor fields', () => {
    const nativeUrl = captchaCarrierUrl('browser-payload', 'browser-wire');
    const solvedUrl = captchaCarrierUrl('sandbox-payload', 'sandbox-wire');
    const call = (
      overrides: Partial<{
        headers: Record<string, string>;
        solved: CaptchaSolverResult;
        url: string;
      }> = {}
    ): string =>
      buildCaptchaRelayUrl({
        headers: {
          'content-type': FORM_CONTENT_TYPE,
          referer: CAPTCHA_REFERER,
          ...overrides.headers,
        },
        solved: overrides.solved ?? captchaSolverResult(solvedUrl),
        url: overrides.url ?? nativeUrl,
      });

    assert.throws(
      () => call({ headers: { referer: 'https://unexpected.example/' } }),
      /Referer did not match/
    );
    assert.throws(
      () => call({ url: `${nativeUrl}&plv3=duplicate` }),
      /duplicated a field/
    );
    assert.throws(
      () => call({ url: `${nativeUrl}&ddCaptchaResponse=native` }),
      /already contained a response/
    );
    assert.throws(
      () =>
        call({
          solved: captchaSolverResult(
            solvedUrl.replace('cid=captcha-html-cid', 'cid=other')
          ),
        }),
      /cid did not match/
    );
    const drifted = call({
      solved: captchaSolverResult(
        solvedUrl.replace('userEnv=user-env', 'userEnv=other')
      ),
    });
    assert.equal(new URL(drifted).searchParams.get('userEnv'), 'user-env');
  });
});

describe('challenge document solver cookie', () => {
  it('uses the decoded live captcha cid', () => {
    assert.equal(
      solverCookieForChallengeDocument(
        'c',
        `${CAPTCHA_REFERER}&cid=url-bound%2Bcookie%2Fvalue%3D`,
        'stale-target-cookie'
      ),
      'url-bound+cookie/value='
    );
  });

  it('preserves the target cookie for interstitials', () => {
    assert.equal(
      solverCookieForChallengeDocument(
        'i',
        `${GEO_ORIGIN}/interstitial/?initialCid=active-cid`,
        'target-cookie'
      ),
      'target-cookie'
    );
  });

  it('rejects missing, duplicate, and noncanonical captcha cid URLs', () => {
    for (const url of [
      CAPTCHA_REFERER,
      `${CAPTCHA_REFERER}&cid=first&cid=second`,
      `${GEO_ORIGIN}:444/captcha/?cid=value`,
      'not a URL',
    ]) {
      assert.throws(() =>
        solverCookieForChallengeDocument('c', url, 'target-cookie')
      );
    }
  });
});

describe('solver response validation', () => {
  const interstitialBody =
    'cid=active-cid&hash=ACTIVEHASH&payload=sandbox-payload&plv3=sandbox-wire';
  const interstitialRaw = {
    body: interstitialBody,
    origin: GEO_ORIGIN,
    referer: `${GEO_ORIGIN}/interstitial/?initialCid=active-cid`,
    url: `${GEO_ORIGIN}/interstitial/`,
  };
  const captchaRaw = {
    origin: GEO_ORIGIN,
    referer: CAPTCHA_REFERER,
    url: captchaCarrierUrl('sandbox-payload', 'sandbox-wire'),
  };

  it('returns a discriminated interstitial result with required body', () => {
    assert.deepEqual(validateSolverResult(interstitialRaw, 'i'), {
      ...interstitialRaw,
      type: 'interstitial',
    });
  });

  it('accepts absent or null body for captcha results', () => {
    const expected = {
      ...captchaRaw,
      type: 'captcha',
    };
    assert.deepEqual(validateSolverResult(captchaRaw, 'c'), expected);
    assert.deepEqual(
      validateSolverResult({ ...captchaRaw, body: null }, 'c'),
      expected
    );
  });

  it('rejects the wrong carrier shape for the active challenge', () => {
    assert.throws(
      () => validateSolverResult({ ...interstitialRaw, body: undefined }, 'i'),
      /omitted its body/
    );
    assert.throws(
      () =>
        validateSolverResult({ ...captchaRaw, body: interstitialBody }, 'c'),
      /unexpectedly contained a body/
    );
    assert.throws(
      () =>
        validateSolverResult(
          {
            ...captchaRaw,
            url: `${GEO_ORIGIN}/unexpected`,
          },
          'c'
        ),
      /unexpected captcha URL/
    );
    assert.throws(
      () =>
        validateSolverResult(
          { ...captchaRaw, origin: 'https://bad.test' },
          'c'
        ),
      /incomplete/
    );
  });
});

describe('solver HTTP errors', () => {
  it('reports only the bounded JSON error detail', async () => {
    const originalFetch = globalThis.fetch;
    const detail = `deployed-validation-${'x'.repeat(1200)}`;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: detail, ignored: 'unselected-response-field' }),
        { status: 422 }
      );
    const page = {
      context: () => ({ browser: () => ({}) }),
    } as unknown as Page;

    try {
      await assert.rejects(
        solveDataDome(page, {
          solverUrl: 'http://solver.example.test:3000',
          timeout: 1000,
          url: 'https://shop.example.test/product',
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          const prefix = '/hc returned HTTP 422: ';
          assert.ok(error.message.startsWith(prefix));
          assert.equal(error.message.length, prefix.length + 1000);
          assert.doesNotMatch(error.message, /unselected-response-field/);
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
