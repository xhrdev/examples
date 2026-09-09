/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sbsd/hilton-lightpanda.ts
 *
 * `hilton.ts` with **Lightpanda** in place of Chrome, and the target that
 * makes the pairing worth having: hilton.com runs *both* Akamai lanes, so this
 * is the first file in the repo where the SBSD ledger and the `_abck` session
 * are driven through a browser with no renderer at the same time.
 *
 * Each lane already had its own Lightpanda proof and they were separate files:
 * `sensor/comcast-lightpanda.ts` for `_abck`, `sbsd/aircanada-lightpanda.ts`
 * for SBSD — and aircanada is `sensor: 'page'`, so there is no session in it at
 * all. What was untested until here is whether the two coexist on this browser:
 * the bundle gates the first document, the reload lands, and only then does the
 * sensor script on the real page have to hold a WebSocket conversation open
 * across a page Lightpanda is still assembling.
 *
 * The setup is `aircanada-lightpanda.ts`'s, for the reasons given in its
 * header — `fetchResponse` because `route.fetch` never returns here, `readHtml`
 * because `page.content()` never resolves — with `sensor` left at its default
 * so that `attach()` solves `_abck` rather than leaving it to the page.
 *
 * ## what this asserts, and why it is not hilton.ts's assertion
 *
 * `hilton.ts` books a search: type a destination, pick two dates out of the
 * calendar, submit, and read the results page that opens in a new tab. None of
 * that survives the port, and not because of Akamai. `pressSequentially` and
 * `click()` want an element that has been laid out, `[role=option]` appears
 * only once React has wired the combobox, and the results arrive in a popup.
 * Lightpanda has no layout engine, so the first two cannot be waited on the way
 * Playwright waits on them anywhere else.
 *
 * So this checks what `hilton.ts`'s own header calls the first of its two
 * results — `_abck` reaching `~0~` — plus the real document behind the
 * bootstrap, by its server-rendered `<title>`. That is the same substitution
 * `aircanada-lightpanda.ts` makes and it is weaker than the Chrome file in the
 * same way: it proves Akamai served us the page, not that the application
 * behind it works. Run `npm run hilton` for the second half.
 *
 * ## measured 2026-09-09: it solves, and both lanes hold
 *
 *   [sbsd] Bundle captured: 577396 bytes from /.well-known/sbsd/b66432
 *   [sbsd] Ledger issued: cap=3
 *   SBSD carriers answered: 1
 *   [abck] Cookie update: round=5 rval=0 accepted=true
 *   RESULT: SUCCESS - Akamai solved, reached "Hotels by Hilton …"
 *
 * ~13s end to end, and `_abck` on round 5 — the same round `hilton.ts` takes
 * on Chrome and `comcast-lightpanda.ts` takes on this browser. The two lanes
 * do not interfere: the ledger is spent on the bootstrap, the reload lands,
 * and the session then runs against the real document like any sensor-only
 * target.
 *
 * ## it needed a change to src/mitm.ts, and that is the interesting part
 *
 * This did not run at all at first. It failed on the very first navigation,
 * five seconds in, with Lightpanda rendering `OperationTimedout` — which reads
 * as a slow site and is not one. hilton.com does not answer undici. Timed from
 * here with the same headers and no browser involved:
 *
 *                              through the proxy      direct
 *   www.hilton.com/en/         no answer in 60s       403 after 41.6s
 *   www.aircanada.com/…/home   403 in 1.0s            403 in 0.6s
 *
 * A fast 403 is a challenge and is how every example here starts. Hilton
 * instead holds the connection and answers late or never, which is a tarpit
 * for a client it has already decided about — and since `src/lightpanda.ts`
 * re-originates *all* of the browser's traffic through the MITM, that verdict
 * applied to every request the page made, not one.
 *
 * `src/mitm.ts` now makes its upstream requests with Chrome's cipher suites,
 * curve order and sigalgs rather than OpenSSL's defaults, which took the same
 * request from `403 after 46s` to `200 in 351ms`. See `CHROME_TLS` there for
 * the measurements and for what it still does not cover.
 *
 * That is the same wall the README's "HTTP, Python and Lightpanda" section
 * describes for aa.com, so it is worth re-measuring that flow now.
 *
 * The exit address remains the variable to suspect before anything in here:
 * `hilton.ts`'s header records one desktop address going 2/4 and then 0/2
 * within a single session, and an `_abck` that sits at `~-1~` past ten rounds
 * is that, not a solver fault.
 */
import { PROFILE, SEC_CH_UA } from '#src/profile.js';
import { attach } from '#src/akamai/sbsd/solver.js';
import { outerHtml, start } from '#src/lightpanda.js';
import {
  RATE_LIMIT_EXIT_CODE,
  RateLimitError,
  reportRateLimit,
} from '#src/rate-limit.js';

const ORIGIN = 'https://www.hilton.com';
const url = `${ORIGIN}/en/`;
const solverHost = process.env['host'];
const proxy = process.env['proxy'];
const solverApiKey = process.env['api_key'];

if (!solverHost) throw new Error('set host= in .env');

const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The identity the SBSD solver was told about — see solver.ts's PROFILE_ID. */
const IDENTITY = {
  'sec-ch-ua': SEC_CH_UA,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'user-agent': PROFILE.userAgent,
};

// proxy= is optional here, same as every other Lightpanda example — with
// none set, start() and the browser both just go out from this machine.
const session = await start({
  identity: IDENTITY,
  log,
  ...(proxy ? { proxy } : {}),
});
let exitCode = 0;

process.once('SIGINT', () => {
  log('Caught SIGINT');
  void session.stop().then(() => process.exit(0));
});
process.once('SIGTERM', () => {
  log('Caught SIGTERM');
  void session.stop().then(() => process.exit(0));
});

if (!session.mitm) throw new Error('the MITM proxy did not start');
const { mitm, page } = session;

/**
 * `hilton.ts` waits for `#location-input` to know the bootstrap has reloaded
 * into the real page. That input is in the DOM here too, but waiting on it
 * with Playwright means waiting for it to be *visible*, which needs a layout
 * engine. So the bootstrap is detected the way the SBSD examples detect it
 * everywhere else: a carrier answered, then a quiet window with no new
 * document.
 */
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

// Installed before the first navigation: the SBSD carrier fires during the
// bootstrap document, and a router attached afterwards would miss it.
const akamai = attach(page, {
  fetchResponse: mitm.fetch,
  host: solverHost,
  origin: ORIGIN,
  readHtml: () => outerHtml(page.mainFrame()),
  // No `sensor: 'page'` here, unlike aircanada: hilton gates everything after
  // the first document on `_abck`, so the solver drives that lane as well.
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

try {
  await page.goto(url, { timeout: 90_000, waitUntil: 'domcontentloaded' });
  await settle();
  log(`Document reached: ${page.url()}`);
  log(`SBSD carriers answered: ${akamai.carriersAnswered()}`);

  // The SBSD lane having done nothing at all has to be its own failure. Unlike
  // aircanada, hilton does gate this document — but a bootstrap that never
  // reloaded also has no sensor script on it, and `solveAbck()` below would
  // then fail with "no _abck sensor script was captured", which reads as a
  // sensor problem for what is an SBSD one.
  if (akamai.carriersAnswered() === 0)
    throw new Error('no SBSD carrier was answered — the bundle never ran');

  // `hilton.ts`'s own landmark, waited on for `attached` rather than the
  // default `visible`. Presence is a DOM fact and visibility is a layout one,
  // and Lightpanda has a DOM but no layout — so this is the one place where
  // the Chrome file's wait ports directly, just with the state named.
  await page.locator('#location-input').waitFor({
    state: 'attached',
    timeout: 90_000,
  });
  log(`Real document reached: ${page.url()}`);

  /* The sensor script is fetched by the real page, so it arrives *after* the
   * document does — measured at 1.35s after, which is long enough to lose.
   * The first run here failed on exactly that: `solveAbck()` said "no _abck
   * sensor script was captured on this page", and the capture line landed in
   * the log a second and a half later.
   *
   * There is nothing on the handle to wait for — `bmMain` is private to
   * `attach()` — so this retries the call itself. That is safe because the
   * check is the first thing `solveAbck()` does: with no script captured it
   * throws before opening a socket or sending anything, so a retry costs a
   * function call. Anything else it throws is a real failure and comes
   * straight back out. */
  const abckDeadline = Date.now() + 30_000;
  for (;;) {
    try {
      await akamai.solveAbck();
      break;
    } catch (error) {
      const waiting =
        /no _abck sensor script was captured/u.test((error as Error).message) &&
        Date.now() < abckDeadline;
      if (!waiting) throw error;
      await sleep(500);
    }
  }
  log('_abck accepted');

  // Same substitution `aircanada-lightpanda.ts` makes: the title is served by
  // hilton rather than assembled by the app, so it does not wait on hydration
  // the way a landmark element does. The bootstrap's title is not this one.
  const deadline = Date.now() + 60_000;
  let title = '';
  for (;;) {
    title = await page.title();
    if (/hotels by hilton/i.test(title) || Date.now() > deadline) break;
    await sleep(500);
  }
  if (!/hotels by hilton/i.test(title)) {
    const html = await outerHtml(page.mainFrame());
    throw new Error(
      `title never became the real page's ("${title}", ${html.length} bytes on the page)`
    );
  }

  log(`Final URL: ${page.url()}`);
  log(`RESULT: SUCCESS - Akamai solved, reached "${title}"`);
} catch (error) {
  if (error instanceof RateLimitError) {
    exitCode = RATE_LIMIT_EXIT_CODE;
    reportRateLimit(error);
  } else {
    exitCode = 1;
    log(`RESULT: FAIL - ${(error as Error).message}`);
    const html = await outerHtml(page.mainFrame()).catch(() => '');
    if (/access denied/i.test(html)) {
      log('(the page itself says Access Denied)');
    } else {
      log(
        `(${html.length} bytes on the page; first 300: ${html.slice(0, 300)})`
      );
    }
  }
} finally {
  // Before the browser goes, not after: `attach()` leaves a router installed
  // for the carriers, and closing underneath one in flight makes Playwright
  // throw `browserContext.addCookies: Target page, context or browser has
  // been closed` out of the route callback — asynchronously, where this
  // try/catch cannot reach it. `hilton.ts` does the same thing in `cleanup()`
  // for the same reason.
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined);
  await session.stop();
}

process.exit(exitCode);
