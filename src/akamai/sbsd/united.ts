/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sbsd/united.ts
 * node --env-file=.env src/akamai/sbsd/united.ts --headless
 *
 * united.com. Answers both Akamai channels — the SBSD bundle and the `_abck`
 * sensor — on www.united.com, then signs in with `united_username=` and
 * `united_password=` from .env (or the generic `username=`/`password=`; see
 * `#src/credentials.js`). The username is a MileagePlus number or an email.
 *
 * Like oakley, united runs both channels and gates the sign-in on them. Unlike
 * oakley there is no login page: sign-in is a panel opened by `#loginButton`
 * on the homepage, in two steps. The username is POSTed to
 * `/xapi/auth/validate-username`, and only then does the password field exist.
 *
 *   Access Denied   -> the solver did not get us through (RESULT: FAIL, exit 2)
 *   signed in       -> the solver works (RESULT: SUCCESS, exit 0)
 *   no credentials  -> nothing was measured (RESULT: NOT CONFIGURED, exit 5)
 *
 * The account used here has MFA on, so a run ends at the one-time-code panel:
 * that is reported as its own outcome (exit 1), since the code goes to the
 * account holder's phone and every run sends one.
 *
 * Anything in between (the panel comes back with an error) is a credentials
 * problem, not an Akamai block, and is reported as its own outcome.
 *
 * This signs in with a live account, because that is the only thing that
 * proves the session the solver earned is accepted at POST time. Only run it
 * with credentials you are authorised to use.
 */

import { openAkamaiSession, reportRunError } from '#src/akamai/session.js';
import { trackSettle } from '#src/akamai/sbsd/settle.js';
import { attach } from '#src/akamai/sbsd/solver.js';
import {
  NOT_CONFIGURED_EXIT_CODE,
  resolveCredentials,
} from '#src/credentials.js';
import { log, sleep } from '#src/util.js';

const ORIGIN = 'https://www.united.com';
const url = `${ORIGIN}/en/us`;
const credentials = resolveCredentials('united');
if (!credentials) {
  log(
    'RESULT: NOT CONFIGURED - set united_username= and united_password= in ' +
      '.env (or the generic username=/password=) for the sign-in step'
  );
  process.exit(NOT_CONFIGURED_EXIT_CODE);
}

const { password, username } = credentials;

const session = await openAkamaiSession({
  locale: 'en-US',
  serviceWorkers: 'block',
});
const { apiKey: solverApiKey, exit: cleanup, host: solverHost, page } = session;

const akamai = attach(page, {
  host: solverHost,
  origin: ORIGIN,
  ...(solverApiKey ? { solverApiKey } : {}),
});

const settle = trackSettle(page, akamai);

// The auth calls are the verdict: the DOM only reflects them a moment later.
const authStatus: Record<string, number> = {};
page.on('response', (response) => {
  const { pathname } = new URL(response.url());
  if (pathname.startsWith('/xapi/auth/'))
    authStatus[pathname] = response.status();
});

try {
  await page.goto(url, { timeout: 90_000, waitUntil: 'domcontentloaded' });
  await settle();
  log(`Document reached: ${page.url()}`);

  try {
    await akamai.solveAbck();
  } catch (e) {
    log(`_abck not solved: ${(e as Error).message}`);
  }

  try {
    await page.locator('#loginButton').click({ timeout: 20_000 });
    const usernameForm = page.locator('form:has(#MPIDEmailField)');
    await usernameForm.locator('#MPIDEmailField').fill(username);
    await usernameForm.locator('button[type="submit"]').first().click();
    log('Username submitted, waiting for the password step...');

    const passwordForm = page.locator('form:has(input[name="password"])');
    await passwordForm.locator('input[name="password"]').fill(password, {
      timeout: 30_000,
    });
    log('Filled credentials, submitting...');
    await passwordForm
      .locator('button[type="submit"]:has-text("Sign in")')
      .click();
  } catch (e) {
    log(`ERROR: Sign-in actions failed: ${(e as Error).message}`);
    await cleanup(1);
  }

  // A signed-in header swaps the "Sign in" button for the member's name.
  await page
    .waitForFunction(
      () => {
        const button = document.querySelector('#loginButton');
        return !button || !/sign in/i.test(button.textContent ?? '');
      },
      undefined,
      { timeout: 30_000 }
    )
    .catch(() => {});
  await sleep(3000);

  const html = await page.content();
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '?';
  log(`Final URL: ${page.url()}`);
  log(`Page title: ${title}`);
  log(`Auth responses: ${JSON.stringify(authStatus)}`);

  const denied =
    /<H1>\s*Access Denied\s*<\/H1>/i.test(html) ||
    Object.values(authStatus).includes(403);
  /* `/xapi/auth/signin` answers 202 with an `mfa` descriptor when the account
   * wants a one-time code, and the "Sign in" button disappears behind the code
   * panel just as it does for a real sign-in. Neither the button nor the 200
   * from `validate-username` can tell the two apart; the 202 can. */
  const mfaRequired = authStatus['/xapi/auth/signin'] === 202;
  const signedIn =
    authStatus['/xapi/auth/signin'] === 200 &&
    !(await page
      .locator('#loginButton')
      .filter({ hasText: /sign in/i })
      .count());

  if (denied) {
    log(
      'RESULT: FAIL - Access Denied (sign-in blocked by Akamai despite solved channels)'
    );
    await cleanup(2);
  } else if (mfaRequired) {
    log(
      'RESULT: FAIL - MFA required (credentials and Akamai accepted; ' +
        'United sent a one-time code, which this script does not answer)'
    );
    await cleanup(1);
  } else if (signedIn) {
    log('RESULT: SUCCESS - signed in');
    await cleanup(0);
  } else {
    log(
      'RESULT: FAIL - sign-in rejected (panel still shown; not an Akamai block)'
    );
    await cleanup(1);
  }
} catch (e) {
  await reportRunError(session, e);
}
