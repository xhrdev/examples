/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sbsd/oakley.ts
 * node --env-file=.env src/akamai/sbsd/oakley.ts --headless
 *
 * oakley.com. Answers both Akamai channels — the SBSD bundle and the `_abck`
 * sensor — on www.oakley.com, then signs in with `username=` and `password=`
 * from .env.
 *
 * Oakley runs both channels: the sensor (`_abck`, `bm_sz`) and the SBSD bundle
 * (`bm_s`, `bm_so`). The login POST to `/en-us/j_spring_security_check` is
 * gated on Akamai, so the two channels have to be in a good state before the
 * form is submitted. That is what this script checks:
 *
 *   Access Denied  -> the solver did not get us through (RESULT: FAIL, exit 2)
 *   signed in      -> the solver works (RESULT: SUCCESS, exit 0)
 *
 * Anything in between (the form comes back with an error) is a credentials
 * problem, not an Akamai block, and is reported as its own outcome.
 *
 * Unlike the other sbsd examples this one really signs in with a live account,
 * because that is the only thing that proves the session the solver earned is
 * accepted at POST time — reaching the login page would not. Only run it with
 * credentials you are authorised to use.
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';

import { applyIdentity, USER_AGENT, VIEWPORT } from '#src/akamai/identity.js';
import { attach } from '#src/akamai/sbsd/solver.js';
import { toLaunchProxy } from '#src/proxy.js';
import {
  RATE_LIMIT_EXIT_CODE,
  RateLimitError,
  reportRateLimit,
} from '#src/rate-limit.js';

const ORIGIN = 'https://www.oakley.com';
const url = `${ORIGIN}/en-us/login`;
const solverHost = process.env['host'];
const proxy = process.env['proxy'];
const solverApiKey = process.env['api_key'];
const username = process.env['username'];
const password = process.env['password'];
let closing = false;

const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

if (!solverHost) throw new Error('set host= in .env');
if (!username || !password)
  throw new Error('set username= and password= in .env for the sign-in step');

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
  ignoreHTTPSErrors: true,
  locale: 'en-US',
  serviceWorkers: 'block',
  timezoneId: 'America/New_York',
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

  // The solve is done; the form should now be on the page. Give the redirect
  // that follows the login POST room to land, then classify the outcome.
  const loginForm = page.locator('#loginForm');
  try {
    await loginForm.waitFor({ state: 'attached', timeout: 15000 });
    await loginForm.locator('input[name="j_username"]').fill(username);
    await loginForm.locator('input[name="j_password"]').fill(password);
    log('Filled credentials, submitting...');
    await loginForm.locator('button[type="submit"]').click();
  } catch (e) {
    log(`ERROR: Sign-in actions failed: ${(e as Error).message}`);
    await cleanup(1);
  }

  // Successful logins leave /login; failures bounce back to it (often ?error).
  await page
    .waitForURL(
      (u) =>
        !new URL(u).pathname.startsWith('/en-us/login') &&
        !new URL(u).pathname.includes('j_spring_security_check'),
      { timeout: 30000 }
    )
    .catch(() => {});
  await sleep(3000);

  // Check result
  const html = await page.content();
  const finalUrl = page.url();
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '?';
  log(`Final URL: ${finalUrl}`);
  log(`Page title: ${title}`);

  const denied =
    /<H1>\s*Access Denied\s*<\/H1>/i.test(html) ||
    html.includes('Access Denied');
  const loginPage =
    new URL(finalUrl).pathname.startsWith('/en-us/login') ||
    finalUrl.includes('j_spring_security_check');

  // Hybris marks the session in a cookie: `anonymous|Guest` before login, the
  // customer's identity after. A guest bounced to the homepage would pass a
  // URL-only check, so require the cookie to have flipped too.
  const userStatus =
    (await context.cookies(ORIGIN)).find((c) => c.name === 'User_Status')
      ?.value ?? '';
  const signedIn = !userStatus.startsWith('anonymous');
  log(`User_Status cookie: ${userStatus}`);

  if (denied) {
    log(
      'RESULT: FAIL - Access Denied (login POST blocked by Akamai despite solved channels)'
    );
    await cleanup(2);
  } else if (!loginPage && signedIn) {
    log('RESULT: SUCCESS - signed in');
    await cleanup(0);
  } else if (loginPage) {
    log(
      'RESULT: FAIL - sign-in rejected (form still shown; not an Akamai block)'
    );
    await cleanup(1);
  } else {
    log(
      'RESULT: FAIL - not authenticated (left /login but session is still a guest)'
    );
    await cleanup(1);
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
