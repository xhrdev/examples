/**
 * This is a Playwright library file, not a script. It exposes a `solve`
 * function you add to Playwright scripts to integrate with the xhr.dev
 * on-prem solver for anti-bot solving. See src/akamai/sensor/comcast.ts for a
 * runnable example.
 *
 * Akamai Bot Manager browser bridge.
 *
 * Akamai scores you on telemetry produced by an obfuscated sensor script. The
 * solver computes that telemetry; **your browser sends it**, so the requests
 * carry a real TLS fingerprint and the page's own cookie jar.
 *
 * Unlike DataDome this is stateful, so it runs over a WebSocket
 * (`ws://<host>:3000/akamai/session`) rather than one request:
 *
 *   ->  init                 page URL, sensor script, HTML, cookies, profile
 *   <-  submission           a request to make: method, url, body, headers
 *   ->  submission_response  what your browser got back, including cookies
 *   <-  cookie_update        the new `_abck`, round number, accepted flag
 *   <-  status               `running`, then `accepted`
 *
 * Acceptance takes several rounds. `_abck` ending in `~-1~` means "keep
 * going"; `~0~` means you are through. Early rounds reporting `~-1~` are the
 * protocol working, not a failure.
 *
 * ## Reading this file
 *
 *   solve()                  the entry point; owns the session map and timeout
 *   startSession()           opens one WebSocket per origin
 *   extractAkamaiScriptUrl() finds the sensor script in the page HTML
 *
 * Sessions are keyed by origin because a single login flow often spans two
 * properties (e.g. business.comcast.com and login.xfinity.com), each with its
 * own independent `_abck` to satisfy.
 */
import type { BrowserContext, Frame, Page, Route } from 'playwright-core';
import { fetch, WebSocket } from 'undici';

import { isSbsdBundle } from '#src/akamai/sbsd-bundle.js';
import { PROFILE, PROFILE_ID } from '#src/profile.js';
import { checkRateLimit, RateLimitError } from '#src/rate-limit.js';

export type SolveOptions = {
  /**
   * Fetch intercepted requests with this instead of Playwright's
   * `route.fetch`. Only needed for browsers where route.fetch is unreliable —
   * `src/mitm.ts` exposes exactly this shape, and
   * `src/akamai/sensor/comcast-lightpanda.ts` passes it. Whatever you give it must
   * come from the same address the browser uses, or the telemetry will be
   * scored against the wrong client.
   */
  fetchResponse?: (
    // eslint-disable-next-line no-unused-vars -- function-type parameters
    request: {
      body?: string;
      headers: Record<string, string>;
      method: string;
      url: string;
    }
  ) => Promise<Fetched>;
  /**
   * How long a frame gets to reach `domcontentloaded` after it navigates,
   * before we give up on reading the sensor script out of it. Default 15s.
   */
  loadStateTimeout?: number;
  /**
   * How long the opening navigation gets. Default 30s. Every request on the
   * page is intercepted and refetched, so a script-heavy target behind a slow
   * proxy — or a browser slower than Chrome — can need more.
   */
  navigationTimeout?: number;
  proxy?: string;
  /**
   * Sent as `x-api-key` on the WebSocket upgrade. Required when the solver
   * sits behind an API-key gate — the gate matches the header on the upgrade
   * request like any other, so omitting it fails the handshake with a 401.
   */
  solverApiKey?: string;
  solverUrl: string;
  timeout?: number;
  url: string;
};

type CookieRecord = Record<string, string>;

/** A response, however it was fetched. */
type Fetched = {
  body: string;
  headers: Record<string, string>;
  /** Each `set-cookie` separately; a joined string cannot be parsed back. */
  setCookie?: string[];
  status: number;
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

  // Pattern 2: Long random-looking path (5–10 segments).
  //
  // On a property that also runs SBSD there are two scripts of this shape,
  // and the SBSD bundle is often the one that appears first. Posting sensor
  // submissions to it fails quietly — 200 with an empty body, and `_abck`
  // never leaves `~-1~` — so bundles are skipped rather than matched.
  /* eslint-disable security/detect-unsafe-regex */
  const longPathRe =
    /<script[^>]+src=["']((?:\/[a-zA-Z0-9\-_]+){5,10}(?:\?v=[^"']*)?)["']/gim;
  /* eslint-enable security/detect-unsafe-regex */
  for (const candidate of html.matchAll(longPathRe)) {
    const href = new URL(candidate[1] ?? '', baseUrl);
    if (!isSbsdBundle(href)) return href.href;
  }

  // Pattern 3: Known Akamai keywords in path
  match = /<script[^>]+src=["']([^"']*\/(?:akam|_abck|bm-)[^"']+)["']/im.exec(
    html
  );
  if (match) return new URL(match[1] ?? '', baseUrl).href;

  return null;
};

const isLikelyAkamaiScriptUrl = (url: string): boolean => {
  const parsed = new URL(url);
  if (isSbsdBundle(parsed)) return false;
  const p = parsed.pathname;
  // eslint-disable-next-line security/detect-unsafe-regex
  return /^(\/[a-zA-Z0-9\-_]+){5,}$/.test(p) || /\/(?:akam|_abck|bm-)/.test(p);
};

const getAbckStatus = (value: string | undefined): null | string =>
  value ? (value.split('~')[1] ?? null) : null;

// eslint-disable-next-line security/detect-unsafe-regex
const STRIP_SCRIPTS_RE = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gim;
const stripScripts = (html: string): string =>
  html.replace(STRIP_SCRIPTS_RE, '');

/**
 * What the session socket declares about the browser on the other end.
 *
 * A subset of the shared identity rather than a copy of it: the solver merges
 * this over the registry profile named by `profileId`, so anything written out
 * here that disagrees with `src/profile.ts` overrides the real reading with a
 * stale one and scores as a mismatch.
 */
const TELEMETRY_PROFILE = {
  deviceMemory: PROFILE.deviceMemory,
  hardwareConcurrency: PROFILE.hardwareConcurrency,
  languages: PROFILE.languages,
  screen: PROFILE.screen,
  timezone: PROFILE.timezone,
};

export async function solve(page: Page, opts: SolveOptions): Promise<void> {
  const {
    fetchResponse,
    loadStateTimeout = 15000,
    navigationTimeout = 30000,
    proxy,
    solverApiKey,
    solverUrl,
    timeout = 120000,
    url,
  } = opts;
  const context: BrowserContext = page.context();
  const capturedDocs = new Map<string, { html: string; url: string }>();
  const capturedScripts = new Map<string, string>();
  const sessions = new Map<string, { frame: Frame | null; ws: WebSocket }>();
  /**
   * Sockets we closed ourselves because a newer session replaced them. They
   * never open, and that is not a failure — see diagnoseIfNeverOpened.
   */
  const superseded = new WeakSet<WebSocket>();
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
      if (existing) {
        superseded.add(existing.ws);
        existing.ws.close(1000, 'New session');
      }

      const ws = new WebSocket(solverUrl, {
        ...(solverApiKey ? { headers: { 'x-api-key': solverApiKey } } : {}),
      });
      sessions.set(origin, { frame, ws });
      // A refused upgrade never reaches 'open'. See classifyUpgradeFailure.
      let opened = false;
      let diagnosed = false;

      ws.addEventListener('open', () => {
        opened = true;
        log(`[${origin}] WS connected, sending init...`);
        ws.send(
          JSON.stringify({
            type: 'init',
            ...data,
            profile: TELEMETRY_PROFILE,
            profileId: PROFILE_ID,
            proxy,
          })
        );
      });

      // Let the event type come from undici's WebSocket rather than annotating
      // it: the DOM's MessageEvent is a different, incompatible declaration.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      ws.addEventListener('message', async (event) => {
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
              } else if (fetchResponse) {
                // No frame for this origin, but we have a fetcher that shares
                // the browser's address. Prefer it over context.request:
                // Playwright's request context is a separate client, and on a
                // CDP-attached browser it does not even use the browser's
                // proxy — telemetry posted from a different IP than the page
                // is scored as a different visitor and never accepted.
                const resp = await fetchResponse({
                  body: body ?? '',
                  headers: {
                    ...xhrHeaders,
                    Origin: scriptOrigin,
                    Referer: data.url,
                  },
                  method: method ?? 'POST',
                  url: subUrl ?? '',
                });
                await applyCookies(subUrl ?? '', resp.setCookie);
                resultStatus = resp.status;
                resultBody = resp.body;
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

      // Both listeners funnel into the same place: if the socket never
      // opened, the upgrade itself was refused, and waiting for the
      // acceptance timeout would report that as a solve failure instead of
      // the 429 (or 401) it actually is.
      //
      // The `superseded` guard is the important one. A single origin can
      // start a session twice (two frames capture the same script), and the
      // second start deliberately closes the first socket before it has
      // opened. That is a socket we killed, not a refused upgrade, and
      // diagnosing it would report a failure for a solve that is about to
      // succeed on the replacement socket.
      const diagnoseIfNeverOpened = (): void => {
        if (opened || closing || diagnosed) return;
        if (superseded.has(ws) || sessions.get(origin)?.ws !== ws) return;
        diagnosed = true;
        void classifyUpgradeFailure(solverUrl, solverApiKey).then((error) => {
          log(`[${origin}] ${error.message}`);
          // Only a 429 or a 401 is a definitive verdict worth failing on.
          // Anything else means the probe could not explain the failure, so
          // leave the previous behaviour alone and let the acceptance timeout
          // decide rather than turning an unexplained blip into a hard error.
          if (error instanceof RateLimitError || isAuthFailure(error)) {
            finish();
            reject(error);
          }
        });
      };

      ws.addEventListener('close', ({ code, reason }) => {
        log(`[${origin}] WS closed: code=${code} reason=${reason || 'none'}`);
        diagnoseIfNeverOpened();
      });

      ws.addEventListener('error', (event: Event) => {
        log(`[${origin}] WS error: ${(event as ErrorEvent).message}`);
        diagnoseIfNeverOpened();
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
        `[${origin}] Captured: script=${script.length}b html=${sanitizedHtml.length}b cookies=[${Object.keys(cookies).sort().join(',')}]`
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
    //
    // `fetchResponse` replaces route.fetch entirely when the caller supplies
    // one, because against some browsers route.fetch is the thing that fails:
    // it runs in Playwright's request context, which syncs cookies with the
    // browser, and on Lightpanda that stops answering — after which every
    // route.fetch waits out its timeout. See comcast-lightpanda.ts.
    const fetchWithRetry = async (
      route: Route,
      attempts = 2
    ): Promise<Fetched> => {
      let lastErr: unknown;
      for (let i = 0; i < attempts; i++) {
        try {
          if (fetchResponse) {
            const req = route.request();
            const postData = req.postData();
            const response = await fetchResponse({
              ...(postData === null ? {} : { body: postData }),
              headers: await req.allHeaders(),
              method: req.method(),
              url: req.url(),
            });
            return {
              body: response.body,
              headers: response.headers,
              ...(response.setCookie ? { setCookie: response.setCookie } : {}),
              status: response.status,
            };
          }
          const resp = await route.fetch({ maxRedirects: 0 });
          return {
            body: await resp.text(),
            headers: resp.headers(),
            status: resp.status(),
          };
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    };

    /**
     * Put a response's cookies in the browser's jar ourselves.
     *
     * `route.fulfill` takes one header map, so it can carry exactly one
     * `set-cookie` — a response that sets four (Akamai sets `_abck`, `bm_sz`,
     * `ak_bmsc`, `bm_sv`) loses three of them, and if `_abck` is one of the
     * lost ones the session starts without the very cookie the protocol
     * advances. That failure is invisible: every round returns the same
     * `_abck` and `rval` never leaves -1.
     *
     * Playwright applies cookies itself when `route.fetch` did the fetching,
     * so this only runs on the `fetchResponse` path.
     */
    const applyCookies = async (
      url: string,
      setCookie: string[] | undefined
    ): Promise<void> => {
      if (!setCookie || setCookie.length === 0) return;
      const { hostname } = new URL(url);
      const cookies = setCookie.flatMap((header) => {
        const [pair, ...attributes] = header.split(';');
        const index = pair?.indexOf('=') ?? -1;
        if (!pair || index < 1) return [];
        const attribute = (name: string): string | undefined =>
          attributes
            .map((a) => a.trim())
            .find((a) => a.toLowerCase().startsWith(`${name}=`))
            ?.slice(name.length + 1);
        const expires = attribute('expires');
        const maxAge = attribute('max-age');
        const seconds = maxAge === undefined ? NaN : Number(maxAge);
        const expiresAt = Number.isFinite(seconds)
          ? Date.now() / 1000 + seconds
          : expires
            ? Date.parse(expires) / 1000
            : NaN;
        return [
          {
            domain: attribute('domain') ?? hostname,
            ...(Number.isFinite(expiresAt) ? { expires: expiresAt } : {}),
            httpOnly: attributes.some(
              (a) => a.trim().toLowerCase() === 'httponly'
            ),
            name: pair.slice(0, index).trim(),
            path: attribute('path') ?? '/',
            secure: attributes.some((a) => a.trim().toLowerCase() === 'secure'),
            value: pair.slice(index + 1).trim(),
          },
        ];
      });
      if (cookies.length > 0) await context.addCookies(cookies);
    };

    /** Pass a fetched response back to the page, framing headers stripped. */
    const fulfillFetched = (
      route: Route,
      fetched: Fetched,
      body = fetched.body
    ): Promise<void> => {
      const headers = { ...fetched.headers };
      // The body we hold is decoded, so the original framing would be a lie,
      // and the cookies went into the jar through applyCookies instead.
      delete headers['content-encoding'];
      delete headers['content-length'];
      delete headers['set-cookie'];
      return route.fulfill({ body, headers, status: fetched.status });
    };

    const routeHandler = async (route: Route) => {
      const req = route.request();
      if (req.resourceType() === 'document') {
        try {
          const resp = await fetchWithRetry(route);
          const ct = resp.headers['content-type'] ?? '';
          if (resp.status < 400 && ct.includes('text/html')) {
            capturedDocs.set(new URL(req.url()).origin, {
              html: resp.body,
              url: req.url(),
            });
          }
          // Release the route before touching the cookie jar: while a request
          // is paused, `addCookies` waits behind it on Lightpanda and the
          // navigation never completes.
          await fulfillFetched(route, resp);
          return await applyCookies(req.url(), resp.setCookie);
        } catch (e) {
          log(
            `Document fetch failed for ${req.url()}: ${(e as Error).message}`
          );
        }
      }
      if (req.resourceType() === 'script') {
        try {
          const resp = await fetchWithRetry(route);
          const body = resp.body;
          capturedScripts.set(req.url(), body);
          if (isLikelyAkamaiScriptUrl(req.url())) {
            // The page gets a stub: the real sensor must not run, or it posts
            // its own telemetry alongside the solver's.
            await route.fulfill({
              body: '/* blocked */',
              contentType: 'application/javascript',
              status: 200,
            });
            // Cookies first, then the session — `init` sends the jar, and a
            // session that opens without the current `_abck` never advances.
            await applyCookies(req.url(), resp.setCookie);
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
            return;
          }
          await fulfillFetched(route, resp, body);
          return await applyCookies(req.url(), resp.setCookie);
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
        // Say *why*. These two cases have completely different causes:
        // no URL means the page we got does not carry the sensor script at
        // all (often a block/error page rather than the real one), whereas a
        // URL with no source means the script response was not captured in
        // time. Dump enough of the frame to tell them apart from a CI log.
        const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gim)]
          .map((m) => m[1])
          .slice(0, 8);
        log(
          `[${origin}] No Akamai script found, skipping — ` +
            (scriptUrl
              ? `url=${scriptUrl} detected but its source was never captured ` +
                `(captured ${capturedScripts.size} scripts)`
              : 'no sensor-script URL in this frame') +
            ` | frame=${frameUrl} html=${html.length}b title=${
              /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '?'
            } scripts=[${srcs.join(', ')}]`
        );
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
        await frame.waitForLoadState('domcontentloaded', {
          timeout: loadStateTimeout,
        });
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
          timeout: navigationTimeout,
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

/**
 * Why this exists: undici reports a rejected WebSocket upgrade as a bare
 * `TypeError` with close code 1006 and no HTTP status, so a rate-limited
 * upgrade (429) looks exactly like the solver being down. One plain GET to the
 * same URL with the same key goes through the same auth and rate-limit
 * handlers and *does* carry a status, which is enough to tell them apart.
 *
 * Only ever called on a connection that already failed, so the extra request
 * costs nothing in the normal case.
 */
async function classifyUpgradeFailure(
  solverUrl: string,
  solverApiKey: string | undefined
): Promise<Error> {
  const probeUrl = solverUrl.replace(/^ws/, 'http');
  try {
    const probe = await fetch(probeUrl, {
      ...(solverApiKey ? { headers: { 'x-api-key': solverApiKey } } : {}),
      signal: AbortSignal.timeout(10000),
    });
    // Throws RateLimitError on 429; anything else falls through.
    checkRateLimit(probe.status, probe.headers);
    if (probe.status === 401) {
      return Object.assign(
        new Error(`solver rejected the API key (HTTP 401) on ${probeUrl}`),
        { authFailure: true }
      );
    }
    return new Error(
      `solver WebSocket upgrade failed (probe returned HTTP ${probe.status})`
    );
  } catch (error) {
    if (error instanceof RateLimitError) return error;
    return new Error(
      `solver WebSocket upgrade failed and ${probeUrl} is unreachable: ${(error as Error).message}`
    );
  }
}

/** Whether classifyUpgradeFailure identified a rejected API key. */
function isAuthFailure(error: Error): boolean {
  return (error as { authFailure?: boolean }).authFailure === true;
}
