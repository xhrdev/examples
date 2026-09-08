/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sbsd/aircanada-lightpanda.ts
 *
 * `aircanada.ts` with **Lightpanda** in place of Chrome — the same shape of
 * swap `comcast-lightpanda.ts` does for the sensor lane. It only became worth
 * trying once the ledger request stopped needing `speechSynthesis` voices
 * (see the header on `solver.ts`): that was the one reading no headless
 * runner could ever supply, sensor or SBSD alike, and with it gone there is
 * nothing left in the request that a JS-and-DOM engine without a renderer
 * cannot produce.
 *
 * aircanada.com rather than aa.com because it is the simpler of the two SBSD
 * examples: it does not gate its document on `_abck` (see `aircanada.ts`'s
 * header for why `sensor: 'page'` is set below), so there is no WebSocket
 * session in this file at all — SBSD is the whole test.
 *
 * `attach()` needs the same two things `solve()` needed to run against
 * Lightpanda, for the same reasons:
 *
 *   - **`fetchResponse`**, because Playwright's `route.fetch` never returns
 *     here — it runs in Playwright's request context, which stops answering
 *     once Lightpanda is involved, and every later `route.fetch` (the SBSD
 *     bundle fetch included) then waits out its timeout with no ledger ever
 *     requested. `src/mitm.ts` fetches it instead, from the same address with
 *     the same headers, and applies the cookies its responses set (`solver.ts`
 *     cannot rely on `route.fetch` to do that for it on this path).
 *   - **`readHtml`**, because `page.content()` never resolves either.
 *     `outerHtml()` reads the DOM through `evaluate` instead.
 *
 * This has not been measured against a live target the way `aircanada.ts` has
 * — it is the shape the port takes, not a proven result yet. Run it against
 * your own solver to find out; the things worth watching are the same ones
 * `comcast-lightpanda.ts` called out for the sensor lane: the identity on the
 * wire, cookies surviving the bundle script's response, and whether
 * `getByRole` below resolves at all — Lightpanda's accessibility-tree support
 * is the one piece neither the sensor nor the SBSD port has exercised before.
 */
import { PROFILE, SEC_CH_UA } from '#src/profile.js';
import { attach } from '#src/akamai/sbsd/solver.js';
import { outerHtml, start } from '#src/lightpanda.js';
import {
  RATE_LIMIT_EXIT_CODE,
  RateLimitError,
  reportRateLimit,
} from '#src/rate-limit.js';

const ORIGIN = 'https://www.aircanada.com';
const url = `${ORIGIN}/ca/en/aco/home.html`;
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
 * Same landmark aircanada.ts waits on: the first document is a bootstrap
 * that reloads itself once its SBSD carrier is answered, and there is no
 * page element to wait for that only exists on the real one.
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
  // SBSD only, same as aircanada.ts: the page answers its own _abck.
  sensor: 'page',
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
  log(`SBSD carriers answered: ${akamai.carriersAnswered()}`);

  await page
    .getByRole('heading', { name: /where can we take you/iu })
    .first()
    .waitFor({ timeout: 60_000 });

  const title = await page.title();
  log(`Final URL: ${page.url()}`);
  log(`RESULT: SUCCESS - Akamai solved, reached "${title}"`);
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
