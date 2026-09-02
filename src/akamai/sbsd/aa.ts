/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sbsd/aa.ts
 * node --env-file=.env src/akamai/sbsd/aa.ts --headless
 *
 * aa.com is the example that shows SBSD is not a `/.well-known/sbsd` feature.
 * The bundle here is served from a per-property obfuscated path, sitting right
 * next to the `_abck` sensor script under the same random prefix:
 *
 *   /bJ21n/.../fQUZPAE/Q01H/JFVIT0YB                the `_abck` sensor
 *   /bJ21n/.../K0ciPAE/NQdp/VyRmPU8Y?v=<uuid>       the SBSD bundle
 *
 * Nothing in either path names the channel. What identifies the bundle is the
 * UUID `v=` on its `src`, and `solver.ts` discovers it that way rather than
 * being told — see `isSbsdBundle` there.
 *
 * The check at the end is the flight search form. `/booking/find-flights` is
 * served as "Access Denied" to an ordinary browser, so reaching the form at
 * all is the result; an unsolved run does not get a partial version of it.
 *
 * Verified end to end: `_abck` accepted on round 6, and the search form
 * behind it. The control that makes that mean something is that aa.com serves
 * this same URL as "Access Denied" to an uninstrumented Chrome from the same
 * machine, minutes either side of the run.
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';

import { applyIdentity, USER_AGENT, VIEWPORT } from '#src/akamai/identity.js';
import {
  NO_VOICES_EXIT_CODE,
  NoVoicesError,
  requireVoices,
} from '#src/akamai/sbsd/environment.js';
import { attach } from '#src/akamai/sbsd/solver.js';
import { PROFILE } from '#src/profile.js';
import { toLaunchProxy } from '#src/proxy.js';
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
let closing = false;

const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

if (!solverHost) throw new Error('set host= in .env');

const CHROME_PATH = process.env['CHROME_PATH'] || '';
const launchOpts: Record<string, unknown> = {
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
  ],
  headless: process.argv.includes('--headless'),
  ...(proxy ? { proxy: toLaunchProxy(proxy) } : {}),
};
// eslint-disable-next-line security/detect-non-literal-fs-filename
if (CHROME_PATH && fs.existsSync(CHROME_PATH))
  launchOpts['executablePath'] = CHROME_PATH;
else launchOpts['channel'] = 'chrome';

const browser = await chromium.launch(launchOpts);
const context = await browser.newContext({
  deviceScaleFactor: PROFILE.screen.devicePixelRatio,
  locale: 'en-US',
  serviceWorkers: 'block',
  timezoneId: PROFILE.timezone,
  userAgent: USER_AGENT,
  viewport: VIEWPORT,
});
const page = await context.newPage();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The first document a protected property serves is a small Akamai bootstrap
 * that reloads itself once its SBSD carrier has been answered, so the document
 * open when `goto` resolves is usually not the one to solve `_abck` against.
 * Starting the session on it is a race the reload wins: it destroys the
 * execution context the sensor submissions are sent from, mid-round.
 *
 * hilton.ts waits for a form that only the real page has. There is no such
 * landmark here — the challenge and the page it guards can look alike until
 * `_abck` lands — so this waits for the document traffic to go quiet instead.
 * Counting documents was the first attempt and it is not enough: aa serves two
 * before it settles on some runs and three on others, and a fixed count picks
 * the wrong moment on whichever run does not match it.
 */
let lastDocumentAt = Date.now();
page.on('response', (response) => {
  const request = response.request();
  if (
    request.resourceType() === 'document' &&
    request.frame() === page.mainFrame() &&
    // Redirects are documents too, and a bounce is not a reload. A 403 is:
    // Akamai's block page is a document like any other, and it is usually the
    // one that reloads itself.
    !(response.status() >= 300 && response.status() < 400)
  )
    lastDocumentAt = Date.now();
});

async function cleanup(exitCode = 0): Promise<void> {
  if (closing) return;
  closing = true;
  const forceKill = setTimeout(() => {
    process.exit(exitCode);
  }, 5000);
  forceKill.unref();
  try {
    // Retire the route handler before the browser goes, or Playwright prints
    // the whole intercepted response back as an unhandled route-callback error.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await browser.close();
  } catch {
    // ignore
  }
  process.exit(exitCode);
}
process.on('SIGINT', () => {
  log('Caught SIGINT');
  void cleanup(0);
});
process.on('SIGTERM', () => {
  log('Caught SIGTERM');
  void cleanup(0);
});
process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}`);
  void cleanup(1);
});
process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${String(reason)}`);
  void cleanup(1);
});

const cdp = await context.newCDPSession(page);
await applyIdentity(cdp);

// Checked before anything is attempted: an environment without speech voices
// cannot produce a ledger the sandbox will accept, and a run that discovers
// that at the refusal looks like a failed solve. See sbsd/environment.ts.
try {
  await page.goto('about:blank');
  await requireVoices(page);
} catch (e) {
  if (e instanceof NoVoicesError) {
    log(`SKIP: ${e.message}`);
    await cleanup(NO_VOICES_EXIT_CODE);
  } else throw e;
}

// Installed before the first navigation: the SBSD carrier fires during the
// first document, and a router attached afterwards would miss it.
const akamai = attach(page, {
  host: solverHost,
  origin: ORIGIN,
  ...(solverApiKey ? { solverApiKey } : {}),
});

const QUIET_MS = 5000;
const settle = async (): Promise<void> => {
  const deadline = Date.now() + 60_000;
  // Two conditions, both necessary. A carrier answered says the bootstrap has
  // done its job and the reload is coming; the quiet window says it has
  // arrived. Waiting on the quiet window alone returns during the pause before
  // the carrier ever fires, which on aa.com is several seconds long.
  while (
    (akamai.carriersAnswered() === 0 ||
      Date.now() - lastDocumentAt < QUIET_MS) &&
    Date.now() < deadline
  )
    await sleep(500);
  await page.waitForLoadState('domcontentloaded');
  await sleep(1500);
};

const cookies = async (): Promise<Record<string, string>> =>
  Object.fromEntries(
    (await context.cookies(ORIGIN)).map((c) => [c.name, c.value])
  );

try {
  await page.goto(url, { timeout: 90_000, waitUntil: 'domcontentloaded' });
  await settle();
  log(`Document reached: ${page.url()}`);

  await akamai.solveAbck();
  log(`_abck accepted: ~${(await cookies())['_abck']?.split('~')[1]}~`);

  // The clearance is proven on a fresh navigation rather than on the document
  // that was already open: the first one may have been served before `_abck`
  // was accepted, and a page that renders from cache proves nothing.
  await page.goto(url, { timeout: 90_000, waitUntil: 'domcontentloaded' });

  // The search form's own <form> has no id, so the landmark is the first field
  // on it. Both are checked because the denial page is not empty — it renders
  // a header and a footer — and matching one stray input would pass on it.
  await page.locator('#matOriginAirport').waitFor({ timeout: 60_000 });
  await page.locator('#matDestinationAirport').waitFor({ timeout: 60_000 });

  const title = await page.title();
  log(`Final URL: ${page.url()}`);
  log(`RESULT: SUCCESS - Akamai solved, reached "${title}"`);
  await cleanup(0);
} catch (e) {
  if (e instanceof NoVoicesError) {
    log(`SKIP: ${e.message}`);
    await cleanup(NO_VOICES_EXIT_CODE);
  } else if (e instanceof RateLimitError) {
    reportRateLimit(e);
    await cleanup(RATE_LIMIT_EXIT_CODE);
  } else if (/access denied/iu.test(await page.content().catch(() => ''))) {
    log('RESULT: FAIL - Access Denied');
    await cleanup(2);
  } else {
    log(`ERROR: Solver failed: ${(e as Error).message}`);
    await cleanup(1);
  }
}
