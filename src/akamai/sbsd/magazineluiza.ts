/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sbsd/magazineluiza.ts
 * node --env-file=.env src/akamai/sbsd/magazineluiza.ts --headless
 *
 * magazineluiza.com.br. A blocked request gets the retailer's own branded
 * Akamai deny page rather than Akamai's default template, but it is the same
 * edge-level bot-manager response underneath.
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

const ORIGIN = 'https://www.magazineluiza.com.br';
const url = `${ORIGIN}/`;
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
  ignoreHTTPSErrors: true,
  locale: 'pt-BR',
  serviceWorkers: 'block',
  timezoneId: 'America/Sao_Paulo',
  userAgent: USER_AGENT,
  viewport: VIEWPORT,
});
const page = await context.newPage();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

const akamai = attach(page, {
  host: solverHost,
  origin: ORIGIN,
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

const cookies = async (): Promise<Record<string, string>> =>
  Object.fromEntries(
    (await context.cookies(ORIGIN)).map((c) => [c.name, c.value])
  );

try {
  await page.goto(url, { timeout: 90_000, waitUntil: 'domcontentloaded' });
  await settle();
  log(`Document reached: ${page.url()}`);

  try {
    await akamai.solveAbck();
    log(`_abck accepted: ~${(await cookies())['_abck']?.split('~')[1]}~`);
  } catch (e) {
    log(`_abck not solved: ${(e as Error).message}`);
  }

  await page.goto(url, { timeout: 90_000, waitUntil: 'domcontentloaded' });
  await sleep(2000);

  const title = await page.title();
  const denied = /não é possível acessar a página/iu.test(title);
  log(`Final URL: ${page.url()} ("${title}")`);

  if (denied) {
    log('RESULT: FAIL - Access Denied');
    await cleanup(2);
  } else {
    log('RESULT: SUCCESS - Akamai solved, homepage reached');
    await cleanup(0);
  }
} catch (e) {
  if (e instanceof RateLimitError) {
    reportRateLimit(e);
    await cleanup(RATE_LIMIT_EXIT_CODE);
  } else {
    log(`ERROR: Solver failed: ${(e as Error).message}`);
    await cleanup(1);
  }
}
