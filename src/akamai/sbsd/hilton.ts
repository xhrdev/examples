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
 * ## headless works here now
 *
 * This example used to say `--headless` did not work — that a run landing on
 * round 5 headed sat at `~-1~` past round 30 headless, and that hilton refused
 * a headless Chrome whatever the payloads looked like. Re-measured on
 * 2026-09-08 after the ledger request was cut to five fields: three headless
 * runs, `_abck` accepted on round 5 every time, results page reached every
 * time. Whether the payload change is what moved it or hilton's own scoring
 * changed is not established here, only that the old claim no longer holds.
 *
 * ## the exit address still matters, and it wears out
 *
 * `proxy=` is optional, but the address is the variable to suspect first. One
 * desktop address measured 2/4 direct, then 0/2 after another handful of runs;
 * an ISP proxy held 4/4 across the same window. Datacentre space is worse
 * again — see `sbsd/aa.ts` for what that looks like measured across four
 * providers. Suspect the exit before the payloads.
 */

import { openAkamaiSession, reportRunError } from '#src/akamai/session.js';
import { attach } from '#src/akamai/sbsd/solver.js';
import { log, sleep } from '#src/util.js';

const ORIGIN = 'https://www.hilton.com';
const url = `${ORIGIN}/en/`;
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

const session = await openAkamaiSession({
  locale: 'en-US',
  serviceWorkers: 'block',
});
const {
  apiKey: solverApiKey,
  context,
  exit: cleanup,
  host: solverHost,
  page,
} = session;

// Installed before the first navigation: the SBSD carrier fires during the
// bootstrap document, and a router attached afterwards would miss it.
const akamai = attach(page, {
  host: solverHost,
  origin: ORIGIN,
  ...(solverApiKey ? { solverApiKey } : {}),
});

const cookies = (): Promise<Record<string, string>> => session.cookies(ORIGIN);

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
  await reportRunError(session, e);
}
