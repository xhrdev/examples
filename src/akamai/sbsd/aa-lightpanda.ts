/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sbsd/aa-lightpanda.ts
 *
 * `aa.ts` with **Lightpanda** in place of Chrome — the same shape of swap
 * `comcast-lightpanda.ts` does for the sensor lane, and
 * `aircanada-lightpanda.ts` does for SBSD-only. This one is the harder of the
 * two SBSD ports: aa.com gates its document on `_abck` as well as SBSD, so
 * both lanes in `solver.ts` run here — the ledger POST and the WebSocket
 * session `solveAbck()` opens once the real document is up.
 *
 * `attach()` needs the same two things `solve()` needed to run against
 * Lightpanda, for the same reasons:
 *
 *   - **`fetchResponse`**, because Playwright's `route.fetch` never returns
 *     here — it runs in Playwright's request context, which stops answering
 *     once Lightpanda is involved, and every later `route.fetch` (the SBSD
 *     bundle and `_abck` sensor script fetches included) then waits out its
 *     timeout with nothing ever captured. `src/mitm.ts` fetches it instead,
 *     from the same address with the same headers, and applies the cookies
 *     its responses set (`solver.ts` cannot rely on `route.fetch` to do that
 *     for it on this path).
 *   - **`readHtml`**, because `page.content()` never resolves either.
 *     `outerHtml()` reads the DOM through `evaluate` instead.
 *
 * `solveAbck()`'s own submissions go through `page.evaluate` with a real
 * `XMLHttpRequest`, not `route.fetch` — the same path
 * `comcast-lightpanda.ts` relies on for the sensor lane, and the one part of
 * this file that is not new.
 *
 * ## measured 2026-09-08: SBSD solves, `_abck` does not
 *
 * The SBSD half works exactly like `aircanada-lightpanda.ts`: bundle
 * captured, ledger issued, carrier answered. `solveAbck()` opens a session
 * against the real sensor script too, and the exchange runs — but `_abck`
 * sat at `~-1~` through 22 rounds before this was cut off, where
 * `comcast-lightpanda.ts` reaches `~0~` on round 5 or 6 against a different
 * property. Whether that is aa.com scoring something Lightpanda's submission
 * path does differently, or aa.com being a harder sensor than Comcast's
 * regardless of browser, is not established here. `aircanada-lightpanda.ts`
 * is the one to reach for if SBSD is what you need; this file is evidence
 * that channel works on Lightpanda in general, not a working `_abck` solve
 * for aa.com specifically.
 */
import { PROFILE, SEC_CH_UA } from '#src/profile.js';
import { attach } from '#src/akamai/sbsd/solver.js';
import { outerHtml, start } from '#src/lightpanda.js';
import {
  RATE_LIMIT_EXIT_CODE,
  RateLimitError,
  reportRateLimit,
} from '#src/rate-limit.js';

const ORIGIN = 'https://www.aa.com';
const url = `${ORIGIN}/booking/find-flights`;
const solverHost = process.env['host'];
const proxy = process.env['proxy'];
const solverApiKey = process.env['api_key'];

if (!solverHost) throw new Error('set host= in .env');

const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The identity the SBSD solver was told about — see solver.ts's PROFILE_ID. */
const IDENTITY = {
  'sec-ch-ua': SEC_CH_UA,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'user-agent': PROFILE.userAgent,
};

// proxy= is optional here, same as every other Lightpanda example — with
// none set, start() and the browser both just go out from this machine.
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
const { mitm, page } = session;

/**
 * Same landmark aa.ts waits on: the first document is a bootstrap that
 * reloads itself once its SBSD carrier is answered, and there is no page
 * element to wait for that only exists on the real one — the challenge and
 * the page it guards can look alike until `_abck` lands.
 */
let lastDocumentAt = Date.now();
page.on('response', (response) => {
  const request = response.request();
  if (
    request.resourceType() === 'document' &&
    request.frame() === page.mainFrame() &&
    !(response.status() >= 300 && response.status() < 400)
  )
    lastDocumentAt = Date.now();
});

// Installed before the first navigation: the SBSD carrier fires during the
// first document, and a router attached afterwards would miss it.
const akamai = attach(page, {
  fetchResponse: mitm.fetch,
  host: solverHost,
  origin: ORIGIN,
  readHtml: () => outerHtml(page.mainFrame()),
  ...(solverApiKey ? { solverApiKey } : {}),
});

const QUIET_MS = 5000;
const settle = async (): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (
    (akamai.carriersAnswered() === 0 ||
      Date.now() - lastDocumentAt < QUIET_MS) &&
    Date.now() < deadline
  )
    await sleep(500);
  await page.waitForLoadState('domcontentloaded');
  await sleep(1500);
};

try {
  await page.goto(url, { timeout: 90_000, waitUntil: 'domcontentloaded' });
  await settle();
  log(`Document reached: ${page.url()}`);

  await akamai.solveAbck();
  log('_abck accepted');

  // Prove it on a fresh navigation, not the document already open — that one
  // may have been served before `_abck` was accepted.
  await page.goto(url, { timeout: 90_000, waitUntil: 'domcontentloaded' });
  await page.locator('#matOriginAirport').waitFor({ timeout: 60_000 });
  await page.locator('#matDestinationAirport').waitFor({ timeout: 60_000 });

  log(`Final URL: ${page.url()}`);
  log('RESULT: SUCCESS - Akamai solved, reached the search form');
} catch (error) {
  if (error instanceof RateLimitError) {
    exitCode = RATE_LIMIT_EXIT_CODE;
    reportRateLimit(error);
  } else {
    exitCode = 1;
    log(`RESULT: FAIL - ${(error as Error).message}`);
    const html = await outerHtml(page.mainFrame()).catch(() => '');
    if (/access denied/i.test(html))
      log('(the page itself says Access Denied)');
  }
} finally {
  await session.stop();
}

process.exit(exitCode);
