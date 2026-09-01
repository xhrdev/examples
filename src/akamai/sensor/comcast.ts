/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sensor/comcast.ts
 * node --env-file=.env src/akamai/sensor/comcast.ts --headless
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { toLaunchProxy } from '#src/proxy.js';
import { solverWsUrl } from '#src/solver-url.js';
import { applyIdentity, USER_AGENT, VIEWPORT } from '#src/akamai/identity.js';
import { solve } from '#src/akamai/sensor/solver.js';
import {
  RATE_LIMIT_EXIT_CODE,
  RateLimitError,
  reportRateLimit,
} from '#src/rate-limit.js';

const url = 'https://business.comcast.com/account/';
const solverHost = process.env['host'];
const proxy = process.env['proxy'];
const solverApiKey = process.env['api_key'];
let closing = false;

const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

if (!solverHost) throw new Error('set host= in .env');

const solverUrl = solverWsUrl(solverHost, '/akamai/session');

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const UA = USER_AGENT;

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
  deviceScaleFactor: 2,
  ignoreHTTPSErrors: true,
  locale: 'en-US',
  timezoneId: 'America/New_York',
  userAgent: UA,
  viewport: VIEWPORT,
});
const page = await context.newPage();

async function cleanup(exitCode = 0) {
  if (closing) return;
  closing = true;
  const forceKill = setTimeout(() => {
    process.exit(exitCode);
  }, 5000);
  forceKill.unref();
  try {
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
  log(`Unhandled rejection: ${reason}`);
  void cleanup(1);
});

// The identity the solver was told to model, installed on the real browser.
const cdp = await context.newCDPSession(page);
await applyIdentity(cdp);

// Solve Akamai
try {
  await solve(page, {
    ...(proxy ? { proxy } : {}),
    ...(solverApiKey ? { solverApiKey } : {}),
    solverUrl,
    url,
  });
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

await sleep(7000);

// Check result: the goal is to get a real page instead of Akamai's block, not
// to complete a login (no real Comcast credentials are available in CI, so a
// genuine sign-in attempt would always fail).
//
// The OAuth chain does not always land in the same place: usually it redirects
// to the login form, but it also serves the dashboard shell directly. Both
// mean Akamai let us through, so treat either as a pass and only fail on an
// actual denial. Asserting on the login form alone made this flaky.
log(`Final URL: ${page.url()}`);
const html = await page.content();

const denied =
  /<H1>\s*Access Denied\s*<\/H1>/i.test(html) || html.includes('Access Denied');

const loginFormReached = denied
  ? false
  : await page
      .waitForSelector('#user', { timeout: 10000 })
      .then(() => true)
      .catch(() => false);

if (denied) log('RESULT: FAIL - Access Denied');
else if (loginFormReached)
  log('RESULT: SUCCESS - Akamai solved, login form reached');
else
  log(
    `RESULT: SUCCESS - Akamai solved, reached ${new URL(page.url()).pathname}`
  );

await cleanup(denied ? 2 : 0);
