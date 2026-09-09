/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sensor/ca-edd-lightpanda.ts
 *
 * `ca-edd.ts` with **Lightpanda** in place of Chrome. The sensor lane's second
 * target, alongside `comcast-lightpanda.ts`, and it needed nothing new — the
 * four things that file works around are properties of Lightpanda rather than
 * of comcast.com, so they carry over verbatim:
 *
 *   1. the traffic is re-originated through `src/mitm.ts`, which also supplies
 *      the identity — Lightpanda's user agent cannot be set from inside the
 *      browser, and `ca-edd.ts` installs its own with a CDP session, which
 *      crashes Playwright here.
 *   2. the identity is pinned to the profile the solver models, rather than
 *      left to the proxy's own default.
 *   3. `fetchResponse: session.mitm.fetch`, because Playwright's `route.fetch`
 *      never returns against Lightpanda.
 *   4. cookies applied by hand on that path, which `solver.ts` already does.
 *
 * ## measured 2026-09-09: it solves, but only about half the time
 *
 * Six runs here against four of `ca-edd.ts` on the same ISP exit inside the
 * same hour:
 *
 * | lane | passed | rounds on a pass | rounds on a fail |
 * |---|---|---|---|
 * | Lightpanda (this file) | 3/6 | 5, 5, 5 | 14, 15, 16 → 120s timeout |
 * | Chrome (`ca-edd.ts`) | 4/4 | 5, 5, 5, 5 | — |
 *
 * So the swap is not free on this target, and the gap is the point of this
 * note. A pass is indistinguishable from Chrome — `_abck` accepted on round 5,
 * the same round, reaching the same MFA login page. A fail is not a different
 * error, it is the same run going on and on: rounds keep being served and
 * scored `~-1~` until the solver's acceptance timeout ends it.
 *
 * That shape — clean pass or grind to the timeout, nothing in between — is
 * what a scoring decision looks like from here, rather than a bug in the swap.
 * What has NOT been separated is whether it is Lightpanda's telemetry being
 * scored lower or simply this origin being stricter than comcast: the same six
 * runs on comcast would settle it, and have not been run. Do not read the 3/6
 * as a property of Lightpanda in general — `comcast-lightpanda.ts` has not
 * shown this.
 *
 * Retry rather than treat one failure as a regression, and check the Chrome
 * script before blaming this one.
 *
 * Two differences from comcast that are this target's own:
 *
 *   - **The exit IP has to be residential or ISP.** eddservices.edd.ca.gov
 *     refuses datacentre pools on the CONNECT tunnel, before any of this runs
 *     — see the note on `proxy=` in `.env`. That is unrelated to Lightpanda
 *     and bites the Chrome script identically.
 *   - **No settle sleep.** `ca-edd.ts` sleeps 7s after the solve because the
 *     page keeps navigating under Chrome. Here the DOM is read through
 *     `outerHtml` once `solve()` returns and that has been enough; the sleep
 *     is left out rather than carried over untested.
 *
 * Like `ca-edd.ts` this stops at the login page and does not sign in. Signing
 * in would exercise CA EDD's auth rather than the solver, and risks the
 * account for no extra signal.
 */
import { PROFILE, SEC_CH_UA } from '#src/profile.js';
import { solve } from '#src/akamai/sensor/solver.js';
import { solverWsUrl } from '#src/solver-url.js';
import { outerHtml, start } from '#src/lightpanda.js';
import {
  RATE_LIMIT_EXIT_CODE,
  RateLimitError,
  reportRateLimit,
} from '#src/rate-limit.js';

const url = 'https://eddservices.edd.ca.gov/tap/secure/eservices';
const solverHost = process.env['host'];
const proxy = process.env['proxy'];
const solverApiKey = process.env['api_key'];

if (!solverHost) throw new Error('set host= in .env');

const solverUrl = solverWsUrl(solverHost, '/akamai/session');
const timeout = Number(process.env['AKAMAI_TIMEOUT_MS'] ?? 120_000);

const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

/**
 * What the MITM proxy claims upstream — the browser the Akamai solver models,
 * the same identity `ca-edd.ts` installs with `applyIdentity`. Letting the
 * proxy fall back to its own default trusts two registries to stay in step;
 * when they drift the telemetry names one Chrome and the headers name another,
 * and `_abck` sits at `~-1~` for as many rounds as you give it.
 */
const IDENTITY = {
  'sec-ch-ua': SEC_CH_UA,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'user-agent': PROFILE.userAgent,
};

const session = await start({
  identity: IDENTITY,
  log,
  ...(proxy ? { proxy } : {}),
});
let exitCode = 0;

process.once('SIGINT', () => {
  log('Caught SIGINT');
  void session.stop().then(() => process.exit(0));
});
process.once('SIGTERM', () => {
  log('Caught SIGTERM');
  void session.stop().then(() => process.exit(0));
});

if (!session.mitm) throw new Error('the MITM proxy did not start');

try {
  await solve(session.page, {
    // Playwright's `route.fetch` never returns against Lightpanda, so the
    // sensor script is never captured and no session ever opens. The MITM
    // proxy fetches it instead — same dispatcher, same exit IP, same headers
    // as everything else the page sends.
    fetchResponse: session.mitm.fetch,
    // Every request on the page is refetched through the proxy, so the
    // solver's 30s/15s defaults run out before this page settles.
    loadStateTimeout: 60_000,
    navigationTimeout: 90_000,
    ...(proxy ? { proxy } : {}),
    ...(solverApiKey ? { solverApiKey } : {}),
    solverUrl,
    timeout,
    url,
  });

  log(`Final URL: ${session.page.url()}`);
  const html = await outerHtml(session.page.mainFrame());
  // The same two forms `ca-edd.ts` checks: Akamai's own block page, and the
  // bare string, which this origin also serves on its own denial page.
  const denied =
    /<H1>\s*Access Denied\s*<\/H1>/i.test(html) ||
    html.includes('Access Denied');
  if (denied) {
    exitCode = 2;
    log('RESULT: FAIL - Access Denied');
  } else {
    log('RESULT: SUCCESS - Login page accessible');
  }
} catch (error) {
  // A 429 is not a failed solve and retrying cannot help, so it gets its own
  // outcome and skips the Akamai advice below, which would mislead here.
  if (error instanceof RateLimitError) {
    exitCode = RATE_LIMIT_EXIT_CODE;
    reportRateLimit(error);
  } else {
    exitCode = 1;
    log(`RESULT: FAIL - ${(error as Error).message}`);
    log(
      'If the rounds ran but never reached ~0~, check the `cookies=[...]` ' +
        'line for `_abck` and the identity above against the solver profile. ' +
        'If no session opened at all, the sensor script was never captured — ' +
        'look for a fetch that did not return. If the run never got that far, ' +
        'check the exit IP: this origin refuses datacentre ranges outright.'
    );
  }
} finally {
  await session.stop();
}

process.exit(exitCode);
