/**
 * run this script:

npx tsx src/ca-edd.ts

*/
import { chromium } from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';
import * as dotenv from 'dotenv';

dotenv.config();

const url = 'https://eddservices.edd.ca.gov/tap/secure/eservices';
const solver = `ws://${process.env.host}:3000/akamai/session`;
const proxy = process.env.proxy;
const eddUsername = process.env.username;
const eddPassword = process.env.password;
let ws: null | WebSocket = null;
const closing = false;
let sessionPageUrl: null | string = null;
let navigationInProgress = false;
const capturedScripts = new Map<string, string>();

if (!solver) throw new Error('set solver in .env file');
if (!proxy) throw new Error('set proxy in .env file');
if (!eddUsername) throw new Error('set username in .env file');
if (!eddPassword) throw new Error('set password in .env file');

// Chrome 146 macOS profile
const PROFILE = {
  chromeFullVersion: '146.0.7680.81',
  screen: {
    devicePixelRatio: 2,
    height: 982,
    innerHeight: 761,
    innerWidth: 1200,
    width: 1512,
  },
  timezone: 'America/New_York',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
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
  for (const c of cookies) record[c.name] = c.value;
  return record;
};

const extractAkamaiScriptUrl = (
  html: string,
  baseUrl: string
): null | string => {
  // Pattern 1: akam pixel tag
  const akamPixelRe = /akam\/13.*?top:\s?-999px.*?src="(.*?)"/gm;
  let match = akamPixelRe.exec(html);
  if (match) return new URL(match[1] ?? '', baseUrl).href;

  // Pattern 2: Long random-looking path
  const longPathRe =
    // eslint-disable-next-line security/detect-unsafe-regex
    /<script[^>]+src=["']((?:\/[a-zA-Z0-9\-_]+){5,10}(?:\?v=[^"']*)?)["']/im;
  match = longPathRe.exec(html);
  if (match) return new URL(match[1] ?? '', baseUrl).href;

  // Pattern 3: Known Akamai keywords
  const knownKeywordRe =
    /<script[^>]+src=["']([^"']*\/(?:akam|_abck|bm-)[^"']+)["']/im;
  match = knownKeywordRe.exec(html);
  if (match) return new URL(match[1] ?? '', baseUrl).href;

  return null;
};

const isLikelyAkamaiScriptUrl = (url: string): boolean => {
  const pathname = new URL(url).pathname;
  if (/^(\/[a-zA-Z0-9\-_]+){5,}$/.test(pathname)) return true;
  if (/\/(?:akam|_abck|bm-)/.test(pathname)) return true;
  return false;
};

const getAbckStatus = (value: string | undefined): null | string => {
  if (!value) return null;
  return value.split('~')[1] ?? null;
};

const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

const parsePlaywrightProxy = (raw: string): null | PlaywrightProxy => {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasScheme = /^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed);
  const candidateUrl = hasScheme ? trimmed : `http://${trimmed}`;
  const parsed = new URL(candidateUrl);
  const server = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  const sessionId = Math.floor(Math.random() * 999) + 1;
  const username =
    decodeURIComponent(parsed.username || '').replace(
      /-session-\d+-/,
      `-session-${sessionId}-`
    ) || undefined;
  const password = decodeURIComponent(parsed.password || '') || undefined;
  return {
    ...(password !== undefined ? { password } : {}),
    server,
    ...(username !== undefined ? { username } : {}),
  };
};

const removesScriptTagsFromHtml = (html: string): string =>
  html.replace(
    // eslint-disable-next-line security/detect-unsafe-regex
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gim,
    ''
  );

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Promise that resolves when the solver reports acceptance
let solverAcceptedResolve: () => void;
const solverAccepted = new Promise<void>((r) => {
  solverAcceptedResolve = r;
});

const addRouteInterceptor = async (page: Page) =>
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();

    if (request.resourceType() === 'script') {
      try {
        const response = await route.fetch();
        const body = await response.text();
        capturedScripts.set(url, body);
        if (isLikelyAkamaiScriptUrl(url)) await route.abort();
        else await route.fulfill({ body, response });

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

const fetchAkamaiScriptSource = async (
  akamaiScriptUrl: string,
  page: Page
): Promise<null | string> => {
  log(`Detected Akamai script URL: ${akamaiScriptUrl}`);

  for (const [url, source] of capturedScripts) {
    if (
      url === akamaiScriptUrl ||
      url.startsWith(akamaiScriptUrl.split('?')[0] ?? akamaiScriptUrl)
    )
      return source;
  }

  log('Script not captured via route, fetching directly...');
  try {
    return await page.evaluate(async (url: string) => {
      const res = await fetch(url);
      return res.text();
    }, akamaiScriptUrl);
  } catch (e) {
    log(`ERROR: Failed to fetch Akamai script: ${(e as Error).message}`);
    return null;
  }
};

const initSession = async (page: Page) => {
  await addRouteInterceptor(page);

  page.on('framenavigated', async (frame) => {
    if (frame !== page.mainFrame()) return;
    if (closing || navigationInProgress) return;

    const newUrl = frame.url();
    if (newUrl === 'about:blank' || newUrl === sessionPageUrl) return;

    navigationInProgress = true;
    log(`Navigation detected: ${newUrl}`);

    try {
      await page.waitForLoadState('domcontentloaded');

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

      startSolverSession({
        cookies,
        html: removesScriptTagsFromHtml(html),
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
};

// ---------------------------------------------------------------------------
// Solver session management
// ---------------------------------------------------------------------------

const startSolverSession = (sessionData: {
  cookies: CookieRecord;
  html: string;
  script: string;
  scriptUrl: string;
  url: string;
}): void => {
  // Close existing WS
  if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'New session');

  sessionPageUrl = sessionData.url;

  log(`Connecting to solver WS: ${solver}`);
  ws = new WebSocket(solver);

  const currentWs = ws;

  currentWs.addEventListener('open', () => {
    log('WS connected, sending init...');
    currentWs.send(
      JSON.stringify({
        cookies: sessionData.cookies,
        html: sessionData.html,
        proxy,
        script: sessionData.script,
        scriptUrl: sessionData.scriptUrl,
        type: 'init',
        url: sessionData.url,
      })
    );
  });

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  currentWs.addEventListener('message', async (event: MessageEvent) => {
    if (closing || currentWs !== ws) return; // Ignore messages from superseded sessions

    const msg = JSON.parse(event.data as string) as SolverMessage;

    switch (msg.type) {
      case 'error': {
        log(`Solver error: ${msg.message}`);
        break;
      }

      case 'status': {
        if (msg.state === 'accepted') {
          log('[info] Solver reports cookie acceptance');
          solverAcceptedResolve();
        } else if (msg.state === 'error') log('Solver reports error state.');
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
        if (serverHeaders && typeof serverHeaders === 'object')
          Object.assign(xhrHeaders, serverHeaders);
        if (!xhrHeaders['Cache-Control'] && !xhrHeaders['cache-control'])
          xhrHeaders['Cache-Control'] = 'no-cache';
        if (!xhrHeaders['Pragma'] && !xhrHeaders['pragma'])
          xhrHeaders['Pragma'] = 'no-cache';

        try {
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
                  if (headers)
                    for (const [name, value] of Object.entries(headers))
                      xhr.setRequestHeader(name, value);
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

          const postCookies = await context.cookies(cookieUrl);
          const postCookieRecord = cookiesToRecord(postCookies);

          log(
            `Submission ${id}: response ${result.status} (${result.body.length} bytes)`
          );

          if (currentWs.readyState === WebSocket.OPEN)
            currentWs.send(
              JSON.stringify({
                body: result.body,
                cookies: postCookieRecord,
                id,
                status: result.status,
                type: 'submission_response',
              })
            );
        } catch (e) {
          log(`ERROR: Submission ${id} failed: ${(e as Error).message}`);
          if (currentWs.readyState === WebSocket.OPEN)
            currentWs.send(
              JSON.stringify({
                body: `Client error: ${(e as Error).message}`,
                id,
                status: 0,
                type: 'submission_response',
              })
            );
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
    if (!closing && currentWs === ws)
      log('Solver session ended. Browser remains open for inspection.');
  });

  currentWs.addEventListener('error', (event: Event) => {
    log(`WS error: ${(event as ErrorEvent).message}`);
  });
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const parsedProxy = parsePlaywrightProxy(proxy);
const browser = await chromium.launch({
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
  ],
  channel: 'chrome',
  headless: false,
  ...(parsedProxy !== null ? { proxy: parsedProxy } : {}),
});
const context: BrowserContext = await browser.newContext({});
const page: Page = await context.newPage();

await initSession(page);
await page.goto(url);

log('Waiting for solver acceptance...');
try {
  await Promise.race([
    solverAccepted,
    sleep(15000).then(() => {
      throw new Error('Solver acceptance timeout');
    }),
  ]);
} catch (e) {
  log(`RESULT: ERROR - ${(e as Error).message}`);
  await browser.close();
  process.exit(1);
}

await sleep(1000);
await page.fill('#username', eddUsername);
await page.fill('#txtPassword', eddPassword);
await page.locator('div.btn.btn-primary', { hasText: 'Log In' }).click();
log('Clicked Log In');
await page.waitForLoadState('load');

await sleep(3000);

const html = await page.content();
const currentUrl = page.url();
log(`Final URL: ${currentUrl}`);

if (
  /<H1>\s*Access Denied\s*<\/H1>/i.test(html) ||
  html.includes('Access Denied')
)
  log('RESULT: FAIL - Access Denied');
else log('RESULT: SUCCESS - Login page accessible');

await browser.close();
process.exit(0);
