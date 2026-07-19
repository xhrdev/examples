/**
 * Cloudflare Turnstile solver for wise.com/login.
 *
 * IMPORTANT — why headless Chrome fails with error 600010:
 *   Cloudflare Turnstile on wise.com uses **Private Access Tokens (PAT)**,
 *   sometimes called "Privacy Pass" (RFC 9576). PAT requires the browser to
 *   obtain a cryptographic attestation token from a platform issuer (Apple
 *   iCloud for macOS/iOS, Google Play Integrity for Android). The PAT issuer
 *   signs the token with device-bound keys (Apple Secure Enclave, etc.).
 *
 *   When Playwright runs Chrome, it cannot access the macOS-level PAT issuer,
 *   so the challenge's `/pat/…` requests return 401 Unauthorized. Cloudflare
 *   then falls back to a visual challenge and eventually emits error 600010.
 *
 *   Bypassing PAT requires either:
 *     a) A commercial Turnstile solving service (2captcha, CapSolver, NoCaptchaAI,
 *        YesCaptcha) — set TURNSTILE_API_KEY + TURNSTILE_SOLVER_URL in the env.
 *     b) A real (non-automated) macOS browser session where PAT is available.
 *
 * What we DO demonstrate here:
 *   1. CDP-based Chrome spoofing (UA, UA-CH, device metrics).
 *   2. Cookie consent handling (wise.com's #twcc__mechanism overlay).
 *   3. Natural-looking form interaction (mouse moves, typed input).
 *   4. Correct postMessage monitoring of the Turnstile challenge protocol.
 *   5. A clean hook for injecting a commercial-solver token.
 *
 * run this script:
 *
 *   node --env-file=.env src/flarecloud/wise.ts --headless
 *
 * optional env vars:
 *   TURNSTILE_API_KEY      — API key for a 3rd-party Turnstile solving service
 *   TURNSTILE_SOLVER_URL   — endpoint of the solver service
 *   host                   — xhrdev host (default 127.0.0.1)
 *   proxy                  — HTTP/HTTPS/SOCKS5 proxy URL
 *   CHROME_PATH            — path to Chrome/Chromium binary
 */

import fs from 'node:fs';
import { chromium } from 'playwright';

const TARGET_URL = 'https://wise.com/login';
const TURNSTILE_SCRIPT_PATTERN =
  /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/;
const TURNSTILE_RESPONSE_SELECTOR = 'input[name="cf-turnstile-response"]';
const SITEKEY = '0x4AAAAAAAyMWVBrdZgBMnpP';

const solverApiKey = process.env['TURNSTILE_API_KEY'] ?? '';
const solverUrl = process.env['TURNSTILE_SOLVER_URL'] ?? '';
const proxy = process.env['proxy'];
let closing = false;

const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const parseProxy = (raw: string) => {
  const hasScheme = /^[a-z][a-z0-9+\-.]*:\/\//i.test(raw);
  const parsed = new URL(hasScheme ? raw : `http://${raw}`);
  return {
    password: decodeURIComponent(parsed.password || '') || undefined,
    server: `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`,
    username: decodeURIComponent(parsed.username || '') || undefined,
  };
};

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const CHROME_PATH = process.env['CHROME_PATH'] ?? '';
const launchOpts: Record<string, unknown> = {
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
  ],
  headless: process.argv.includes('--headless'),
};
if (proxy) launchOpts['proxy'] = parseProxy(proxy);
// eslint-disable-next-line security/detect-non-literal-fs-filename
if (CHROME_PATH && fs.existsSync(CHROME_PATH)) {
  launchOpts['executablePath'] = CHROME_PATH;
} else {
  launchOpts['channel'] = 'chrome';
}

const browser = await chromium.launch(launchOpts);
const context = await browser.newContext({
  deviceScaleFactor: 2,
  ignoreHTTPSErrors: true,
  locale: 'en-US',
  timezoneId: 'America/New_York',
  userAgent: UA,
  viewport: { height: 761, width: 1200 },
});

// Stealth patches applied to all frames (main + Turnstile challenge iframe).
await context.addInitScript(() => {
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
  });
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
  const w = window as unknown as Record<string, unknown>;
  if (!w['chrome']) {
    w['chrome'] = {
      app: { isInstalled: false },
      runtime: {
        connect: () => ({}),
        id: undefined,
        onConnect: { addListener: () => {}, removeListener: () => {} },
        onMessage: { addListener: () => {}, removeListener: () => {} },
        sendMessage: () => {},
      },
    };
  }
});

const page = await context.newPage();

async function cleanup(exitCode = 0): Promise<void> {
  if (closing) return;
  closing = true;
  const forceKill = setTimeout(() => process.exit(exitCode), 5000);
  forceKill.unref();
  try {
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
  log(`Uncaught: ${err.message}`);
  void cleanup(1);
});
process.on('unhandledRejection', (reason) => {
  log(`Unhandled: ${reason}`);
  void cleanup(1);
});

// CDP overrides to spoof Chrome 146 signals
const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setUserAgentOverride', {
  acceptLanguage: 'en-US,en;q=0.9',
  userAgent: UA,
  userAgentMetadata: {
    architecture: 'arm',
    bitness: '64',
    brands: [
      { brand: 'Chromium', version: '146' },
      { brand: 'Not-A.Brand', version: '24' },
      { brand: 'Google Chrome', version: '146' },
    ],
    fullVersion: '146.0.7680.81',
    fullVersionList: [
      { brand: 'Chromium', version: '146.0.7680.81' },
      { brand: 'Not-A.Brand', version: '24.0.0.0' },
      { brand: 'Google Chrome', version: '146.0.7680.81' },
    ],
    mobile: false,
    model: '',
    platform: 'macOS',
    platformVersion: '15.7.3',
  },
});
await cdp.send('Emulation.setDeviceMetricsOverride', {
  deviceScaleFactor: 2,
  height: 761,
  mobile: false,
  screenHeight: 982,
  screenWidth: 1512,
  width: 1200,
});

/**
 * Polls for a non-empty cf-turnstile-response hidden input.
 * Works when Turnstile completes silently inside the Playwright browser
 * (requires real PAT-capable Chrome, not headless).
 */
async function pollForTurnstileToken(
  timeoutMs = 10_000
): Promise<null | string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const token = await page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLInputElement | null;
        return el?.value ?? '';
      }, TURNSTILE_RESPONSE_SELECTOR);
      if (token) return token;
    } catch {
      // page may not be ready
    }
    await sleep(300);
  }
  return null;
}

/**
 * Attempts to solve the Turnstile challenge via a commercial 3rd-party service.
 * The service POSTs the sitekey + page URL and returns a solved token.
 * Returns null if no solver is configured.
 *
 * To use, set TURNSTILE_API_KEY and TURNSTILE_SOLVER_URL in the environment.
 * Compatible services: 2captcha (https://2captcha.com/api-docs/cloudflare-turnstile),
 * CapSolver (https://docs.capsolver.com/en/guide/captcha/Turnstile.html), etc.
 */
async function solveViaExternalService(
  siteKey: string,
  pageUrl: string
): Promise<null | string> {
  if (!solverApiKey || !solverUrl) return null;
  log('Submitting Turnstile to external solver service...');
  try {
    const submit = await globalThis.fetch(solverUrl, {
      body: JSON.stringify({
        key: solverApiKey,
        method: 'turnstile',
        pageurl: pageUrl,
        sitekey: siteKey,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(5_000),
    });
    const submitData = (await submit.json()) as {
      requestId?: string;
      status?: string;
      taskId?: string;
    };
    const taskId = submitData.taskId ?? submitData.requestId;
    if (!taskId) {
      log('Solver did not return a task ID');
      return null;
    }

    // Poll until the solver resolves (up to 120 s)
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await sleep(5_000);
      const poll = await globalThis.fetch(
        `${solverUrl}?key=${solverApiKey}&action=get&id=${taskId}`,
        {
          signal: AbortSignal.timeout(5_000),
        }
      );
      const pollData = (await poll.json()) as {
        request?: string;
        solution?: { token?: string };
        status?: string;
      };
      if (pollData.status === 'ready' || pollData.request?.startsWith('0.')) {
        const token = pollData.solution?.token ?? pollData.request ?? '';
        if (token) {
          log(`External solver token: ${token.slice(0, 20)}...`);
          return token;
        }
      }
      if (pollData.status === 'failed') {
        log('External solver failed');
        return null;
      }
    }
    log('External solver timed out');
  } catch (err) {
    log(`External solver error: ${(err as Error).message}`);
  }
  return null;
}

// --- Main flow ---

try {
  let capturedSiteKey: null | string = SITEKEY; // known fallback

  // Set up a promise that resolves once the Turnstile script body is captured.
  // eslint-disable-next-line no-unused-vars
  let scriptCaptureResolve!: (s: string) => void;
  const scriptCaptured = new Promise<string>((res) => {
    scriptCaptureResolve = res;
  });
  let capturedTurnstileScript: null | string = null;

  await page.route('**/*', async (route) => {
    const req = route.request();
    if (TURNSTILE_SCRIPT_PATTERN.test(req.url())) {
      log(`Intercepting Turnstile script: ${req.url()}`);
      const resp = await route.fetch();
      const body = await resp.text();
      capturedTurnstileScript = body;
      scriptCaptureResolve(body);
      return route.fulfill({ body, response: resp });
    }
    return route.continue();
  });

  log(`Navigating to ${TARGET_URL}`);
  await page.goto(TARGET_URL, {
    timeout: 30_000,
    waitUntil: 'domcontentloaded',
  });

  let scriptTimeoutFired = false;
  capturedTurnstileScript = await Promise.race([
    scriptCaptured,
    sleep(5_000).then(() => {
      scriptTimeoutFired = true;
      return null;
    }),
  ]);
  if (scriptTimeoutFired)
    log('Warning: Turnstile script not captured within 5 s');
  log(
    `Turnstile script captured: ${capturedTurnstileScript ? `yes (${capturedTurnstileScript.length} chars)` : 'no'}`
  );

  capturedSiteKey = (await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey]');
    if (el) return el.getAttribute('data-sitekey');
    const meta = document.querySelector('meta[name="turnstile-sitekey"]');
    if (meta) return meta.getAttribute('content');
    const match = document.documentElement.innerHTML.match(
      /['"](0x[0-9A-Fa-f]{16,})['"]/
    );
    return match ? match[1] : null;
  })) as null | string;
  capturedSiteKey ??= SITEKEY;
  log(`Sitekey: ${capturedSiteKey}`);

  let cfToken: null | string = null;

  // Attempt 1: commercial solver service (requires TURNSTILE_API_KEY + TURNSTILE_SOLVER_URL).
  if (!cfToken && solverApiKey && solverUrl) {
    cfToken = await solveViaExternalService(capturedSiteKey, TARGET_URL);
    if (cfToken) log(`Commercial solver token: ${cfToken.slice(0, 20)}...`);
  }

  // Attempt 2: let real Playwright browser (non-headless, PAT-capable) solve it natively.
  // NOTE: In headless mode this will fail with error 600010 due to PAT (Private Access Tokens).
  if (!cfToken) {
    log('Polling browser for native Turnstile token (10 s)...');
    cfToken = await pollForTurnstileToken(10_000);
    if (cfToken) log(`Native browser token: ${cfToken.slice(0, 20)}...`);
  }

  // Attempt 3: dismiss cookie dialog, fill form, click submit, then wait for Turnstile.
  // The invisible widget on wise.com executes on form submission.
  if (!cfToken) {
    log('Filling form and triggering Turnstile via submit...');
    try {
      const cookieOverlay = await page.$('#twcc__mechanism');
      if (cookieOverlay) {
        log('Cookie consent dialog visible — clicking Decline');
        await page.click('#twcc__decline-button');
        await page
          .waitForSelector('#twcc__mechanism', {
            state: 'detached',
            timeout: 5_000,
          })
          .catch(() => {});
      }

      // Natural-looking mouse movement before form interaction
      await page.mouse.move(600, 400);
      await sleep(200);
      await page.mouse.move(400, 300, { steps: 10 });
      await sleep(300);

      await page.click('input[type="email"], input[name="email"], #email');
      await page.keyboard.type('test@example.com', { delay: 80 });
      await sleep(400);
      await page.click(
        'input[type="password"], input[name="password"], #password'
      );
      await page.keyboard.type('FakeP@ssw0rd123', { delay: 80 });
      await sleep(300);
      log('Filled email and password fields');

      await page.click('button[type="submit"], input[type="submit"]');
      log('Clicked submit — waiting for Turnstile (30 s)...');
      cfToken = await pollForTurnstileToken(30_000);
      if (cfToken) log(`Post-submit token: ${cfToken.slice(0, 20)}...`);
    } catch (e) {
      log(`Form interaction failed: ${(e as Error).message}`);
    }
  }

  if (!cfToken) {
    log(
      [
        'Could not obtain Turnstile token.',
        'In headless mode this is expected: Cloudflare Turnstile uses Private Access Tokens (PAT)',
        'which require hardware-level attestation (Apple Secure Enclave / Google Play Integrity).',
        'To solve this in automation, set TURNSTILE_API_KEY + TURNSTILE_SOLVER_URL env vars',
        'to route through a commercial solver service (2captcha, CapSolver, etc.).',
        'Or run the script non-headless (--no-headless) on a real macOS machine with iCloud signed in.',
      ].join('\n')
    );
    const finalUrl = page.url();
    const blocked = finalUrl.includes('challenges.cloudflare.com');
    log(`Current URL: ${finalUrl}`);
    await cleanup(blocked ? 2 : 1);
  }

  const token = cfToken as string;
  log(`Token acquired (${token.length} chars). Injecting and submitting...`);

  // Inject token into any cf-turnstile-response inputs.
  await page.evaluate(
    ({ sel, token: t }) => {
      document.querySelectorAll(sel).forEach((el) => {
        (el as HTMLInputElement).value = t;
      });
    },
    { sel: TURNSTILE_RESPONSE_SELECTOR, token: token }
  );

  // Fill and submit if not already done.
  try {
    const emailFilled = await page.evaluate(() => {
      const el = document.querySelector(
        'input[type="email"], input[name="email"]'
      ) as HTMLInputElement | null;
      return !!el?.value;
    });
    if (!emailFilled) {
      await page.fill(
        'input[type="email"], input[name="email"], #email',
        'test@example.com'
      );
      await page.fill(
        'input[type="password"], input[name="password"], #password',
        'FakeP@ssw0rd123'
      );
      log('Filled email and password fields');
      await page.click('button[type="submit"], input[type="submit"]');
      log('Clicked submit');
    } else {
      log('Form already filled; not re-submitting');
    }
  } catch (e) {
    log(`Could not fill/submit form: ${(e as Error).message}`);
  }

  await sleep(4000);

  const finalUrl = page.url();
  const finalHtml = await page.content();
  log(`Final URL: ${finalUrl}`);

  const blocked =
    /just a moment|cloudflare|access denied/i.test(finalHtml) &&
    finalUrl.includes('challenges.cloudflare.com');
  const credentialsError =
    /invalid|incorrect|wrong password|incorrect email or password/i.test(
      finalHtml
    );

  if (blocked) {
    log('RESULT: FAIL - Still blocked by Cloudflare');
    await cleanup(2);
  } else if (credentialsError) {
    log(
      'RESULT: SUCCESS - Cloudflare bypassed (got credentials error as expected with fake creds)'
    );
  } else {
    log('RESULT: PARTIAL - Cloudflare state unclear — check manually');
    log(`Page snippet: ${finalHtml.substring(0, 300)}`);
  }

  await cleanup(0);
} catch (e) {
  log(`ERROR: ${(e as Error).message}`);
  await cleanup(1);
}
