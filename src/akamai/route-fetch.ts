/**
 * The request plumbing both Akamai bridges share.
 *
 * `sensor/solver.ts` and `sbsd/solver.ts` intercept the page the same way:
 * fetch the request themselves (so they can read or replace the body), hand
 * the decoded body back to the page, and send the solver's submissions from
 * inside the page so they ride the browser's own connection and jar. Both
 * also open the same session socket. Each used to carry its own copy of all
 * of it, and the copies had drifted: the sensor's in-page XHR had no
 * `onerror`, so a network failure hung the session instead of reporting
 * status 0, and the SBSD lane waited forever on a socket whose upgrade had
 * been refused.
 */
import type { BrowserContext, Frame, Route } from 'playwright-core';
import { fetch } from 'undici';

import { apiKeyHeader } from '#src/solver-url.js';
import { checkRateLimit, RateLimitError } from '#src/rate-limit.js';

/**
 * A response, however it was fetched — `route.fetch()` or `fetchResponse`.
 * `src/mitm.ts` exposes a `fetch` of exactly this shape.
 */
export type Fetched = {
  body: string;
  headers: Record<string, string>;
  /** Each `set-cookie` separately; a joined string cannot be parsed back. */
  setCookie?: string[];
  status: number;
};

/**
 * Fetch an intercepted request yourself instead of letting `route.fetch()`
 * do it. Whatever you give it must go out from the address the browser uses,
 * or what it fetches is scored as a different visitor.
 */
export type FetchResponse = (
  // eslint-disable-next-line no-unused-vars -- function-type parameter
  request: {
    body?: string;
    headers: Record<string, string>;
    method: string;
    url: string;
  }
) => Promise<Fetched>;

/**
 * Akamai's own URL convention for its pixel channel, `/akam/<n>/<hex>`.
 *
 * A product convention rather than a per-build stem: the hex rotates per
 * session, `/akam/<n>/` does not. It is never the sensor script, but it can
 * load before the sensor and matches the sensor's `/akam` keyword.
 */
export const AKAMAI_PIXEL_PATH: RegExp = /^\/akam\/\d+\//u;

/** The `rval` field of an `_abck` value: `-1` is "keep going", `0` accepted. */
export const abckStatus = (value: string | undefined): string | undefined =>
  value?.split('~')[1];

/** One origin's cookies as `name -> value`, the shape the solver wants. */
export const cookieJar = async (
  context: BrowserContext,
  url: string
): Promise<Record<string, string>> =>
  Object.fromEntries(
    (await context.cookies(url)).map((cookie) => [cookie.name, cookie.value])
  );

/**
 * Fetch what a route asked for, with whichever client the caller chose.
 *
 * `route.fetch()` puts the response's cookies in the jar itself;
 * `fetchResponse` cannot, so the caller applies `setCookie` — after
 * fulfilling, never before. See `src/akamai/set-cookie.ts`.
 */
export const fetchForRoute = async (
  route: Route,
  fetchResponse?: FetchResponse,
  options: { maxRedirects?: number } = {}
): Promise<Fetched> => {
  if (fetchResponse) {
    const request = route.request();
    const postData = request.postData();
    return fetchResponse({
      ...(postData === null ? {} : { body: postData }),
      headers: await request.allHeaders(),
      method: request.method(),
      url: request.url(),
    });
  }
  const response = await route.fetch(options);
  return {
    body: await response.text(),
    headers: response.headers(),
    status: response.status(),
  };
};

/**
 * Give the page a body we have already decoded.
 *
 * Two headers have to go. `content-encoding` still says `br`, and handing
 * that back with decoded text makes the browser brotli-decode plain UTF-8 —
 * the response dies and the site renders its own error page. `set-cookie`
 * goes because `fulfill` takes ONE header map: a response setting four
 * cookies would keep one and silently lose three.
 */
export const fulfillDecoded = (
  route: Route,
  body: string,
  response?: Fetched
): Promise<void> => {
  const headers: Record<string, string> = response
    ? { ...response.headers }
    : { 'content-type': 'application/javascript' };
  delete headers['content-encoding'];
  delete headers['content-length'];
  delete headers['set-cookie'];
  return route.fulfill({ body, headers, status: response?.status ?? 200 });
};

/**
 * Send one solver-authored request from inside a frame.
 *
 * Playwright's own request context is not usable for this: the submission has
 * to travel on the browser's connection, with its TLS fingerprint and its
 * cookie jar, or it is scored as a different visitor than the one the
 * telemetry describes. A network failure comes back as status 0.
 */
export const sendFromFrame = (
  frame: Frame,
  request: {
    body: string;
    headers?: Record<string, string> | undefined;
    method: string;
    url: string;
  }
): Promise<{ body: string; status: number }> =>
  frame.evaluate(
    ({ body, headers, method, url }) =>
      new Promise<{ body: string; status: number }>((done) => {
        const xhr = new XMLHttpRequest();
        xhr.open(method, url, true);
        xhr.withCredentials = true;
        for (const [name, value] of Object.entries(headers ?? {})) {
          try {
            xhr.setRequestHeader(name, value);
          } catch {
            // Forbidden header names are the browser's to set.
          }
        }
        xhr.onload = () => done({ body: xhr.responseText, status: xhr.status });
        xhr.onerror = () => done({ body: '', status: 0 });
        xhr.send(body);
      }),
    request
  );

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
export async function classifyUpgradeFailure(
  solverUrl: string,
  solverApiKey: string | undefined
): Promise<Error> {
  const probeUrl = solverUrl.replace(/^ws/, 'http');
  try {
    const probe = await fetch(probeUrl, {
      headers: apiKeyHeader(solverApiKey),
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
export function isAuthFailure(error: Error): boolean {
  return (error as { authFailure?: boolean }).authFailure === true;
}
