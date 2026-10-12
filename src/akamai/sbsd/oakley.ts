/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sbsd/oakley.ts
 * node --env-file=.env src/akamai/sbsd/oakley.ts --headless
 *
 * oakley.com. Answers both Akamai channels — the SBSD bundle and the `_abck`
 * sensor — on www.oakley.com, then signs in with `oakley_username=` and
 * `oakley_password=` from .env (or the generic `username=`/`password=`; see
 * `#src/credentials.js`).
 *
 * Oakley runs both channels: the sensor (`_abck`, `bm_sz`) and the SBSD bundle
 * (`bm_s`, `bm_so`). The login POST to `/en-us/j_spring_security_check` is
 * gated on Akamai, so the two channels have to be in a good state before the
 * form is submitted. That is what this script checks:
 *
 *   Access Denied   -> the solver did not get us through (RESULT: FAIL, exit 2)
 *   signed in       -> the solver works (RESULT: SUCCESS, exit 0)
 *   no credentials  -> nothing was measured (RESULT: NOT CONFIGURED, exit 5)
 *
 * That last one used to be a `throw` on the second statement of this file,
 * which is what every CI run of this script has actually done since it was
 * added: `smoke.yml` writes `host=` and `api_key=` and no account, so this
 * died in 0.7s without launching a browser and `advisory: true` let the suite
 * stay green around it. It is now an outcome rather than a crash — see
 * `#src/credentials.js` for why it is classed with a banned IP rather than
 * with a failure.
 *
 * Anything in between (the form comes back with an error) is a credentials
 * problem, not an Akamai block, and is reported as its own outcome.
 *
 * Unlike the other sbsd examples this one really signs in with a live account,
 * because that is the only thing that proves the session the solver earned is
 * accepted at POST time — reaching the login page would not. Only run it with
 * credentials you are authorised to use.
 */

import { openAkamaiSession, reportRunError } from '#src/akamai/session.js';
import { trackSettle } from '#src/akamai/sbsd/settle.js';
import { attach } from '#src/akamai/sbsd/solver.js';
import {
  NOT_CONFIGURED_EXIT_CODE,
  resolveCredentials,
} from '#src/credentials.js';
import { log, sleep } from '#src/util.js';

const ORIGIN = 'https://www.oakley.com';
const url = `${ORIGIN}/en-us/login`;
const credentials = resolveCredentials('oakley');
/* Reported and skipped, not thrown. The distinction is the whole point: a
 * crash here is indistinguishable in the summary table from a target that
 * blocked us, and this script is in a suite whose job is to tell those
 * apart. */
if (!credentials) {
  log(
    'RESULT: NOT CONFIGURED - set oakley_username= and oakley_password= in ' +
      '.env (or the generic username=/password=) for the sign-in step'
  );
  process.exit(NOT_CONFIGURED_EXIT_CODE);
}

const { password, username } = credentials;

const session = await openAkamaiSession({
  ignoreHTTPSErrors: true,
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

const akamai = attach(page, {
  host: solverHost,
  origin: ORIGIN,
  ...(solverApiKey ? { solverApiKey } : {}),
});

const settle = trackSettle(page, akamai);

const cookies = (): Promise<Record<string, string>> => session.cookies(ORIGIN);

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
    /* Submitted without a click, and that is the fix rather than a shortcut.
     *
     * The page's OneTrust cookie banner takes any click or keypress as a
     * consent decision, and Tealium (`utag.js`) applies consent with
     * `location.reload()`. Clicking Sign In therefore started the login POST
     * and queued a reload that superseded it: the POST never left, the page
     * came back as an empty login form, and the run reported "sign-in
     * rejected" with nothing rejected. Seen with CDP's
     * `frameRequestedNavigation` — `formSubmissionPost`, then `reload`, the
     * reload's initiator stack running utag.js under otBannerSdk.js. Enter in
     * the password field does the same.
     *
     * Accepting the banner first removes the reload but not the problem: the
     * POST that follows is denied by Akamai (5/5), so the consent reload costs
     * the session something this script cannot see. `requestSubmit()` fires
     * the form's own `submit` event — the site's validator and its login
     * handler both run, as they would for a person — without the click or
     * key event the banner listens for. 6/6 signed in, 2026-10-10. */
    await loginForm.evaluate((form) =>
      (form as HTMLFormElement).requestSubmit()
    );
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
  await reportRunError(session, e);
}
