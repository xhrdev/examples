/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sensor/lowes.ts
 * node --env-file=.env src/akamai/sensor/lowes.ts --headless
 *
 * lowes.com. Checks that the solver gets us past Akamai to the homepage.
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

const url = 'https://www.lowes.com/';
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

try {
  await solve(page, {
    ...(proxy ? { proxy } : {}),
    ...(solverApiKey ? { solverApiKey } : {}),
    solverUrl,
    url,
  });
} catch (e) {
  if (e instanceof RateLimitError) {
    reportRateLimit(e);
    await cleanup(RATE_LIMIT_EXIT_CODE);
  }
  // Anything else falls through to the page check below rather than failing
  // here outright: lowes.com does not always challenge, and a solver timeout
  // with no `_abck` round to answer looks identical to one it gave up on —
  // the page itself is what tells them apart.
  log(`solve() did not complete: ${(e as Error).message}`);
}

await sleep(5000);

const html = await page.content();
log(`Final URL: ${page.url()}`);

const denied =
  /<H1>\s*Access Denied\s*<\/H1>/i.test(html) || html.includes('Access Denied');
const rendered = (await page.locator('body').innerText()).trim().length > 0;

if (denied) {
  log('RESULT: FAIL - Access Denied');
  await cleanup(2);
} else if (rendered) {
  log('RESULT: SUCCESS - Homepage accessible');
  await cleanup(0);
} else {
  log('RESULT: FAIL - page never rendered');
  await cleanup(1);
}
