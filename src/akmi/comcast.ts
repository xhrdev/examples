/**
 * run this script:

node --env-file=.env src/akmi/comcast.ts --headless

*/
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { solveAkamai } from '#src/akmi/solver.js';

const url = 'https://business.comcast.com/account/';
const solverHost = process.env['host'];
const proxy = process.env['proxy'];
let closing = false;

const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

if (!solverHost) throw new Error('set host= in .env');
if (!proxy) throw new Error('set proxy= in .env');

const solverUrl = `ws://${solverHost}:3000/akamai/session`;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const parseProxy = (raw: string) => {
  const hasScheme = /^[a-z][a-z0-9+\-.]*:\/\//i.test(raw);
  const parsed = new URL(hasScheme ? raw : `http://${raw}`);
  const server = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  return {
    password: decodeURIComponent(parsed.password || '') || undefined,
    server,
    username: decodeURIComponent(parsed.username || '') || undefined,
  };
};

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const CHROME_PATH = process.env['CHROME_PATH'] || '';
const launchOpts: Record<string, unknown> = {
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
  ],
  headless: process.argv.includes('--headless'),
  proxy: parseProxy(proxy),
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
  viewport: { height: 761, width: 1200 },
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

// CDP overrides for Chrome 146
const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setUserAgentOverride', {
  acceptLanguage: 'en-US,en;q=0.9',
  userAgent: UA,
  userAgentMetadata: {
    architecture: 'arm',
    bitness: '64',
    brands: [
      { brand: 'Chromium', version: '146' },
      { brand: 'Not-A.Brand', version: '24' },
      { brand: 'Google Chrome', version: '146' },
    ],
    fullVersion: '146.0.7680.81',
    fullVersionList: [
      { brand: 'Chromium', version: '146.0.7680.81' },
      { brand: 'Not-A.Brand', version: '24.0.0.0' },
      { brand: 'Google Chrome', version: '146.0.7680.81' },
    ],
    mobile: false,
    model: '',
    platform: 'macOS',
    platformVersion: '15.7.3',
  },
});
await cdp.send('Emulation.setDeviceMetricsOverride', {
  deviceScaleFactor: 2,
  height: 761,
  mobile: false,
  screenHeight: 982,
  screenWidth: 1512,
  width: 1200,
});

// Solve Akamai
try {
  await solveAkamai(page, { proxy, solverUrl, url });
} catch (e) {
  log(`ERROR: Solver failed: ${(e as Error).message}`);
  await cleanup(1);
}

await sleep(7000);

// Check result: the goal is to reach the login form without Akamai denying
// the page, not to complete a real login (no real Comcast credentials are
// available in CI, so a genuine sign-in attempt would always fail).
log(`Final URL: ${page.url()}`);
const html = await page.content();

const denied =
  /<H1>\s*Access Denied\s*<\/H1>/i.test(html) || html.includes('Access Denied');
let loginFormReached = false;
if (!denied) {
  try {
    await page.waitForSelector('#user', { timeout: 10000 });
    loginFormReached = true;
  } catch {
    loginFormReached = false;
  }
}

if (denied) log('RESULT: FAIL - Access Denied');
else if (!loginFormReached) log('RESULT: FAIL - login form (#user) not found');
else log('RESULT: SUCCESS - Akamai solved, login form reached');

await cleanup(denied || !loginFormReached ? 2 : 0);
