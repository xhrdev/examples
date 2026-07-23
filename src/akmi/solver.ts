/**
 * Akamai bot-detection solver. Intercepts the Akamai script, streams page
 * state to a remote solver service over WebSocket, then executes XHR
 * submissions as directed until the solver reports cookie acceptance.
 *
 * run this script:

node --env-file=.env src/akmi/ca-edd.ts
node --env-file=.env src/akmi/comcast.ts

*/
import type { BrowserContext, Frame, Page, Route } from 'playwright-core';

export type SolveAkamaiOptions = {
  proxy?: string;
  solverUrl: string;
  timeout?: number;
  url: string;
};

type CookieRecord = Record<string, string>;
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

const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

const cookiesToRecord = (
  cookies: Array<{ name: string; value: string }>
): CookieRecord => {
  const r: CookieRecord = {};
  for (const c of cookies) r[c.name] = c.value;
  return r;
};

const extractAkamaiScriptUrl = (
  html: string,
  baseUrl: string
): null | string => {
  // Pattern 1: akam pixel tag
  let match = /akam\/13.*?top:\s?-999px.*?src="(.*?)"/gm.exec(html);
  if (match) return new URL(match[1] ?? '', baseUrl).href;

  // Pattern 2: Long random-looking path (5–10 segments)
  /* eslint-disable security/detect-unsafe-regex */
  const longPathRe =
    /<script[^>]+src=["']((?:\/[a-zA-Z0-9\-_]+){5,10}(?:\?v=[^"']*)?)["']/im;
  /* eslint-enable security/detect-unsafe-regex */
  match = longPathRe.exec(html);
  if (match) return new URL(match[1] ?? '', baseUrl).href;

  // Pattern 3: Known Akamai keywords in path
  match = /<script[^>]+src=["']([^"']*\/(?:akam|_abck|bm-)[^"']+)["']/im.exec(
    html
  );
  if (match) return new URL(match[1] ?? '', baseUrl).href;

  return null;
};

const isLikelyAkamaiScriptUrl = (url: string): boolean => {
  const p = new URL(url).pathname;
  // eslint-disable-next-line security/detect-unsafe-regex
  return /^(\/[a-zA-Z0-9\-_]+){5,}$/.test(p) || /\/(?:akam|_abck|bm-)/.test(p);
};

const getAbckStatus = (value: string | undefined): null | string =>
  value ? (value.split('~')[1] ?? null) : null;

// eslint-disable-next-line security/detect-unsafe-regex
const STRIP_SCRIPTS_RE = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gim;
const stripScripts = (html: string): string =>
  html.replace(STRIP_SCRIPTS_RE, '');

const PROFILE = {
  deviceMemory: 8,
  hardwareConcurrency: 10,
  languages: 'en-US,en',
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
  timezone: 'America/New_York',
};

export async function solveAkamai(
  page: Page,
  opts: SolveAkamaiOptions
): Promise<void> {
  const { proxy, solverUrl, timeout = 120000, url } = opts;
  const context: BrowserContext = page.context();
  const capturedDocs = new Map<string, { html: string; url: string }>();
  const capturedScripts = new Map<string, string>();
  const sessions = new Map<string, { frame: Frame | null; ws: WebSocket }>();
  let closing = false;

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`Solver acceptance timeout (${timeout / 1000}s)`));
    }, timeout);

    const finish = () => {
      if (closing) return;
      closing = true;
      clearTimeout(timer);
      for (const { ws } of sessions.values()) {
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Done');
      }
      sessions.clear();
      page.removeListener('framenavigated', navHandler);
      page.unroute('**/*', routeHandler).catch(() => {});
    };

    const startSession = (
      origin: string,
      data: {
        cookies: CookieRecord;
        html: string;
        script: string;
        scriptUrl: string;
        url: string;
      },
      frame: Frame | null
    ) => {
      const existing = sessions.get(origin);
      if (existing?.ws.readyState === WebSocket.OPEN) {
        log(`[${origin}] Session already open, skipping duplicate start`);
        return;
      }
      if (existing) existing.ws.close(1000, 'New session');

      const ws = new WebSocket(solverUrl);
      sessions.set(origin, { frame, ws });

      ws.addEventListener('open', () => {
        log(`[${origin}] WS connected, sending init...`);
        ws.send(
          JSON.stringify({
            type: 'init',
            ...data,
            profile: PROFILE,
            profileId: 'chrome-146-macos',
            proxy,
          })
        );
      });

      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      ws.addEventListener('message', async (event: MessageEvent) => {
        if (closing || sessions.get(origin)?.ws !== ws) return;
        const msg = JSON.parse(event.data as string) as SolverMessage;

        switch (msg.type) {
          case 'cookie_update': {
            const { accepted, cookies: ck, round, rval } = msg;
            const status = getAbckStatus(ck?.['_abck']);
            log(
              `[${origin}] Cookie update: round=${round} rval=${rval} accepted=${accepted} _abck=~${status}~`
            );
            if (accepted) {
              log(`[${origin}] Cookie accepted (round ${round})`);
              finish();
              resolve();
            }
            break;
          }

          case 'error':
            log(`[${origin}] Solver error: ${msg.message}`);
            break;

          case 'status':
            if (msg.state === 'accepted') {
              log(`[${origin}] Solver reports acceptance`);
              finish();
              resolve();
            } else if (msg.state === 'error')
              log(`[${origin}] Solver reports error state.`);
            break;

          case 'submission': {
            const { body, headers: hdrs, id, method, url: subUrl } = msg;
            const cookieUrl = data.url;
            const scriptOrigin = new URL(data.url).origin;
            log(
              `[${origin}] Submission ${id}: ${method} ${subUrl} (${typeof body === 'string' ? body.length : 0} bytes)`
            );
            const xhrHeaders: Record<string, string> = {};
            if (hdrs && typeof hdrs === 'object')
              Object.assign(xhrHeaders, hdrs);
            try {
              let resultStatus: number;
              let resultBody: string;
              if (frame !== null) {
                const result = await frame.evaluate(
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
                  }) =>
                    new Promise<{ body: string; status: number }>((resolve) => {
                      const xhr = new XMLHttpRequest();
                      xhr.open(method, url, true);
                      xhr.withCredentials = true;
                      if (headers)
                        for (const [n, v] of Object.entries(headers))
                          xhr.setRequestHeader(n, v);
                      xhr.onload = () =>
                        resolve({ body: xhr.responseText, status: xhr.status });
                      xhr.send(body);
                    }),
                  {
                    body: body ?? '',
                    headers: xhrHeaders,
                    method: method ?? 'POST',
                    url: subUrl ?? '',
                  }
                );
                resultStatus = result.status;
                resultBody = result.body;
              } else {
                const submitUrl = subUrl ?? '';
                const submitMethod = method ?? 'POST';
                const resp = await context.request.fetch(submitUrl, {
                  data: body ?? '',
                  headers: {
                    ...xhrHeaders,
                    Origin: scriptOrigin,
                    Referer: data.url,
                  },
                  method: submitMethod,
                });
                resultStatus = resp.status();
                resultBody = await resp.text();
              }
              const postCookies = cookiesToRecord(
                await context.cookies(cookieUrl)
              );
              log(
                `[${origin}] Submission ${id}: response ${resultStatus} (${resultBody.length} bytes)`
              );
              if (ws.readyState === WebSocket.OPEN)
                ws.send(
                  JSON.stringify({
                    body: resultBody,
                    cookies: postCookies,
                    id,
                    status: resultStatus,
                    type: 'submission_response',
                  })
                );
            } catch (e) {
              log(
                `[${origin}] Submission ${id} failed: ${(e as Error).message}`
              );
              if (ws.readyState === WebSocket.OPEN)
                ws.send(
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
            log(`[${origin}] Unknown message type: ${msg.type}`);
        }
      });

      ws.addEventListener('close', ({ code, reason }) => {
        log(`[${origin}] WS closed: code=${code} reason=${reason || 'none'}`);
      });

      ws.addEventListener('error', (event: Event) => {
        log(`[${origin}] WS error: ${(event as ErrorEvent).message}`);
      });
    };

    const prepAndStart = async (
      origin: string,
      cookieUrl: string,
      scriptUrl: string,
      script: string,
      html: string,
      frame: Frame | null
    ): Promise<void> => {
      const cookies = cookiesToRecord(await context.cookies(cookieUrl));
      const sanitizedHtml = stripScripts(html);
      log(
        `[${origin}] Captured: script=${script.length}b html=${sanitizedHtml.length}b cookies=${Object.keys(cookies).length}`
      );
      startSession(
        origin,
        { cookies, html: sanitizedHtml, script, scriptUrl, url: cookieUrl },
        frame
      );
    };

    // route.fetch() goes through the same proxy as everything else and can
    // hit transient errors; a single failure here used to be swallowed
    // silently, leaving the Akamai script uncaptured and the solve session
    // never started (hanging until the caller's outer timeout). Retry once
    // and log any failure so it's visible instead of a silent 120s hang.
    const fetchWithRetry = async (
      route: Route,
      attempts = 2
    ): Promise<Awaited<ReturnType<Route['fetch']>>> => {
      let lastErr: unknown;
      for (let i = 0; i < attempts; i++) {
        try {
          return await route.fetch({ maxRedirects: 0 });
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    };

    const routeHandler = async (route: Route) => {
      const req = route.request();
      if (req.resourceType() === 'document') {
        try {
          const resp = await fetchWithRetry(route);
          const ct = resp.headers()['content-type'] ?? '';
          if (resp.ok() && ct.includes('text/html')) {
            const html = await resp.text();
            capturedDocs.set(new URL(req.url()).origin, {
              html,
              url: req.url(),
            });
            return await route.fulfill({ body: html, response: resp });
          }
          return await route.fulfill({ response: resp });
        } catch (e) {
          log(
            `Document fetch failed for ${req.url()}: ${(e as Error).message}`
          );
        }
      }
      if (req.resourceType() === 'script') {
        try {
          const resp = await fetchWithRetry(route);
          const body = await resp.text();
          capturedScripts.set(req.url(), body);
          if (isLikelyAkamaiScriptUrl(req.url())) {
            const scriptOrigin = new URL(req.url()).origin;
            const doc = capturedDocs.get(scriptOrigin);
            if (doc && !sessions.has(scriptOrigin))
              await prepAndStart(
                scriptOrigin,
                doc.url,
                req.url(),
                body,
                doc.html,
                null
              );
            return await route.fulfill({
              body: '/* blocked */',
              contentType: 'application/javascript',
              status: 200,
            });
          }
          return await route.fulfill({ body, response: resp });
        } catch (e) {
          log(`Script fetch failed for ${req.url()}: ${(e as Error).message}`);
        }
      }
      try {
        await route.continue();
      } catch {
        /* already handled */
      }
    };

    const processFrame = async (frame: Frame) => {
      let html: string;
      let frameUrl: string;
      try {
        html = await frame.content();
        frameUrl = frame.url();
      } catch {
        return;
      }

      if (!frameUrl || frameUrl === 'about:blank') return;
      const origin = new URL(frameUrl).origin;

      const scriptUrl = extractAkamaiScriptUrl(html, frameUrl);
      let scriptSource: null | string = null;

      if (scriptUrl) {
        log(`[${origin}] Detected Akamai script URL: ${scriptUrl}`);
        for (const [u, src] of capturedScripts) {
          if (u === scriptUrl || u.startsWith(scriptUrl.split('?')[0] ?? '')) {
            scriptSource = src;
            break;
          }
        }
      }

      if (!scriptUrl || !scriptSource) {
        log(`[${origin}] No Akamai script found, skipping`);
        return;
      }

      await prepAndStart(
        origin,
        frameUrl,
        scriptUrl,
        scriptSource,
        html,
        frame
      );
    };

    const navHandler = async (frame: Frame) => {
      if (closing) return;
      const newUrl = frame.url();
      if (!newUrl || newUrl === 'about:blank') return;
      const origin = new URL(newUrl).origin;

      const existing = sessions.get(origin);
      if (existing && existing.frame !== null) {
        if (existing.ws.readyState === WebSocket.OPEN)
          existing.ws.close(1000, 'Navigation');
        sessions.delete(origin);
      }

      try {
        await frame.waitForLoadState('domcontentloaded', { timeout: 15000 });
        await processFrame(frame);
      } catch (e) {
        log(`Navigation handling error: ${(e as Error).message}`);
      }
    };
    page
      .route('**/*', routeHandler)
      .then(() => {
        page.on('framenavigated', navHandler);
        return page.goto(url, {
          timeout: 30000,
          waitUntil: 'domcontentloaded',
        });
      })
      .then(() => processFrame(page.mainFrame()))
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}
