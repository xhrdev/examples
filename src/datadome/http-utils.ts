/**
 * This is a helper library, not a script. It holds the request-building and
 * response-parsing shared by the browser-free examples, so each of those
 * files shows only its own HTTP client:
 *
 *   grainger-undici.ts  undici
 *   grainger-axios.ts   axios + axios-cookiejar-support
 *   grainger-fetch.ts   Node's built-in fetch, no dependencies
 *
 * The browser identity itself lives in profile.ts, which solver.ts shares.
 *
 * The challenge handling is identical in all three. Pick the file that matches
 * the client you already use; see src/datadome/README.md for the flow.
 */
import { GEO_ORIGIN, PROFILE, PROFILE_ID } from '#src/datadome/profile.js';
import { pinSession } from '#src/proxy.js';
import {
  RATE_LIMIT_EXIT_CODE,
  RateLimitError,
  reportRateLimit,
} from '#src/rate-limit.js';

const DEFAULT_URL = 'https://www.grainger.com/';
const SOLVER_PORT = 3000;

export const TIMEOUT_MS = 120_000;

/**
 * A coherent Chrome-on-macOS identity. Every field the solver receives has to
 * agree with the headers you actually send — DataDome cross-checks them, so
 * changing the user agent here without changing `navigationHeaders` is the
 * most common way to get a solve rejected.
 */

/** Everything an attempt needs, already resolved from the environment. */
export type Context = {
  proxy: string;
  solverApiKey: string | undefined;
  solverUrl: string;
  targetUrl: string;
};

/** The inline `var dd = {...}` object DataDome embeds in its block page. */
export type DataDomeBlock = {
  b?: number;
  cid: string;
  cookie: string;
  e?: string;
  hsh: string;
  rt: 'c' | 'i';
  s?: number;
  t?: string;
};

/** What an attempt reports back when it succeeds. */
export type Outcome = {
  cookie: string;
  status: number;
  title?: string | undefined;
};

/** What `/dd/solve` hands back: a request for you to make. */
export type PreparedSubmission = {
  body?: string;
  origin: string;
  referer: string;
  url: string;
};

export const log = (message: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${message}`, ...extra);

export const navigationHeaders = (): Record<string, string> => ({
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

/** Headers for fetching the challenge document, which loads in an iframe. */
export const documentHeaders = (targetUrl: string): Record<string, string> => ({
  ...navigationHeaders(),
  referer: targetUrl,
  'sec-fetch-dest': 'iframe',
  'sec-fetch-site': 'cross-site',
});

/** Headers for the final submission back to DataDome. */
export const submissionHeaders = (
  prepared: PreparedSubmission
): Record<string, string> => ({
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  origin: prepared.origin,
  referer: prepared.referer,
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
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
  if (!dd.cid || !dd.hsh || !dd.cookie || (dd.rt !== 'c' && dd.rt !== 'i')) {
    return null;
  }
  return dd as DataDomeBlock;
};

/** Rebuild the challenge document URL exactly as DataDome's c.js would. */
export const challengeDocumentUrl = (
  dd: DataDomeBlock,
  targetUrl: string
): string => {
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
  return url.href;
};

/**
 * `/dd/solve` never submits for you — it returns a prepared submission.
 * DataDome binds the clearance cookie to whichever IP submitted it, so a
 * cookie the solver earned would be void from your address.
 */
export const solveEndpoint = (solverUrl: string): string =>
  new URL('/dd/solve', solverUrl).href;

export const solveRequestBody = ({
  dd,
  documentHtml,
  documentUrl,
  proxy,
  targetUrl,
}: {
  dd: DataDomeBlock;
  documentHtml: string;
  documentUrl: string;
  proxy: string;
  targetUrl: string;
}): Record<string, unknown> => ({
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
  iframeData: { html: documentHtml, url: documentUrl },
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
});

export const checkPreparedSubmission = (
  prepared: PreparedSubmission
): PreparedSubmission => {
  if (prepared.origin !== GEO_ORIGIN) {
    throw new Error(`solver returned an unexpected origin: ${prepared.origin}`);
  }
  return prepared;
};

/**
 * DataDome answers a submission with a full Set-Cookie string; we only want
 * the value. A response without one means it rejected the solve.
 */
export const readClearanceCookie = (responseBody: string): string => {
  const issued = (JSON.parse(responseBody) as { cookie?: string }).cookie;
  if (!issued) {
    throw new Error(
      `DataDome rejected the solve: ${responseBody.slice(0, 300)}`
    );
  }
  const [pair = ''] = issued.split(';');
  return pair.replace(/^datadome=/, '');
};

export const pageTitle = (html: string): string | undefined =>
  /<title>([^<]*)/.exec(html)?.[1]?.trim();

const readFlag = (name: string): string | undefined =>
  process.argv
    .find((arg) => arg.startsWith(`${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');

/**
 * Residential pools hand out the occasional dead exit node, which surfaces as
 * a transport error before we ever reach DataDome. Those are not solve
 * failures — take a new session and try again.
 */
const isTransport = (error: unknown): boolean =>
  (error instanceof TypeError && error.message === 'fetch failed') ||
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|Client network/i.test(
    (error as Error)?.message ?? ''
  );

/**
 * Shared entry point: reads the environment, pins a fresh proxy session per
 * attempt, runs `attempt`, and reports the result the way every other example
 * in this repo does.
 *
 * There is one proxy pool, `proxy`. Each attempt pins a fresh session, so a
 * dead exit node is retried on a new IP rather than failing the run.
 *
 * `--require-challenge` turns "nothing challenged us" into a failure. CI passes
 * it so the smoke gate cannot go green without actually exercising a solve.
 */
export const run = async (
  // eslint-disable-next-line no-unused-vars -- function-type parameter
  attempt: (context: Context) => Promise<null | Outcome>
): Promise<void> => {
  const solverHost = process.env['host'];
  const configuredProxy = process.env['proxy'];
  if (!solverHost) throw new Error('set host= in .env');
  if (!configuredProxy) throw new Error('set proxy= in .env');

  const attempts = Number(readFlag('--attempts') ?? 3);
  const targetUrl = readFlag('--url') ?? DEFAULT_URL;
  const solverUrl = `http://${solverHost}:${SOLVER_PORT}`;
  const requireChallenge = process.argv.includes('--require-challenge');

  const label = 'PROXY';

  let lastError: unknown;
  let sawNoChallenge = false;

  for (let i = 1; i <= attempts; i += 1) {
    // A fresh session per attempt: a new IP, and a clean slate with DataDome.
    const { url: proxy } = pinSession(configuredProxy);
    try {
      const outcome = await attempt({
        proxy,
        solverApiKey: process.env['api_key'],
        solverUrl,
        targetUrl,
      });

      if (!outcome) {
        sawNoChallenge = true;
        if (requireChallenge) {
          process.exitCode = 1;
          log(`${label} = NO CHALLENGE`);
          log('RESULT: FAIL - no challenge and --require-challenge was set');
          return;
        }
        log(`${label} = NO CHALLENGE`);
        log('RESULT: no challenge to solve');
        return;
      }
      if (outcome.status !== 200) {
        throw new Error(`verification failed: HTTP ${outcome.status}`);
      }
      log(`${label} = SOLVED`);
      log('RESULT: SUCCESS');
      return;
    } catch (error) {
      // A 429 is not retryable: the budget is already spent, and every retry
      // spends more of it. Stop the loop here rather than burning the other
      // attempts to arrive at the same answer.
      if (error instanceof RateLimitError) {
        process.exitCode = RATE_LIMIT_EXIT_CODE;
        log(`${label} = RATE LIMITED`);
        reportRateLimit(error);
        return;
      }
      lastError = error;
      if (isTransport(error)) {
        const more = i < attempts ? ', NOW RETRYING' : '';
        log(`${label} = DEAD NODE (attempt ${i}/${attempts})${more}`);
      } else {
        const more = i < attempts ? ' — retrying' : '';
        log(
          `${label} = attempt ${i}/${attempts} failed (${(error as Error).message})${more}`
        );
      }
    }
  }

  process.exitCode = 1;
  const reason = isTransport(lastError)
    ? 'proxy session failed'
    : ((lastError as Error)?.message ??
      (sawNoChallenge ? 'no challenge' : 'unknown'));
  log(`RESULT: FAIL - ${reason}`);
};
