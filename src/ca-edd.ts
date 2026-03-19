/**
 * run this script:

npx tsx src/ca-edd.ts

*/
import { chromium } from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';
import * as dotenv from 'dotenv';

dotenv.config();

const url = 'https://eddservices.edd.ca.gov/tap/secure/eservices';
const solver = `ws://${process.env.host}:3000/akamai/session-headless`;
const headed = true;
const proxy = process.env.proxy;
const eddUsername = process.env.username;
const eddPassword = process.env.password;

if (!solver) throw new Error('set solver in .env file');
if (!proxy) throw new Error('set proxy in .env file');
if (!eddUsername) throw new Error('set username in .env file');
if (!eddPassword) throw new Error('set password in .env file');

// Chrome 144 macOS profile
const PROFILE = {
  chromeFullVersion: '144.0.7559.97',
  timezone: 'America/New_York',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.97 Safari/537.36',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CookieRecord = Record<string, string>;

type PlaywrightProxy = {
  password?: string;
  server: string;
  username?: string;
};

type SessionData = {
  cookies: CookieRecord;
  html: string;
  script: string;
  scriptUrl: string;
  url: string;
};

type SolverMessage = {
  accepted?: boolean;
  body?: string;
  cookies?: CookieRecord;
  headers?: Record<string, string>;
  id?: string;
  message?: string;
  method?: string;
  round?: number;
  rval?: number;
  state?: string;
  status?: number;
  type: string;
  url?: string;
};

const cookiesToRecord = (
  cookies: Array<{ name: string; value: string }>
): CookieRecord => {
  const record: CookieRecord = {};
  for (const c of cookies) {
    record[c.name] = c.value;
  }
  return record;
};

const extractAkamaiScriptUrl = (
  html: string,
  baseUrl: string
): null | string => {
  // Pattern 1: akam pixel tag
  const akamPixelRe = /akam\/13.*?top:\s?-999px.*?src="(.*?)"/gm;
  let match = akamPixelRe.exec(html);
  if (match) return new URL(match[1], baseUrl).href;

  // Pattern 2: Long random-looking path
  const longPathRe =
    // eslint-disable-next-line security/detect-unsafe-regex
    /<script[^>]+src=["']((?:\/[a-zA-Z0-9\-_]+){5,10}(?:\?v=[^"']*)?)["']/im;
  match = longPathRe.exec(html);
  if (match) return new URL(match[1], baseUrl).href;

  // Pattern 3: Known Akamai keywords
  const knownKeywordRe =
    /<script[^>]+src=["']([^"']*\/(?:akam|_abck|bm-)[^"']+)["']/im;
  match = knownKeywordRe.exec(html);
  if (match) return new URL(match[1], baseUrl).href;

  return null;
};

const getAbckStatus = (value: string | undefined): null | string => {
  if (!value) return null;
  return value.split('~')[1] ?? null;
};

const log = (msg: string, ...extra: unknown[]): void => {
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);
};

const parsePlaywrightProxy = (raw: string): null | PlaywrightProxy => {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasScheme = /^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed);
  const candidateUrl = hasScheme ? trimmed : `http://${trimmed}`;
  const parsed = new URL(candidateUrl);
  const server = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  return {
    password: decodeURIComponent(parsed.password || '') || undefined,
    server,
    username: decodeURIComponent(parsed.username || '') || undefined,
  };
};

const sanitizeHtml = (html: null | string): string => {
  if (!html) return '<!DOCTYPE html><html><head></head><body></body></html>';
  return html.replace(
    // eslint-disable-next-line security/detect-unsafe-regex
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gim,
    ''
  );
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

log('Launching browser...');

const proxyConfig = parsePlaywrightProxy(proxy);

const browser = await chromium.launch({
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
  ],
  channel: 'chrome',
  headless: !headed,
  proxy: proxyConfig || undefined,
});

const context: BrowserContext = await browser.newContext({
  ignoreHTTPSErrors: true,
  locale: 'en-US',
  timezoneId: PROFILE.timezone,
  userAgent: PROFILE.userAgent,
  viewport: null,
});

const page: Page = await context.newPage();

// CDP: Override UA + client hints for Chrome 144
const cdpClient = await context.newCDPSession(page);
await cdpClient.send('Emulation.setUserAgentOverride', {
  acceptLanguage: 'en-US,en;q=0.9',
  userAgent: PROFILE.userAgent,
  userAgentMetadata: {
    architecture: 'arm',
    bitness: '64',
    brands: [
      { brand: 'Not(A:Brand', version: '8' },
      { brand: 'Chromium', version: '144' },
      { brand: 'Google Chrome', version: '144' },
    ],
    fullVersion: '144.0.7559.97',
    fullVersionList: [
      { brand: 'Not(A:Brand', version: '8.0.0.0' },
      { brand: 'Chromium', version: '144.0.7559.97' },
      { brand: 'Google Chrome', version: '144.0.7559.97' },
    ],
    mobile: false,
    model: '',
    platform: 'macOS',
    platformVersion: '15.7.3',
  },
});

let ws: null | WebSocket = null;
let closing = false;
let sessionPageUrl: null | string = null;
let akamaiPostPath: null | string = null;
let sandboxSubmissionInFlight = false;
let navigationInProgress = false;

// Promise that resolves when the solver reports acceptance
let solverAcceptedResolve: () => void;
const solverAccepted = new Promise<void>((r) => {
  solverAcceptedResolve = r;
});

function cleanup(): void {
  closing = true;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(1000, 'Client shutting down');
  }
  browser.close().catch(() => {});
}

process.on('SIGINT', () => {
  log('Caught SIGINT, shutting down...');
  cleanup();
  setTimeout(() => process.exit(0), 1000);
});
process.on('SIGTERM', () => {
  log('Caught SIGTERM, shutting down...');
  cleanup();
  setTimeout(() => process.exit(0), 1000);
});

// ---------------------------------------------------------------------------
// Solver session management
// ---------------------------------------------------------------------------

const startSolverSession = (sessionData: SessionData): void => {
  // Close existing WS
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(1000, 'New session');
  }

  sessionPageUrl = sessionData.url;
  akamaiPostPath = new URL(sessionData.scriptUrl).pathname;

  log(`Connecting to solver WS: ${solver}`);
  ws = new WebSocket(solver);

  const currentWs = ws;

  currentWs.addEventListener('open', () => {
    log('WS connected, sending init...');
    currentWs.send(
      JSON.stringify({
        cookies: sessionData.cookies,
        html: sessionData.html,
        profile: {
          brands: [
            { brand: 'Not(A:Brand', version: '8' },
            { brand: 'Chromium', version: '144' },
            { brand: 'Google Chrome', version: '144' },
          ],
          chromeFullVersion: PROFILE.chromeFullVersion,
          chromeVersion: '144',
          deviceMemory: 8,
          hardwareConcurrency: 10,
          languages: 'en-US,en',
          os: 'macOS',
          platformVersion: '15.7.3',
          screen: {
            availHeight: 944,
            availLeft: 0,
            availTop: 32,
            availWidth: 1512,
            colorDepth: 30,
            devicePixelRatio: 2,
            height: 982,
            innerHeight: 761,
            innerWidth: 1200,
            outerHeight: 900,
            outerWidth: 1200,
            pixelDepth: 30,
            screenX: 0,
            screenY: 32,
            width: 1512,
          },
          timezone: PROFILE.timezone,
        },
        proxy: proxy || 'none',
        script: sessionData.script,
        scriptUrl: sessionData.scriptUrl,
        type: 'init',
        url: sessionData.url,
      })
    );
  });

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  currentWs.addEventListener('message', async (event: MessageEvent) => {
    // Ignore messages from superseded sessions
    if (closing || currentWs !== ws) return;

    let msg: SolverMessage;
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      log('WS: received invalid JSON');
      return;
    }

    switch (msg.type) {
      case 'cookie_update': {
        const { accepted, cookies, round, rval } = msg;
        const abckValue = cookies?._abck || cookies?.['_abck'];
        const status = getAbckStatus(abckValue);
        log(
          `Cookie update: round=${round} rval=${rval} accepted=${accepted} _abck=~${status}~`
        );

        if (cookies && typeof cookies === 'object') {
          if (!sessionPageUrl) break;
          const targetUrl = new URL(sessionPageUrl);
          const cookiesToSet = Object.entries(cookies).map(([name, value]) => ({
            domain: targetUrl.hostname,
            name,
            path: '/',
            value: String(value),
          }));
          if (cookiesToSet.length > 0) {
            await context.addCookies(cookiesToSet);
          }
        }

        if (accepted) {
          log('SUCCESS: Akamai challenge accepted!');
          solverAcceptedResolve();
        }
        break;
      }

      case 'error': {
        log(`Solver error: ${msg.message}`);
        break;
      }

      case 'status': {
        log(`Status: state=${msg.state} round=${msg.round}`);
        if (msg.state === 'accepted') {
          log('Solver reports acceptance. Browser cookies updated.');
          solverAcceptedResolve();
        } else if (msg.state === 'error') {
          log('Solver reports error state.');
        }
        break;
      }

      case 'submission': {
        const {
          body,
          headers: serverHeaders,
          id,
          method,
          url: submissionUrl,
        } = msg;
        // Capture before any awaits — sessionPageUrl can change on navigation
        const cookieUrl = sessionPageUrl!; // eslint-disable-line @typescript-eslint/no-non-null-assertion
        log(
          `Submission ${id}: ${method} ${submissionUrl} (${typeof body === 'string' ? body.length : 0} bytes)`
        );

        // Build headers from sandbox-provided XHR.setRequestHeader calls.
        // Cache-Control/Pragma aren't auto-set by XHR — add them to match
        // real Chrome sensor POSTs.
        const xhrHeaders: Record<string, string> = {};
        if (serverHeaders && typeof serverHeaders === 'object') {
          Object.assign(xhrHeaders, serverHeaders);
        }
        if (!xhrHeaders['Cache-Control'] && !xhrHeaders['cache-control']) {
          xhrHeaders['Cache-Control'] = 'no-cache';
        }
        if (!xhrHeaders['Pragma'] && !xhrHeaders['pragma']) {
          xhrHeaders['Pragma'] = 'no-cache';
        }

        try {
          sandboxSubmissionInFlight = true;
          const result = await page.evaluate(
            ({
              body,
              headers,
              method,
              url,
            }: {
              body: string;
              headers: Record<string, string>;
              method: string;
              url: string;
            }) => {
              return new Promise<{ body: string; status: number }>(
                (resolve, reject) => {
                  const xhr = new XMLHttpRequest();
                  xhr.open(method, url, true);
                  xhr.withCredentials = true;
                  if (headers) {
                    for (const [name, value] of Object.entries(headers)) {
                      xhr.setRequestHeader(name, value);
                    }
                  }
                  xhr.onload = () => {
                    resolve({ body: xhr.responseText, status: xhr.status });
                  };
                  xhr.onerror = () => {
                    reject(new Error('XHR request failed'));
                  };
                  xhr.send(body);
                }
              );
            },
            {
              body: body ?? '',
              headers: xhrHeaders,
              method: method ?? 'POST',
              url: submissionUrl ?? '',
            }
          );

          sandboxSubmissionInFlight = false;

          const postCookies = await context.cookies(cookieUrl);
          const postCookieRecord = cookiesToRecord(postCookies);

          log(
            `Submission ${id}: response ${result.status} (${result.body.length} bytes)`
          );

          if (currentWs.readyState === WebSocket.OPEN) {
            currentWs.send(
              JSON.stringify({
                body: result.body,
                cookies: postCookieRecord,
                id,
                status: result.status,
                type: 'submission_response',
              })
            );
          }
        } catch (e) {
          sandboxSubmissionInFlight = false;
          log(`ERROR: Submission ${id} failed: ${(e as Error).message}`);
          if (currentWs.readyState === WebSocket.OPEN) {
            currentWs.send(
              JSON.stringify({
                body: `Client error: ${(e as Error).message}`,
                id,
                status: 0,
                type: 'submission_response',
              })
            );
          }
        }
        break;
      }

      default:
        log(`Unknown message type: ${msg.type}`);
    }
  });

  currentWs.addEventListener('close', (event) => {
    const { code, reason } = event as unknown as {
      code: number;
      reason: string;
    };
    log(`WS closed: code=${code} reason=${reason || 'none'}`);
    if (!closing && currentWs === ws) {
      log('Solver session ended. Browser remains open for inspection.');
    }
  });

  currentWs.addEventListener('error', (event: Event) => {
    log(`WS error: ${(event as ErrorEvent).message}`);
  });
};

// ---------------------------------------------------------------------------
// Navigate and capture Akamai script (initial load)
// ---------------------------------------------------------------------------

log(`Navigating to ${url}`);

const capturedScripts = new Map<string, string>();
await page.route('**/*', async (route) => {
  const request = route.request();
  const url = request.url();

  if (request.resourceType() === 'script') {
    try {
      const response = await route.fetch();
      const body = await response.text();
      capturedScripts.set(url, body);
      await route.fulfill({ body, response });
      return;
    } catch {
      // fallthrough
    }
  }
  try {
    await route.continue();
  } catch {
    // route already handled
  }
});

await page.goto(url, {
  timeout: 30000,
  waitUntil: 'domcontentloaded',
});

const pageHtml = await page.content();
const pageUrl = page.url();

let akamaiScriptUrl = extractAkamaiScriptUrl(pageHtml, pageUrl);
let akamaiScriptSource: null | string = null;

if (akamaiScriptUrl) {
  log(`Detected Akamai script URL: ${akamaiScriptUrl}`);

  for (const [url, source] of capturedScripts) {
    if (
      url === akamaiScriptUrl ||
      url.startsWith(akamaiScriptUrl.split('?')[0])
    ) {
      akamaiScriptSource = source;
      break;
    }
  }

  if (!akamaiScriptSource) {
    log('Script not captured via route, fetching directly...');
    try {
      akamaiScriptSource = await page.evaluate(async (url: string) => {
        const res = await fetch(url);
        return res.text();
      }, akamaiScriptUrl);
    } catch (e) {
      log(`ERROR: Failed to fetch Akamai script: ${(e as Error).message}`);
    }
  }
}

if (!akamaiScriptSource) {
  log(
    'ERROR: Could not capture Akamai script source. Trying largest captured script...'
  );
  let largest: { source: string; url: string } | null = null;
  for (const [url, source] of capturedScripts) {
    if (!largest || source.length > largest.source.length) {
      largest = { source, url };
    }
  }
  if (largest && largest.source.length > 10000) {
    akamaiScriptUrl = largest.url;
    akamaiScriptSource = largest.source;
    log(
      `Using largest captured script: ${akamaiScriptUrl} (${akamaiScriptSource.length} bytes)`
    );
  } else {
    log('FATAL: No suitable Akamai script found. Exiting.');
    await browser.close();
    process.exit(1);
  }
}

// Replace capture route with persistent blocking route
await page.unroute('**/*');

await page.route('**/*', async (route) => {
  const req = route.request();
  const reqPath = new URL(req.url()).pathname;
  if (
    req.method() === 'POST' &&
    akamaiPostPath &&
    reqPath === akamaiPostPath &&
    !sandboxSubmissionInFlight
  ) {
    log(`Blocked browser Akamai POST: ${req.url()}`);
    try {
      await route.abort();
    } catch {
      // route already handled
    }
    return;
  }
  try {
    await route.continue();
  } catch {
    // route already handled
  }
});

const browserCookies = await context.cookies(pageUrl);
const cookieRecord = cookiesToRecord(browserCookies);
const sanitizedHtml = sanitizeHtml(pageHtml);

log(
  `Captured: script=${akamaiScriptSource.length} bytes, html=${sanitizedHtml.length} bytes, cookies=${Object.keys(cookieRecord).length}`
);

// Start initial solver session
startSolverSession({
  cookies: cookieRecord,
  html: sanitizedHtml,
  script: akamaiScriptSource,
  scriptUrl: akamaiScriptUrl!, // eslint-disable-line @typescript-eslint/no-non-null-assertion
  url: pageUrl,
});

// ---------------------------------------------------------------------------
// Navigation listener — detect new page loads and start new solver sessions
// ---------------------------------------------------------------------------

page.on('framenavigated', async (frame) => {
  if (frame !== page.mainFrame()) return;
  if (closing || navigationInProgress) return;

  const newUrl = frame.url();
  if (newUrl === 'about:blank' || newUrl === sessionPageUrl) return;

  navigationInProgress = true;
  log(`Navigation detected: ${newUrl}`);

  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });

    const html = await page.content();
    const url = page.url();

    const scriptUrl = extractAkamaiScriptUrl(html, url);
    if (!scriptUrl) {
      log(
        'No Akamai script detected on navigated page, skipping solver session'
      );
      return;
    }

    log(`Detected Akamai script on new page: ${scriptUrl}`);

    // Fetch script source (already loaded by the browser, likely cached)
    let scriptSource: string;
    try {
      scriptSource = await page.evaluate(async (url: string) => {
        const res = await fetch(url);
        return res.text();
      }, scriptUrl);
    } catch (e) {
      log(
        `Failed to fetch Akamai script on navigation: ${(e as Error).message}`
      );
      return;
    }

    const cookies = cookiesToRecord(await context.cookies(url));
    const sanitized = sanitizeHtml(html);

    log(
      `Captured on navigation: script=${scriptSource.length} bytes, html=${sanitized.length} bytes, cookies=${Object.keys(cookies).length}`
    );

    startSolverSession({
      cookies,
      html: sanitized,
      script: scriptSource,
      scriptUrl,
      url,
    });
  } catch (e) {
    log(`Navigation handling error: ${(e as Error).message}`);
  } finally {
    navigationInProgress = false;
  }
});

// ---------------------------------------------------------------------------
// Wait for solver acceptance, then sign in
// ---------------------------------------------------------------------------

log('Waiting for solver acceptance...');
await Promise.race([
  solverAccepted,
  sleep(120000).then(() => {
    throw new Error('Solver acceptance timeout (120s)');
  }),
]);

// Cleanly close the solver WS so the server destroys the session and
// stops sending further submission messages (prevents in-flight
// page.evaluate() from racing against browser.close()).
closing = true;

const wsSnapshot = ws as null | WebSocket;
if (wsSnapshot && wsSnapshot.readyState === WebSocket.OPEN) {
  log('Acceptance received — closing solver WS session');
  wsSnapshot.close(1000, 'Accepted');
}
await sleep(500);

// Sign in
let signInFailed = false;
try {
  await sleep(7000);
  await page.fill('#username', eddUsername);
  await page.fill('#txtPassword', eddPassword);
  await page.locator('div.btn.btn-primary', { hasText: 'Log In' }).click();
  log('Clicked Log In');
  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
} catch (e) {
  log(`ERROR: Failed to fill/click sign in: ${(e as Error).message}`);
  signInFailed = true;
}

let exitCode: number;
if (signInFailed) {
  exitCode = 1;
} else {
  const postSignInWaitMs = 2000 + Math.random() * 3000;
  log(
    `Waiting ${Math.round(postSignInWaitMs)}ms after sign-in before checking result...`
  );
  await sleep(postSignInWaitMs);

  exitCode = 0;
  try {
    const html = await page.content();
    const currentUrl = page.url();
    log(`Final URL: ${currentUrl}`);

    if (
      /<H1>\s*Access Denied\s*<\/H1>/i.test(html) ||
      html.includes('Access Denied')
    ) {
      log('FAILURE: Access Denied page detected');
      exitCode = 2;
    } else {
      log('SUCCESS: Page loaded without access denial');
    }
  } catch (e) {
    log(`ERROR: Failed to check page result: ${(e as Error).message}`);
    exitCode = 1;
  }
}

log(`Exiting with code ${exitCode}`);
const forceExit = setTimeout(() => process.exit(exitCode), 3000);
forceExit.unref();
await browser.close().catch(() => {});
process.exit(exitCode);
