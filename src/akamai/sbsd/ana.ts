import fs from 'node:fs';
import { chromium, type Locator } from 'playwright-core';

import { applyIdentity, USER_AGENT, VIEWPORT } from '#src/akamai/identity.js';
import { attach } from '#src/akamai/sbsd/solver.js';
import { PROFILE } from '#src/profile.js';
import { toLaunchProxy } from '#src/proxy.js';
import {
  RATE_LIMIT_EXIT_CODE,
  RateLimitError,
  reportRateLimit,
} from '#src/rate-limit.js';

const ORIGIN = 'https://www.ana.co.jp';
const ORIGIN_HOST = new URL(ORIGIN).host;
const url = `${ORIGIN}/`;
const solverHost = process.env['host'];
const proxy = process.env['proxy'];
const solverApiKey = process.env['api_key'];
let closing = false;

const LANDING_ROUNDS = 3;

const ARRIVAL = 'OSA';
const DEPART_IN_DAYS = 45;
const NIGHTS = 3;

const SEARCH_API = /\/aswbe-search\/api\/v\d+\/roundtrip/u;

const RESULTS_URL = /\/webapps\/reservation\/[a-z-]*flight-availability/u;

const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

if (!solverHost) throw new Error('set host= in .env');

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const CHROME_PATH = process.env['CHROME_PATH'] || '';
const launchOpts: Record<string, unknown> = {
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',

    '--disable-updater-scheduler',
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
  locale: 'ja-JP',
  serviceWorkers: 'block',
  timezoneId: PROFILE.timezone,
  userAgent: USER_AGENT,
  viewport: VIEWPORT,
});
const page = await context.newPage();

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

await applyIdentity(await context.newCDPSession(page));

const solverOff = process.argv.includes('--no-solver');
if (solverOff) log('CONTROL RUN: no solver attached');

const akamai = solverOff
  ? null
  : attach(page, {
      host: solverHost,
      origin: ORIGIN,

      protectedHosts: [/(^|\.)ana\.co\.jp$/u],
      ...(solverApiKey ? { solverApiKey } : {}),
    });

const settle = async (): Promise<void> => {
  const deadline = Date.now() + 60_000;
  const host = new URL(page.url()).host;
  const answeredHere = (): number =>
    akamai?.stats().byHost[host]?.carriersAnswered ?? 0;
  while (
    ((akamai !== null && answeredHere() === 0) ||
      Date.now() - lastDocumentAt < 5000) &&
    Date.now() < deadline
  )
    await sleep(500);
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await sleep(1500);
};

const cookies = async (host = ORIGIN): Promise<Record<string, string>> =>
  Object.fromEntries(
    (await context.cookies(host)).map((c) => [c.name, c.value])
  );

const solveRealms = async (): Promise<void> => {
  if (!akamai) return;
  await akamai.solveAll({ waitForAcceptance: false });
  log(
    `realms: ${akamai
      .realms()
      .map((r) => `${r.host}${r.accepted ? '(accepted)' : '(unsolved)'}`)
      .join(' ')}`
  );
};

const visible = (locator: Locator): Locator =>
  locator.filter({ visible: true }).first();

const airportButton = (leg: 'arrival' | 'departure'): Locator =>
  visible(
    page.locator(
      `button[aria-controls^="be-domestic-reserve-ticket-${leg}-airport-dialog-"]`
    )
  );

const chooseAirport = async (
  leg: 'arrival' | 'departure',
  code: string
): Promise<void> => {
  const button = airportButton(leg);
  await button.waitFor({ state: 'visible', timeout: 60_000 });
  const before = (await button.innerText()).trim();
  await button.click();

  const search = visible(
    page.locator('input.be-list-with-search__searchbox-input')
  );
  await search.waitFor({ state: 'visible', timeout: 10_000 });
  await search.click();

  await search.pressSequentially(code, { delay: 30 });

  const option = visible(
    page.locator(`li.be-list__item[data-value="${code}"]`)
  );
  await option.waitFor({ state: 'visible', timeout: 10_000 });
  await option.click();

  if ((await button.innerText()).trim() === before) await option.press('Enter');
  const picked = (await button.innerText()).trim();
  if (picked === before) throw new Error(`${leg}: ${code} did not commit`);
  log(`${leg}: ${picked}`);
};

const isoDay = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const chooseDate = async (
  leg: 'arrival' | 'departure',
  days: number
): Promise<void> => {
  const iso = isoDay(days);
  const button = visible(
    page.locator(`button.be-domestic-reserve-ticket-${leg}-date__button`)
  );
  await button.waitFor({ state: 'visible', timeout: 30_000 });
  const before = (await button.innerText()).trim();

  const openCalendar = page.locator('td[data-title]').filter({ visible: true });
  if ((await openCalendar.count()) === 0) await button.click();

  const cell = visible(page.locator(`td[data-title="${iso}"] button`));
  const next = visible(
    page.locator('div.be-dialog button.be-calendar__button--next')
  );

  for (let month = 0; month <= 12; month++) {
    if ((await cell.count()) > 0) {
      await cell.click();
      const picked = (await button.innerText()).trim();
      if (picked === before)
        throw new Error(
          `${leg} date ${iso} was clicked but the field still reads "${before}"`
        );
      log(`${leg} date: ${picked}`);
      return;
    }
    if ((await next.count()) === 0) break;
    await next.click();

    await cell
      .first()
      .waitFor({ state: 'visible', timeout: 2000 })
      .catch(() => undefined);
  }
  throw new Error(`${leg} date ${iso} is not offered by this calendar`);
};

try {
  if (akamai) await akamai.installed;

  await page.goto(url, { timeout: 90_000, waitUntil: 'domcontentloaded' });
  await settle();
  log(`Document reached: ${page.url()}`);

  const landing = solveRealms().catch((error: Error) => {
    log(`Landing ended: ${error.message}`);
  });
  const originRounds = (): number =>
    akamai?.realms().find((r) => r.host === ORIGIN_HOST)?.rounds ?? 0;
  const landingDeadline = Date.now() + 45_000;
  while (
    akamai !== null &&
    originRounds() < LANDING_ROUNDS &&
    Date.now() < landingDeadline
  )
    await sleep(250);
  log(`Landing sensor rounds: ${originRounds()}`);
  void landing;

  await chooseAirport('arrival', ARRIVAL);
  await chooseDate('departure', DEPART_IN_DAYS);
  await chooseDate('arrival', DEPART_IN_DAYS + NIGHTS);

  const submit = visible(
    airportButton('departure')
      .locator('xpath=ancestor::form[1]')
      .locator('button[type="submit"]')
  );
  await submit.waitFor({ state: 'visible', timeout: 30_000 });
  if (await submit.isDisabled())
    throw new Error('submit is disabled — the form is incomplete');

  const searched = page
    .waitForResponse((r) => SEARCH_API.test(r.url()), { timeout: 60_000 })
    .then(
      (r) => r.status(),
      () => null
    );

  await sleep(4000);
  await submit.click();
  log('Search submitted');

  const searchStatus = await searched;
  log(`Search API: ${searchStatus ?? 'never issued'}`);
  await page
    .waitForURL(RESULTS_URL, { timeout: 30_000 })
    .catch(() => undefined);
  await settle();
  await solveRealms();

  log(`_abck: ~${(await cookies())['_abck']?.split('~')[1]}~`);
  log(`Final URL: ${page.url()}`);
  if (RESULTS_URL.test(page.url())) {
    log(`RESULT: SUCCESS - Akamai solved, reached "${await page.title()}"`);
    await cleanup(0);
  } else {
    log(`RESULT: FAIL - "${await page.title()}"`);
    await cleanup(2);
  }
} catch (e) {
  if (e instanceof RateLimitError) {
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
