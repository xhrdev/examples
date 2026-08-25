/**
 * The body every browser-driven DataDome example shares.
 *
 * `grainger.ts` and `idealista.ts` were byte-identical apart from one URL
 * literal, and the seven targets added alongside them would have made nine
 * copies of the same launch options, signal handling and error branch. The
 * launch flags in particular are not incidental — dropping
 * `--disable-blink-features=AutomationControlled`, or letting Playwright keep
 * `--enable-automation`, changes what DataDome sees — so they belong in one
 * place where a fix reaches every target rather than the one you remembered
 * to edit.
 *
 * A target script is therefore its URL, a short note on what that target
 * shows, and a call to `runBrowserTarget`.
 *
 * Flags every target script accepts:
 *
 *   --headless      launch headless. Worth knowing before you use it: on the
 *                   harder targets headless draws recurrent challenges where
 *                   the same profile headed clears first time, so the default
 *                   is headed and the smoke suite passes this only where the
 *                   target tolerates it.
 *   --screenshot    write a PNG of whatever the page ended up showing to
 *                   `target/screenshots/`, on success and on failure both.
 *                   A solver success flag is not proof the target rendered —
 *                   the page can be a soft block that returns HTTP 200 — so
 *                   this is how you verify a run actually landed.
 */
import fs from 'node:fs';
import path from 'node:path';

import { chromium, type LaunchOptions, type Page } from 'playwright-core';

import { pinSession, toLaunchProxy } from '#src/proxy.js';
import { solverBaseUrl } from '#src/solver-url.js';
import { solve } from '#src/datadome/solver.js';
import {
  BANNED_EXIT_CODE,
  BannedError,
  reportBanned,
} from '#src/datadome/ban.js';
import {
  RATE_LIMIT_EXIT_CODE,
  RateLimitError,
  reportRateLimit,
} from '#src/rate-limit.js';

export type BrowserTargetOptions = {
  /** Slug used to name screenshots. Usually the script's own basename. */
  name: string;
  /** The page to land on once DataDome has been cleared. */
  url: string;
};

/** How long the browser stays open after a run, to inspect what it landed on. */
const BROWSER_HOLD_MS = 30_000;
const SCREENSHOT_DIR = 'target/screenshots';

const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

/**
 * Solve DataDome on `url` in a real Chrome and report the outcome.
 *
 * Sets `process.exitCode` rather than throwing: 0 on an accepted solve, 4 on
 * a DataDome ban (`BANNED_EXIT_CODE`), 3 on
 * a rate limit (`RATE_LIMIT_EXIT_CODE`, which the load-test runner counts
 * separately because retrying cannot help), 1 on anything else.
 */
export async function runBrowserTarget({
  name,
  url,
}: BrowserTargetOptions): Promise<void> {
  const solverHost = process.env['host'];
  const configuredProxy = process.env['proxy'];
  const solverApiKey = process.env['api_key'];
  const chromePath = process.env['CHROME_PATH'] || '';

  if (!solverHost) throw new Error('set host= in .env');

  const solverUrl = solverBaseUrl(solverHost);
  const wantScreenshot = process.argv.includes('--screenshot');

  // No proxy is a valid setup: the browser and the submission then both go
  // out from this machine, which is all DataDome asks — one address throughout.
  const proxy = configuredProxy ? pinSession(configuredProxy).url : undefined;

  const launchOptions: LaunchOptions = {
    args: [
      '--window-size=1200,904',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    headless: process.argv.includes('--headless'),
    ignoreDefaultArgs: ['--enable-automation', '--force-color-profile=srgb'],
    ...(proxy ? { proxy: toLaunchProxy(proxy) } : {}),
  };

  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (chromePath && fs.existsSync(chromePath)) {
    launchOptions.executablePath = chromePath;
  } else {
    launchOptions.channel = 'chrome';
  }

  const browser = await chromium.launch(launchOptions);
  let closing = false;

  const cleanup = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await browser.close().catch(() => undefined);
  };

  const holdBrowser = async (): Promise<void> => {
    if (closing || !browser.isConnected()) return;
    log(`Keeping browser open for ${BROWSER_HOLD_MS}ms (Ctrl+C to close now)`);
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        browser.off('disconnected', done);
        resolve();
      };
      const timer = setTimeout(done, BROWSER_HOLD_MS);
      browser.once('disconnected', done);
      if (!browser.isConnected()) done();
    });
  };

  process.once('SIGINT', () => {
    log('Caught SIGINT');
    void cleanup();
  });
  process.once('SIGTERM', () => {
    log('Caught SIGTERM');
    void cleanup();
  });

  let page: Page | undefined;

  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      timezoneId: 'America/New_York',
      // Do not set locale here. Chromium's native Accept-Language ordering is
      // part of the DataDome request identity.
      viewport: null,
    });
    page = await context.newPage();
    const result = await solve(page, {
      ...(proxy ? { proxy } : {}),
      ...(solverApiKey ? { solverApiKey } : {}),
      solverUrl,
      url,
    });

    log(`RESULT: SUCCESS - DataDome returned HTTP ${result.responseStatus}`);
  } catch (error) {
    // A 429 is its own outcome, not a failed solve: retrying cannot help, so
    // say so plainly and exit with a code the caller can branch on.
    if (error instanceof RateLimitError) {
      process.exitCode = RATE_LIMIT_EXIT_CODE;
      reportRateLimit(error);
    } else if (error instanceof BannedError) {
      // Same reasoning as the 429 above: DataDome decided about this address
      // before offering a challenge, so there is nothing here that a retry or
      // a code change reaches.
      process.exitCode = BANNED_EXIT_CODE;
      reportBanned(error);
    } else if (page && (await servedDirectly(page, url, error))) {
      log('RESULT: NO CHALLENGE - the target served the page directly');
    } else {
      process.exitCode = 1;
      log(`RESULT: FAIL - ${(error as Error).message}`);
    }
  } finally {
    if (wantScreenshot && page) await capture(page, name);
    await holdBrowser();
    await cleanup();
  }
}

/**
 * Write a full-page PNG of where the run ended up.
 *
 * Never allowed to change the outcome — this runs in a `finally`, often after
 * a failure, so a page that has already crashed or closed must not turn a
 * reported FAIL into an unhandled rejection.
 */
async function capture(page: Page, name: string): Promise<void> {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const file = path.join(SCREENSHOT_DIR, `${name}-${stamp}.png`);
    await fs.promises.mkdir(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ fullPage: true, path: file });
    log(`screenshot: ${file}`);
  } catch (error) {
    log(`screenshot failed: ${(error as Error).message}`);
  }
}

/**
 * True when the run ran out of patience because there was nothing to solve.
 *
 * DataDome does not challenge everyone. From an address it already trusts the
 * target just serves the page, no `dd` object is ever seen, and `solve` waits
 * out its timeout — which reads as a failure and is not one. `dev-resources/curl`
 * has always called that outcome `no challenge to solve` and exited 0; this is
 * the same judgement for the browser path.
 *
 * Both halves matter. The message alone would swallow a genuine hang, so the
 * page also has to be sitting on the target's own host with a rendered body:
 * a challenge that never resolved leaves Chrome on geo.captcha-delivery.com,
 * and a navigation that died outright leaves it on `about:blank`.
 */
async function servedDirectly(
  page: Page,
  url: string,
  error: unknown
): Promise<boolean> {
  if ((error as Error).message !== 'Timed out waiting for DataDome challenge') {
    return false;
  }
  try {
    if (new URL(page.url()).hostname !== new URL(url).hostname) return false;
    return (await page.locator('body').innerText()).trim().length > 0;
  } catch {
    return false;
  }
}
