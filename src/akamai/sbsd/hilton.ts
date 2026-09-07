/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sbsd/hilton.ts
 * node --env-file=.env src/akamai/sbsd/hilton.ts --headless
 *
 * hilton.com runs both Akamai lanes at once, which makes it the example worth
 * having: the SBSD bundle gates the first document, and the classic `_abck`
 * sensor gates everything after it. `src/akamai/sbsd/solver.ts` handles both;
 * this file is the part that is specific to the target — where the search form
 * is, and what counts as having got through.
 *
 * The check at the end is a real hotel search, not a cookie value. `_abck`
 * reaching `~0~` says the sensor was accepted; landing on a results page says
 * the site actually served us the thing behind the challenge.
 *
 * Two things this target needs, neither of them optional:
 *
 *   headed        `--headless` does not work here. hilton refuses a headless
 *                 Chrome whatever the payloads look like, so a run that lands
 *                 on round 5 headed sits at `~-1~` past round 30 headless.
 *                 This is also why the example is not in the CI smoke suite.
 *   a fresh exit  `proxy=` is optional, but the address matters and it wears
 *                 out. One desktop address measured 2/4 direct, then 0/2 after
 *                 another handful of runs; an ISP proxy held 4/4 across the
 *                 same window. Suspect the exit before the payloads.
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';

import { applyIdentity, USER_AGENT, VIEWPORT } from '#src/akamai/identity.js';
import { attach } from '#src/akamai/sbsd/solver.js';
import { PROFILE } from '#src/profile.js';
import { toLaunchProxy } from '#src/proxy.js';
import {
  RATE_LIMIT_EXIT_CODE,
  RateLimitError,
  reportRateLimit,
} from '#src/rate-limit.js';

const ORIGIN = 'https://www.hilton.com';
const url = `${ORIGIN}/en/`;
const solverHost = process.env['host'];
const proxy = process.env['proxy'];
const solverApiKey = process.env['api_key'];
let closing = false;

const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

if (!solverHost) throw new Error('set host= in .env');

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const DESTINATION = 'Orlando, Florida';
const day = (offset: number): string =>
  new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const ARRIVE = day(8);
const DEPART = day(12);
/** The calendar labels its cells by long date, so that is how we find them. */
const longDate = (iso: string): string =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
    year: 'numeric',
  });

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
  // The SBSD bundle registers one, and a service worker that outlives the
  // document would answer requests this script never sees.
  serviceWorkers: 'block',
  timezoneId: PROFILE.timezone,
  userAgent: USER_AGENT,
  viewport: VIEWPORT,
});
const page = await context.newPage();

async function cleanup(exitCode = 0): Promise<void> {
  if (closing) return;
  closing = true;
  const forceKill = setTimeout(() => {
    process.exit(exitCode);
  }, 5000);
  forceKill.unref();
  try {
    // Retire the route handler before the browser goes. Closing underneath an
    // in-flight route makes Playwright print the whole intercepted response
    // back as an unhandled "route callback" error, which buries the actual
    // result in CI logs under a few hundred lines of headers.
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

// The identity the solver was told to model, installed on the real browser.
const cdp = await context.newCDPSession(page);
await applyIdentity(cdp);

// Installed before the first navigation: the SBSD carrier fires during the
// bootstrap document, and a router attached afterwards would miss it.
const akamai = attach(page, {
  host: solverHost,
  origin: ORIGIN,
  ...(solverApiKey ? { solverApiKey } : {}),
});

const cookies = async (): Promise<Record<string, string>> =>
  Object.fromEntries(
    (await context.cookies(ORIGIN)).map((c) => [c.name, c.value])
  );

try {
  await page.goto(url, { timeout: 90_000, waitUntil: 'domcontentloaded' });

  // The first document is a small Akamai bootstrap that reloads itself once
  // its SBSD carrier is answered. The search form only exists on the real
  // page, so waiting for it is also how we know which document to solve
  // `_abck` against.
  await page.locator('#location-input').waitFor({ timeout: 90_000 });
  log(`Real document reached: ${page.url()}`);

  // The input exists before React has wired it. Settle, then type real keys:
  // `fill()` sets the value and fires one input event, and a combobox whose
  // listener attaches a moment later simply never sees it — the field ends up
  // populated with no listbox open and nothing to pick.
  await sleep(2500);
  await page.locator('#location-input').click();
  await page
    .locator('#location-input')
    .pressSequentially(DESTINATION, { delay: 40 });
  await page.locator('[role=option]').first().click();
  await page.locator('[data-testid=search-dates-button]').click();

  const calendar = page.locator('[data-testid=calendar-container]');
  const dayCell = (iso: string) =>
    calendar
      .locator('button')
      .filter({ hasText: longDate(iso) })
      .first();
  await dayCell(ARRIVE).click();
  // Choosing check-in re-renders every remaining cell — their labels flip from
  // "as your Check-in date" to "as your Check-out date". Clicking straight
  // through lands on the old node and the second date is silently never set,
  // which hilton answers by routing to its locality page instead of a search.
  await sleep(500);
  await dayCell(DEPART).click();
  await sleep(500);
  const done = page.locator('button').filter({ hasText: /^\s*Done\s*$/u });
  if (await done.count()) await done.first().click();
  log(`Form ready: ${DESTINATION}, ${ARRIVE} → ${DEPART}`);

  await akamai.solveAbck();
  log(`_abck accepted: ~${(await cookies())['_abck']?.split('~')[1]}~`);

  // "Find a hotel" opens a new tab. That tab is not instrumented: it inherits
  // the solved cookie jar and then runs hilton's own sensors natively, which
  // is the point — the clearance has to survive being handed to a normal page.
  const popup = context.waitForEvent('page');
  await page.locator('[data-testid=search-submit-button]').click();
  const results = await popup;
  await results.waitForLoadState('domcontentloaded');

  const title = await results.title();
  const denied = /access denied/iu.test(await results.content());
  log(`Final URL: ${results.url()}`);
  if (denied) {
    log('RESULT: FAIL - Access Denied');
    await cleanup(2);
  } else {
    log(`RESULT: SUCCESS - Akamai solved, reached "${title}"`);
    await cleanup(0);
  }
} catch (e) {
  // A 429 is not a failed solve and retrying cannot help, so report it as its
  // own outcome with its own exit code.
  if (e instanceof RateLimitError) {
    reportRateLimit(e);
    await cleanup(RATE_LIMIT_EXIT_CODE);
  } else {
    log(`ERROR: Solver failed: ${(e as Error).message}`);
    await cleanup(1);
  }
}
