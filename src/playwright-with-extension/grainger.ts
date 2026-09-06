/**
 * Run with:
 *
 * node --env-file=.env src/playwright-with-extension/grainger.ts
 * node --env-file=.env src/playwright-with-extension/grainger.ts --headless
 * node --env-file=.env src/playwright-with-extension/grainger.ts --screenshot
 *
 * The same grainger.com every other DataDome example here clears, solved by
 * the xhr.dev Autosolver Chrome extension instead of by this script.
 *
 * The difference is worth being clear about, because it is the only reason to
 * reach for this shape. Everywhere else in this repo the script is the client:
 * it opens the solver session, receives the payloads and relays them through a
 * page it drives. Here the script is a bystander. It launches Chrome with the
 * extension loaded, navigates, and waits — the extension notices the challenge
 * in whatever tab it appears, answers it, and the page resolves underneath.
 *
 * So this is what to copy when you want a *browsing session that stays
 * cleared* rather than a cookie to carry somewhere else: an operator driving a
 * real browser, a long-lived session across many pages, anything where the
 * challenge can show up somewhere you were not watching.
 *
 * Needs a checkout of git@github.com:xhrdev/extension.git — next to this repo,
 * or wherever `extension_path=` in .env points.
 */
import fs from 'node:fs';
import path from 'node:path';

import { BANNED_EXIT_CODE } from '#src/datadome/ban.js';
import { RATE_LIMIT_EXIT_CODE } from '#src/rate-limit.js';
import { ACCESS_DENIED_EXIT_CODE } from '#src/access-denied.js';
import { launchWithExtension } from '#src/playwright-with-extension/extension.js';

const URL_TO_SOLVE = 'https://www.grainger.com/';
const SCREENSHOT_DIR = 'target/screenshots';

const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

const solverHost = process.env['host'];
const solverApiKey = process.env['api_key'];
if (!solverHost) throw new Error('set host= in .env');

// Passed through raw, deliberately. `solverBaseUrl` in this repo resolves a
// bare host to `http://host:3000`, which is right for every Node client here —
// undici and curl reach it happily. It is the one form an extension can never
// use: Chrome rewrites http:// to https:// for public hostnames and does not
// fall back, so the request dies against a port with no TLS listener. The
// extension applies its own rule to the shorthand, so handing it the raw value
// is both simpler and the only thing that works.
const host = solverHost;

const headless = process.argv.includes('--headless');
const wantScreenshot = process.argv.includes('--screenshot');

const session = await launchWithExtension(
  {
    apiKey: solverApiKey ?? '',
    autoSolve: true,
    // DataDome needs no eager origin: the challenge arrives as an iframe the
    // extension can notice after the fact and answer on a second load. Akamai
    // would need one here.
    eagerOrigins: [],
    host,
  },
  { headless }
);

log(`Extension ${session.extensionId} loaded, solver ${host}`);

try {
  const page = await session.context.newPage();
  log(`Navigating to ${URL_TO_SOLVE}`);
  await page
    .goto(URL_TO_SOLVE, { waitUntil: 'domcontentloaded' })
    .catch(() => undefined);

  const tabId = await session.tabId();
  const outcome = await session.waitForOutcome(tabId);

  for (const line of await session.transcript()) log(`  ${line}`);

  if (wantScreenshot) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const file = path.join(SCREENSHOT_DIR, 'extension-grainger.png');
    await page.screenshot({ path: file }).catch(() => undefined);
    log(`Screenshot: ${file}`);
  }

  if (!outcome) {
    // No outcome at all means no challenge was served. That is a legitimate
    // result rather than a failure — the extension correctly does nothing when
    // there is nothing to solve — so say which happened instead of implying a
    // solve took place.
    log('RESULT: NO CHALLENGE - the target served the page without one');
    log(`  Landed on ${page.url()}`);
  } else if (outcome.state === 'solved') {
    const detail = outcome.detail ?? {};
    log(
      `RESULT: SUCCESS - ${outcome.vendor} solved, HTTP ${String(detail['responseStatus'])}`
    );
    log(`  Landed on ${page.url()}`);
  } else if (outcome.state === 'blocked') {
    // A ban or a rate limit. Neither is retryable, and neither is a fault in
    // the solve — see src/datadome/ban.ts and src/rate-limit.ts.
    log(`RESULT: BLOCKED - ${outcome.message ?? ''}`);
    process.exitCode = /rate limit/i.test(outcome.message ?? '')
      ? RATE_LIMIT_EXIT_CODE
      : BANNED_EXIT_CODE;
  } else {
    log(`RESULT: FAILED - ${outcome.message ?? 'unknown'}`);
    process.exitCode = /did not rotate|refus/i.test(outcome.message ?? '')
      ? ACCESS_DENIED_EXIT_CODE
      : 1;
  }
} finally {
  await session.close();
}
