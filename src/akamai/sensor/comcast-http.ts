/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sensor/comcast-http.ts
 *
 * `_abck` for business.comcast.com with **nothing but Node** — no browser, no
 * Lightpanda, no WebSocket session. `POST /akamai/solve` is a different shape
 * of integration to `comcast.ts`/`comcast-lightpanda.ts`: instead of relaying
 * submissions through a live page, you hand the container a URL and a profile
 * and it fetches the sensor script, runs the rounds, and posts the payloads
 * itself — through *your* proxy, so the cookie it earns is bound to an IP you
 * actually control.
 *
 * That is also this endpoint's one hard requirement: `proxy` is optional on
 * paper (it falls back to a loopback address with nothing listening on it) but
 * practically required, because the container has to originate the sensor
 * POSTs from somewhere reachable, and that somewhere has to be the address you
 * verify from afterwards — Akamai scores `_abck` per visitor, and a cookie
 * earned by the container's own network is void from yours.
 *
 * Only one request either way, unlike DataDome's four-step dance: the
 * container does not hand back a submission for you to send — `submit: true`
 * (the default) means it already did.
 */
import { fetch, ProxyAgent } from 'undici';

import { PROFILE, PROFILE_ID, SEC_CH_UA } from '#src/profile.js';
import { solverBaseUrl } from '#src/solver-url.js';
import { pinSession } from '#src/proxy.js';
import { ACCESS_DENIED_EXIT_CODE } from '#src/access-denied.js';
import {
  checkRateLimit,
  RATE_LIMIT_EXIT_CODE,
  RateLimitError,
  reportRateLimit,
} from '#src/rate-limit.js';

const url = 'https://business.comcast.com/account/';
const solverHost = process.env['host'];
const configuredProxy = process.env['proxy'];
const solverApiKey = process.env['api_key'];

const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

if (!solverHost) throw new Error('set host= in .env');
if (!configuredProxy) {
  throw new Error(
    'set proxy= in .env — /akamai/solve submits from whatever address you ' +
      'give it, and verifying afterwards needs to go out the same address. ' +
      "Without one there is nothing for the container's submissions or your " +
      'own verification request to share.'
  );
}

const solveUrl = new URL('/akamai/solve', solverBaseUrl(solverHost)).href;

const navigationHeaders = (): Record<string, string> => ({
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': SEC_CH_UA,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent': PROFILE.userAgent,
});

type SolveResponse = {
  accepted?: boolean;
  cookie_header?: string;
  cookies?: Record<string, string>;
  error?: string;
  last_response_status?: number;
  mode?: string;
  outcome?: string;
  outcome_reason?: string;
  sensors_sent?: number;
  success: boolean;
};

const { url: proxy } = pinSession(configuredProxy);
const via = { dispatcher: new ProxyAgent(proxy) };

try {
  log(`POST /akamai/solve for ${url}`);
  const solve = await fetch(solveUrl, {
    body: JSON.stringify({
      js_profile: {
        chromeVersion: PROFILE.chromeVersion,
        deviceMemory: PROFILE.deviceMemory,
        hardwareConcurrency: PROFILE.hardwareConcurrency,
        os: PROFILE.os,
        screen: {
          height: PROFILE.screen.height,
          innerHeight: PROFILE.screen.innerHeight,
          outerHeight: PROFILE.screen.outerHeight,
          width: PROFILE.screen.width,
        },
        timezone: PROFILE.timezone,
      },
      profile: {
        chromeFullVersion: PROFILE.chromeFullVersion,
        httpHeaderTemplates: { form: [], iframe: [], image: [], xhr: [] },
        id: PROFILE_ID,
        os: PROFILE.os,
        timezone: PROFILE.timezone,
        timezoneOffsetMinutes: PROFILE.timezoneOffsetMinutes,
        // Full-version brands, not the registry's own tlsClientHello alias —
        // the solver only needs a Chrome major it recognises here.
        tlsClientHello: `chrome_${PROFILE.chromeVersion}`,
        userAgent: PROFILE.userAgent,
      },
      proxy,
      submit: true,
      url,
    }),
    headers: {
      'content-type': 'application/json',
      ...(solverApiKey ? { 'x-api-key': solverApiKey } : {}),
    },
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
  });
  checkRateLimit(solve.status, solve.headers);
  const result = (await solve.json()) as SolveResponse;
  if (!solve.ok || !result.success) {
    throw new Error(
      `solver returned HTTP ${solve.status}: ${result.error ?? JSON.stringify(result).slice(0, 300)}`
    );
  }
  log(
    `  <- accepted=${result.accepted} outcome=${result.outcome}/${result.outcome_reason} ` +
      `sensors_sent=${result.sensors_sent} _abck=~${result.cookies?.['_abck']?.split('~')[1] ?? '?'}~`
  );
  if (!result.accepted) {
    throw new Error(
      `solver did not accept the solve: ${result.outcome}/${result.outcome_reason}`
    );
  }

  // Prove it: fetch the target ourselves, same proxy, with the cookies the
  // container earned. A cookie the container is merely reporting but that
  // does not work from this address would show up here, not above.
  log('verifying against the target');
  const cookieHeader =
    result.cookie_header ??
    Object.entries(result.cookies ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  const verified = await fetch(url, {
    ...via,
    headers: { ...navigationHeaders(), cookie: cookieHeader },
  });
  const html = await verified.text();
  log(`  <- HTTP ${verified.status} (${html.length} bytes)`);

  const denied =
    verified.status >= 400 ||
    /<H1>\s*Access Denied\s*<\/H1>/i.test(html) ||
    html.includes('Access Denied');

  if (denied) {
    log('RESULT: FAIL - Access Denied');
    process.exitCode = ACCESS_DENIED_EXIT_CODE;
  } else {
    log(`RESULT: SUCCESS - Akamai solved, verified HTTP ${verified.status}`);
  }
} catch (e) {
  if (e instanceof RateLimitError) {
    reportRateLimit(e);
    process.exitCode = RATE_LIMIT_EXIT_CODE;
  } else {
    log(`ERROR: Solver failed: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
