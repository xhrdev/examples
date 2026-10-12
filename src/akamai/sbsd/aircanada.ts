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

import { openAkamaiSession, reportRunError } from '#src/akamai/session.js';
import { trackSettle } from '#src/akamai/sbsd/settle.js';
import { attach } from '#src/akamai/sbsd/solver.js';
import { log } from '#src/util.js';

const ORIGIN = 'https://www.aircanada.com';
/* The flights booking page, the URL the status canary checks. `home.html`,
 * which this used to open, has started answering this script with Akamai's
 * Access Denied after the carrier is spent (4/4 on 2026-10-10, direct and
 * through the ISP proxy) while `/flights` serves the booking app from the same
 * addresses in the same minutes. */
const url = `${ORIGIN}/home/ca/en/aco/flights`;
const session = await openAkamaiSession({
  locale: 'en-US',
  serviceWorkers: 'block',
});
const { apiKey: solverApiKey, exit: cleanup, host: solverHost, page } = session;

const akamai = attach(page, {
  host: solverHost,
  origin: ORIGIN,
  // SBSD only: see the header. The page answers its own _abck, as it does for
  // any other browser.
  sensor: 'page',
  ...(solverApiKey ? { solverApiKey } : {}),
});

const settle = trackSettle(page, akamai);

const cookies = (): Promise<Record<string, string>> => session.cookies(ORIGIN);

try {
  await page.goto(url, { timeout: 90_000, waitUntil: 'domcontentloaded' });
  await settle();
  log(`Document reached: ${page.url()}`);

  log(
    `SBSD carriers answered: ${akamai.carriersAnswered()}, ` +
      `_abck: ~${(await cookies())['_abck']?.split('~')[1]}~`
  );

  /* The booking app's own Angular component elements, which is what the
   * status canary asserts on. The `where can we take you` heading this used to
   * wait for has been gone since 2026-09-09, so every run waited 60s on it and
   * then reported whatever the catch below guessed. Component selectors are
   * part of the app's source, not its copy or stylesheet, and Akamai's denial
   * page does not boot the app, so neither exists on a block. */
  await page.locator('ac-bkmg-desktop').first().waitFor({ timeout: 60_000 });
  await page
    .locator('ac-dynamic-locations')
    .first()
    .waitFor({ timeout: 10_000 });

  const title = await page.title();
  log(`Final URL: ${page.url()}`);
  log(`RESULT: SUCCESS - Akamai solved, reached "${title}"`);
  await cleanup(0);
} catch (e) {
  await reportRunError(session, e, { checkDenied: true });
}
