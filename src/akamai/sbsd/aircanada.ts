/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sbsd/aircanada.ts
 * node --env-file=.env src/akamai/sbsd/aircanada.ts --headless
 *
 * aircanada.com is the SBSD-only example, and the one that shows why the two
 * channels are worth thinking about separately.
 *
 * Like `aa.ts`, it serves the SBSD bundle from an obfuscated per-property path
 * rather than `/.well-known/sbsd`, discovered the same way. Unlike aa.com, it
 * does not gate this document on `_abck`: an ordinary Chrome is served the
 * booking page with `_abck=~-1~`, and leaving it there is the steady state
 * rather than a failure. Solving the sensor here buys nothing — 35 rounds of
 * it changed neither the cookie nor the page — so this passes `sensor: 'page'`
 * and lets the page keep its own sensor script. The solver answers SBSD and
 * nothing else.
 *
 * Two things it is worth having an example for:
 *
 *   the entry point   `www.aircanada.com/` is an unprotected region chooser.
 *                     The application behind it is the protected part, and it
 *                     is easy to point a survey at the apex of a site and
 *                     conclude there is nothing there.
 *   `sensor: 'page'`  the default replaces the `_abck` script with a stub, so
 *                     a page that was scoring fine on its own stops the moment
 *                     you attach. If SBSD is all you came for, say so.
 *
 * The check at the end is the booking page's own heading, which means the
 * document rendered rather than being replaced by a challenge.
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

const ORIGIN = 'https://www.aircanada.com';
const url = `${ORIGIN}/ca/en/aco/home.html`;
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

const akamai = attach(page, {
  host: solverHost,
  origin: ORIGIN,
  // SBSD only: see the header. The page answers its own _abck, as it does for
  // any other browser.
  sensor: 'page',
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

  log(
    `SBSD carriers answered: ${akamai.carriersAnswered()}, ` +
      `_abck: ~${(await cookies())['_abck']?.split('~')[1]}~`
  );

  await page
    .getByRole('heading', { name: /where can we take you/iu })
    .first()
    .waitFor({ timeout: 60_000 });

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
