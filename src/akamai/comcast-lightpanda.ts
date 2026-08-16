/**
 * Run with:
 *
 * node --env-file=.env src/akamai/comcast-lightpanda.ts
 *
 * `comcast.ts` with **Lightpanda** in place of Chrome — a headless browser
 * with no renderer, a ~70MB binary that starts in milliseconds. See
 * `src/lightpanda.ts` for how it is started and what it does differently.
 *
 * This works — `_abck` reaches `~0~` on round 5, the same round Chrome takes:
 *
 *   [https://login.xfinity.com] Cookie update: round=5 rval=0 accepted=true
 *   [https://login.xfinity.com] Cookie accepted (round 5)
 *   RESULT: SUCCESS - Akamai solved, reached /login
 *
 * `solver.ts` needs no CDP session, so it drives a Lightpanda page unchanged.
 * Four things had to be true first, and all four are set up below or in
 * `src/lightpanda.ts`. Each one failed silently, and none of them looked like
 * what it was:
 *
 *   1. **The traffic is re-originated** through `src/mitm.ts`, which also
 *      supplies the identity — Lightpanda's user agent cannot be changed from
 *      inside the browser, and `context.newCDPSession()`, which is how
 *      `comcast.ts` overrides it, crashes Playwright here.
 *   2. **The identity must be the one the Akamai solver models**
 *      (`chrome-146-macos`), not the proxy's DataDome default. Telemetry that
 *      says 146 under headers that say 149 is scored as a mismatch, and
 *      `_abck` sits at `~-1~` for as many rounds as you care to give it.
 *   3. **`fetchResponse`**, because Playwright's `route.fetch` never returns
 *      against Lightpanda: it runs in Playwright's request context, which
 *      syncs cookies with the browser, and once that stops answering every
 *      later route.fetch waits out its timeout — the sensor script included,
 *      so no session ever opens.
 *   4. **Cookies applied by hand** on that path, which `solver.ts` now does.
 *      `route.fulfill` carries one `set-cookie` header, and Akamai's document
 *      response sets four. Losing `_abck` starts the session without the
 *      cookie the whole protocol advances: Akamai then returns the *same*
 *      `_abck` to every submission, and the rounds count up forever. The
 *      `cookies=[...]` line each session logs is what makes this visible —
 *      compare it against a Chrome run and the missing name is right there.
 *
 * Two more that look like bugs and are not, both handled in
 * `src/lightpanda.ts` and below: Lightpanda's 1MB default CDP message cap
 * (one 1MB analytics bundle silently drops the connection), and the solver's
 * 30s/15s navigation defaults, which a page this heavy overruns.
 */
import { solve } from '#src/akamai/solver.js';
import { outerHtml, start } from '#src/lightpanda.js';
import {
  RATE_LIMIT_EXIT_CODE,
  RateLimitError,
  reportRateLimit,
} from '#src/rate-limit.js';

const url = 'https://business.comcast.com/account/';
const solverHost = process.env['host'];
const proxy = process.env['proxy'];
const solverApiKey = process.env['api_key'];

if (!solverHost) throw new Error('set host= in .env');
if (!proxy) throw new Error('set proxy= in .env');

const solverUrl = `ws://${solverHost}:3000/akamai/session`;
const timeout = Number(process.env['AKAMAI_TIMEOUT_MS'] ?? 120_000);

const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

/**
 * What the MITM proxy claims upstream. This has to be the browser the *Akamai*
 * solver models — `profileId: 'chrome-146-macos'`, the same identity
 * `comcast.ts` installs with `Emulation.setUserAgentOverride`. The proxy's
 * default is the DataDome profile, which is a different Chrome: send that and
 * the telemetry says 146 while the headers say 149, and `_abck` sits at `~-1~`
 * however many rounds you give it.
 */
const IDENTITY = {
  'sec-ch-ua':
    '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
};

const session = await start({ identity: IDENTITY, log, proxy });
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
    // The one change that makes this run at all. Playwright's `route.fetch`
    // never returns against Lightpanda, so the sensor script is never
    // captured and no session ever opens. The MITM proxy in front of the
    // browser can fetch it instead — same dispatcher, same exit IP, same
    // Chrome headers as everything else the page sends.
    fetchResponse: session.mitm.fetch,
    // Lightpanda is slower than Chrome under interception — every request on
    // the page is refetched through the proxy, and comcast.com pulls a lot of
    // script — so the defaults (30s/15s) run out before the page settles.
    loadStateTimeout: 60_000,
    navigationTimeout: 90_000,
    proxy,
    ...(solverApiKey ? { solverApiKey } : {}),
    solverUrl,
    timeout,
    url,
  });

  // The goal is a real page rather than Akamai's block — not a completed
  // login, which would need credentials this repo does not carry.
  log(`Final URL: ${session.page.url()}`);
  const html = await outerHtml(session.page.mainFrame());
  const denied = /access denied/i.test(html);
  if (denied) {
    exitCode = 2;
    log('RESULT: FAIL - Access Denied');
  } else {
    log(
      `RESULT: SUCCESS - Akamai solved, reached ${new URL(session.page.url()).pathname}`
    );
  }
} catch (error) {
  // A 429 is not a failed solve and retrying cannot help. Report it as its own
  // outcome and skip the Akamai-specific advice below, which would be
  // misleading here: nothing was wrong with the sensor or the identity.
  if (error instanceof RateLimitError) {
    exitCode = RATE_LIMIT_EXIT_CODE;
    reportRateLimit(error);
  } else {
    exitCode = 1;
    log(`RESULT: FAIL - ${(error as Error).message}`);
    // The two failures worth telling apart, because they look identical
    // from here and have nothing to do with each other.
    log(
      'If the rounds ran but never reached ~0~, check the `cookies=[...]` ' +
        'line for `_abck` and the identity above against the solver profile. ' +
        'If no session opened at all, the sensor script was never captured — ' +
        'look for a fetch that did not return.'
    );
  }
} finally {
  await session.stop();
}

process.exit(exitCode);
