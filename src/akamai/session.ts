/**
 * The browser every Akamai example drives, and the harness that reports how
 * its run ended.
 *
 * Thirteen scripts used to open with the same sixty lines — launch Chrome with
 * the same flags, build a context from the shared identity, install the same
 * signal handlers, define the same cleanup — and end with the same 429 and
 * error branches. They differed in a locale, a timezone and whether the
 * browser ignores certificate errors, which are the options below. What each
 * script actually does with the page is the part worth reading, so that is all
 * that is left in them.
 *
 *   openAkamaiSession   launch, identity, cleanup; for scripts that want to
 *                       own their control flow
 *   runAkamaiTarget     the same, plus the RESULT line, the exit code, and the
 *                       429 / error handling
 */
import fs from 'node:fs';
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  type LaunchOptions,
  type Page,
} from 'playwright-core';

import { applyIdentity, USER_AGENT, VIEWPORT } from '#src/akamai/identity.js';
import { PROFILE } from '#src/profile.js';
import { toLaunchProxy } from '#src/proxy.js';
import {
  RATE_LIMIT_EXIT_CODE,
  RateLimitError,
  reportRateLimit,
} from '#src/rate-limit.js';
import { log } from '#src/util.js';

export type AkamaiSession = {
  apiKey: string | undefined;
  browser: Browser;
  cdp: CDPSession;
  context: BrowserContext;
  /** The cookie jar for `origin`, as name -> value. */
  // eslint-disable-next-line no-unused-vars -- function-type parameter
  cookies(origin: string): Promise<Record<string, string>>;
  /** Close the browser and exit the process. */
  // eslint-disable-next-line no-unused-vars -- function-type parameter
  exit(code?: number): Promise<void>;
  host: string;
  page: Page;
  proxy: string | undefined;
};

export type AkamaiSessionOptions = {
  /** Chrome flags added to the three every example launches with. */
  args?: readonly string[];
  /** Left off unless a script sets it: some properties need it, most do not. */
  ignoreHTTPSErrors?: boolean;
  locale?: string;
  /** SBSD registers a service worker that would answer requests unseen. */
  serviceWorkers?: 'allow' | 'block';
  timezoneId?: string;
};

/** What a run reports: the process exit code and the text after `RESULT: `. */
export type TargetResult = { code: number; result: string };

/** Akamai's block page, which comes back as a normal 200 document. */
export const looksDenied = (html: string): boolean =>
  /<H1>\s*Access Denied\s*<\/H1>/iu.test(html) ||
  html.includes('Access Denied');

/**
 * Launch Chrome as the profile's identity and return it ready to navigate.
 *
 * Signal and crash handlers are installed before the identity is applied, so a
 * failure there still closes the browser instead of orphaning it.
 */
export async function openAkamaiSession(
  options: AkamaiSessionOptions = {}
): Promise<AkamaiSession> {
  const host = process.env['host'];
  if (!host) throw new Error('set host= in .env');
  const proxy = process.env['proxy'];
  const apiKey = process.env['api_key'];
  const chromePath = process.env['CHROME_PATH'] || '';

  const launchOptions: LaunchOptions = {
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      ...(options.args ?? []),
    ],
    headless: process.argv.includes('--headless'),
    ...(proxy ? { proxy: toLaunchProxy(proxy) } : {}),
  };
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (chromePath && fs.existsSync(chromePath)) {
    launchOptions.executablePath = chromePath;
  } else {
    launchOptions.channel = 'chrome';
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    ...(options.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
    locale: options.locale ?? 'en-US',
    ...(options.serviceWorkers
      ? { serviceWorkers: options.serviceWorkers }
      : {}),
    timezoneId: options.timezoneId ?? PROFILE.timezone,
    userAgent: USER_AGENT,
    viewport: VIEWPORT,
  });
  const page = await context.newPage();

  let closing = false;
  const exit = async (code = 0): Promise<void> => {
    if (closing) return;
    closing = true;
    const forceKill = setTimeout(() => {
      process.exit(code);
    }, 5000);
    forceKill.unref();
    try {
      // Retire the route handlers before the browser goes. Closing underneath
      // an in-flight route makes Playwright print the whole intercepted
      // response back as an unhandled "route callback" error, which buries
      // the actual result in CI logs under a few hundred lines of headers.
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await browser.close();
    } catch {
      // ignore
    }
    process.exit(code);
  };
  process.on('SIGINT', () => {
    log('Caught SIGINT');
    void exit(0);
  });
  process.on('SIGTERM', () => {
    log('Caught SIGTERM');
    void exit(0);
  });
  process.on('uncaughtException', (err) => {
    log(`Uncaught exception: ${err.message}`);
    void exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log(`Unhandled rejection: ${String(reason)}`);
    void exit(1);
  });

  // The identity the solver was told to model, installed on the real browser.
  const cdp = await context.newCDPSession(page);
  await applyIdentity(cdp);

  return {
    apiKey,
    browser,
    cdp,
    context,
    cookies: async (origin) =>
      Object.fromEntries(
        (await context.cookies(origin)).map((c) => [c.name, c.value])
      ),
    exit,
    host,
    page,
    proxy,
  };
}

/**
 * End a run that threw.
 *
 * A 429 is not a failed solve and retrying cannot help, so it is reported as
 * its own outcome with its own exit code; anything else is a solver failure.
 *
 * With `checkDenied`, a throw that leaves Akamai's block page on screen is
 * reported as a denial rather than a crash, which is what the property did to
 * us, whatever the script tripped over on the way.
 */
export async function reportRunError(
  session: Pick<AkamaiSession, 'exit' | 'page'>,
  error: unknown,
  { checkDenied = false }: { checkDenied?: boolean } = {}
): Promise<void> {
  if (error instanceof RateLimitError) {
    reportRateLimit(error);
    await session.exit(RATE_LIMIT_EXIT_CODE);
  } else if (
    checkDenied &&
    /access denied/iu.test(await session.page.content().catch(() => ''))
  ) {
    log('RESULT: FAIL - Access Denied');
    await session.exit(2);
  } else {
    log(`ERROR: Solver failed: ${(error as Error).message}`);
    await session.exit(1);
  }
}

/**
 * Open a session, run `body`, and report how it went.
 *
 * `body` returns the outcome; this logs it as the `RESULT:` line the load-test
 * runner reads and exits with its code. A throw is handled by
 * `reportRunError`.
 */
export async function runAkamaiTarget(
  options: AkamaiSessionOptions,
  // eslint-disable-next-line no-unused-vars -- function-type parameter
  body: (session: AkamaiSession) => Promise<TargetResult>
): Promise<void> {
  const session = await openAkamaiSession(options);
  try {
    const { code, result } = await body(session);
    log(`RESULT: ${result}`);
    await session.exit(code);
  } catch (e) {
    await reportRunError(session, e);
  }
}
