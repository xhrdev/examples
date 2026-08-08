/**
 * DataDome clearance cookies for grainger.com — no browser required.
 *
 * `grainger.ts` drives a real Chrome via Playwright. This script does the same
 * job with nothing but `fetch`, which is what you want when you are running at
 * scale, in a container, or inside an existing HTTP scraper.
 *
 * The flow is four requests:
 *
 *   1. GET the target. DataDome answers 403 with a small HTML page carrying an
 *      inline `var dd = {...}` object and a `datadome` cookie.
 *   2. GET the challenge document from geo.captcha-delivery.com. The solver
 *      needs its HTML to read the challenge parameters.
 *   3. POST /dd/solve?submit=false to xhr.dev. It returns a *prepared*
 *      submission — the exact URL to call, plus Origin/Referer to send with it.
 *   4. Call that URL yourself. DataDome replies with the clearance cookie.
 *
 * Why `submit=false` matters
 * --------------------------
 * `/dd/solve` defaults to `submit=true`, where the solver posts the payload
 * itself and hands you back a cookie. That is fine for a quick test, but
 * DataDome binds the clearance cookie to the IP that submitted it. If the
 * solver submits, the cookie is bound to the solver's IP and it will not work
 * from yours — you get a fresh 403 on the very next request.
 *
 * So: pass `submit=false` and make the final call from the same egress IP you
 * will use for scraping. Everything below shares one proxy session for exactly
 * that reason.
 *
 * Run with:
 *
 *   node --env-file=.env src/datadome/grainger-http.ts
 *   node --env-file=.env src/datadome/grainger-http.ts --url=https://www.grainger.com/category/pumps
 */
// undici's `fetch` is the same implementation Node exposes globally, but its
// types expose `dispatcher`, which is how a per-request proxy is set.
import { fetch, ProxyAgent } from 'undici';

import { pinSession } from '#src/proxy.js';

const GEO_ORIGIN = 'https://geo.captcha-delivery.com';
const DEFAULT_URL = 'https://www.grainger.com/';
const SOLVER_PORT = 3000;
const TIMEOUT_MS = 120_000;

/**
 * A coherent Chrome-on-macOS identity. Every field the solver receives has to
 * agree with the headers you actually send — DataDome cross-checks them, so
 * changing the user agent here without changing `navigationHeaders` below is
 * the most common way to get a solve rejected.
 */
const PROFILE = {
  brands: [
    { brand: 'Google Chrome', version: '149' },
    { brand: 'Chromium', version: '149' },
    { brand: 'Not)A;Brand', version: '24' },
  ],
  chromeFullVersion: '149.0.7827.201',
  chromeVersion: '149',
  deviceMemory: 32,
  hardwareConcurrency: 10,
  languages: 'en-US,en',
  os: 'macos',
  platformVersion: '26.5.2',
  screen: {
    availHeight: 948,
    availLeft: 0,
    availTop: 0,
    availWidth: 1512,
    colorDepth: 30,
    devicePixelRatio: 2,
    height: 982,
    innerHeight: 761,
    innerWidth: 1200,
    outerHeight: 904,
    outerWidth: 1200,
    pixelDepth: 30,
    screenX: 0,
    screenY: 143,
    width: 1512,
  },
  timezone: 'America/New_York',
  timezoneOffsetMinutes: 240,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  vendor: 'Google Inc.',
} as const;

const PROFILE_ID = `chrome-${PROFILE.chromeVersion}-${PROFILE.os}`;

export type ClearanceResult = {
  /** The bare `datadome` cookie value, ready to put in a Cookie header. */
  cookie: string;
  /** The egress IP the cookie is bound to. Reuse it or the cookie is void. */
  proxy: string;
};

/** The inline `var dd = {...}` object DataDome embeds in its block page. */
type DataDomeBlock = {
  b?: number;
  cid: string;
  cookie: string;
  e?: string;
  hsh: string;
  rt: 'c' | 'i';
  s?: number;
  t?: string;
};

/** What `/dd/solve?submit=false` hands back: a request for you to make. */
type PreparedSubmission = {
  body?: string;
  origin: string;
  referer: string;
  url: string;
};

const log = (message: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${message}`, ...extra);

const navigationHeaders = (): Record<string, string> => ({
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': PROFILE.brands
    .map(({ brand, version }) => `"${brand}";v="${version}"`)
    .join(', '),
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent': PROFILE.userAgent,
});

/**
 * Pull the `var dd = {...}` literal out of a 403 body. Returns null when the
 * page is not a DataDome block — i.e. you were not challenged at all.
 */
export const parseBlockPage = (html: string): DataDomeBlock | null => {
  const match = /var\s+dd\s*=\s*(\{[^}]*\})/.exec(html);
  if (!match?.[1]) return null;
  // The literal uses single quotes, which JSON.parse rejects. No value in a
  // DataDome block contains a quote, so this swap is safe.
  const parsed: unknown = JSON.parse(match[1].replace(/'/g, '"'));
  if (typeof parsed !== 'object' || parsed === null) return null;
  const dd = parsed as Partial<DataDomeBlock>;
  if (!dd.cid || !dd.hsh || !dd.cookie || (dd.rt !== 'c' && dd.rt !== 'i'))
    return null;
  return dd as DataDomeBlock;
};

/** Rebuild the challenge document URL exactly as DataDome's c.js would. */
const challengeDocumentUrl = (dd: DataDomeBlock, targetUrl: string): URL => {
  const url = new URL(
    dd.rt === 'c' ? '/captcha/' : '/interstitial/',
    GEO_ORIGIN
  );
  url.searchParams.set('initialCid', dd.cid);
  url.searchParams.set('hash', dd.hsh);
  url.searchParams.set('cid', dd.cookie);
  url.searchParams.set('t', dd.t ?? 'fe');
  url.searchParams.set('referer', targetUrl);
  url.searchParams.set('s', String(dd.s ?? 0));
  if (dd.e) url.searchParams.set('e', dd.e);
  url.searchParams.set('dm', 'cd');
  return url;
};

/**
 * Solve whatever DataDome is serving on `targetUrl` and return a clearance
 * cookie bound to `proxy`'s egress IP.
 */
export const getClearance = async ({
  proxy,
  solverApiKey,
  solverUrl,
  targetUrl,
}: {
  proxy: string;
  solverApiKey?: string;
  solverUrl: string;
  targetUrl: string;
}): Promise<ClearanceResult | null> => {
  const dispatcher = new ProxyAgent(proxy);
  const headers = navigationHeaders();

  // 1. Trip the challenge.
  log(`GET ${targetUrl}`);
  const blocked = await fetch(targetUrl, { dispatcher, headers });
  const blockedHtml = await blocked.text();
  log(`  <- HTTP ${blocked.status} (${blockedHtml.length} bytes)`);

  const dd = parseBlockPage(blockedHtml);
  if (!dd) {
    log('  no DataDome challenge — the request went straight through');
    return null;
  }
  log(
    `  challenge: type=${dd.rt === 'c' ? 'captcha' : 'interstitial'} cid=${dd.cid}`
  );

  // 2. Fetch the challenge document the solver needs to read.
  const documentUrl = challengeDocumentUrl(dd, targetUrl);
  log(`GET ${documentUrl.pathname} (challenge document)`);
  const document = await fetch(documentUrl.href, {
    dispatcher,
    headers: {
      ...headers,
      referer: targetUrl,
      'sec-fetch-dest': 'iframe',
      'sec-fetch-site': 'cross-site',
    },
  });
  const documentHtml = await document.text();
  log(`  <- HTTP ${document.status} (${documentHtml.length} bytes)`);

  // 3. Ask xhr.dev to build the submission — but not to send it. See the note
  //    at the top of this file for why we keep ownership of the submit.
  log('POST /dd/solve?submit=false');
  const solve = await fetch(new URL('/dd/solve?submit=false', solverUrl).href, {
    body: JSON.stringify({
      dd: {
        ...(dd.b === undefined ? {} : { b: dd.b }),
        cid: dd.cid,
        ...(dd.e === undefined ? {} : { e: dd.e }),
        hsh: dd.hsh,
        rt: dd.rt,
        s: dd.s ?? 0,
        ...(dd.t === undefined ? {} : { t: dd.t }),
      },
      ddCookie: dd.cookie,
      iframeData: { html: documentHtml, url: documentUrl.href },
      js_profile: {
        brands: PROFILE.brands,
        chromeFullVersion: PROFILE.chromeFullVersion,
        chromeVersion: PROFILE.chromeVersion,
        deviceMemory: PROFILE.deviceMemory,
        hardwareConcurrency: PROFILE.hardwareConcurrency,
        languages: PROFILE.languages,
        os: PROFILE.os,
        platformVersion: PROFILE.platformVersion,
        screen: PROFILE.screen,
        timezone: PROFILE.timezone,
        timezoneOffsetMinutes: PROFILE.timezoneOffsetMinutes,
        vendor: PROFILE.vendor,
      },
      profile: {
        chromeFullVersion: PROFILE.chromeFullVersion,
        httpHeaderTemplates: { form: [], iframe: [], image: [], xhr: [] },
        id: PROFILE_ID,
        os: PROFILE.os,
        timezone: PROFILE.timezone,
        timezoneOffsetMinutes: PROFILE.timezoneOffsetMinutes,
        tlsClientHello: '',
        userAgent: PROFILE.userAgent,
      },
      proxy,
      timeout: TIMEOUT_MS,
      url: targetUrl,
    }),
    headers: {
      'content-type': 'application/json',
      ...(solverApiKey ? { 'x-api-key': solverApiKey } : {}),
    },
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!solve.ok) {
    throw new Error(
      `solver returned HTTP ${solve.status}: ${(await solve.text()).slice(0, 300)}`
    );
  }
  const prepared = (await solve.json()) as PreparedSubmission;
  if (prepared.origin !== GEO_ORIGIN) {
    throw new Error(`solver returned an unexpected origin: ${prepared.origin}`);
  }
  log('  <- prepared submission for /captcha/check');

  // 4. Submit it ourselves, over the same proxy session, so DataDome binds the
  //    cookie to an IP we actually control. Captcha solves carry their payload
  //    in the query string (GET); interstitials post a body.
  log(`${prepared.body ? 'POST' : 'GET'} geo.captcha-delivery.com (submit)`);
  const submitted = await fetch(prepared.url, {
    ...(prepared.body === undefined ? {} : { body: prepared.body }),
    dispatcher,
    headers: {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      origin: prepared.origin,
      referer: prepared.referer,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': PROFILE.userAgent,
    },
    method: prepared.body === undefined ? 'GET' : 'POST',
  });
  const submittedBody = await submitted.text();
  log(`  <- HTTP ${submitted.status}`);

  const issued = (JSON.parse(submittedBody) as { cookie?: string }).cookie;
  if (!issued) {
    throw new Error(
      `DataDome rejected the solve: ${submittedBody.slice(0, 300)}`
    );
  }

  // The response is a full Set-Cookie string; we only want the value.
  const [pair = ''] = issued.split(';');
  return { cookie: pair.replace(/^datadome=/, ''), proxy };
};

const readFlag = (name: string): string | undefined =>
  process.argv
    .find((arg) => arg.startsWith(`${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');

const solverHost = process.env['host'];
const configuredProxy = process.env['proxy'];
const solverApiKey = process.env['solver_api_key'];
if (!solverHost) throw new Error('set host= in .env');
if (!configuredProxy) throw new Error('set proxy= in .env');

const targetUrl = readFlag('--url') ?? DEFAULT_URL;
const attempts = Number(readFlag('--attempts') ?? 3);
const solverUrl = `http://${solverHost}:${SOLVER_PORT}`;

/**
 * Residential pools hand out the occasional dead exit node, which surfaces as
 * a `fetch failed` before we ever reach DataDome. Those are not solve failures
 * — just take a new session and try again.
 */
const isTransport = (error: unknown): boolean =>
  error instanceof TypeError && error.message === 'fetch failed';

let lastError: unknown;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  // A fresh session per attempt: a new IP, and a clean slate with DataDome.
  const { url: proxy } = pinSession(configuredProxy);
  try {
    const result = await getClearance({
      proxy,
      ...(solverApiKey ? { solverApiKey } : {}),
      solverUrl,
      targetUrl,
    });

    if (!result) {
      log('RESULT: no challenge to solve');
      break;
    }

    log(`clearance cookie: datadome=${result.cookie}`);

    // Prove it: the same request that 403'd should now return the real page.
    log('verifying against the target');
    const verified = await fetch(targetUrl, {
      dispatcher: new ProxyAgent(result.proxy),
      headers: { ...navigationHeaders(), cookie: `datadome=${result.cookie}` },
    });
    const html = await verified.text();
    const title = /<title>([^<]*)/.exec(html)?.[1]?.trim();
    log(`  <- HTTP ${verified.status} (${html.length} bytes) "${title ?? ''}"`);

    if (verified.status !== 200)
      throw new Error(`verification failed: HTTP ${verified.status}`);
    log('RESULT: SUCCESS');
    lastError = undefined;
    break;
  } catch (error) {
    lastError = error;
    const reason = isTransport(error)
      ? 'proxy session failed'
      : (error as Error).message;
    if (attempt < attempts)
      log(`attempt ${attempt}/${attempts} failed (${reason}) — retrying`);
  }
}

if (lastError) {
  process.exitCode = 1;
  const reason = isTransport(lastError)
    ? 'proxy session failed'
    : (lastError as Error).message;
  log(`RESULT: FAIL - ${reason}`);
}
