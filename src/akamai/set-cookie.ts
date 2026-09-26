/**
 * This is a helper library, not a script. It turns raw `set-cookie` headers
 * into the shape `BrowserContext.addCookies` wants.
 *
 * ## why it is not `route.fulfill`'s job
 *
 * `route.fulfill` takes one header map, so it can carry exactly one
 * `set-cookie` — and a single Akamai response sets four (`_abck`, `bm_sz`,
 * `ak_bmsc`, `bm_sv`). Three are lost, and if `_abck` is one of the lost ones
 * the session starts without the very cookie the protocol advances. The
 * failure is invisible from the outside: every round returns the same `_abck`
 * and `rval` never leaves `-1`.
 *
 * Playwright applies cookies itself when `route.fetch()` did the fetching, so
 * this only matters on the `fetchResponse` path — which is the path both
 * solvers take under Lightpanda, because `route.fetch` never returns there.
 * Both of them needed this, which is why it lives here rather than twice.
 */
import type { BrowserContext } from 'playwright-core';

/** One cookie, in `BrowserContext.addCookies` shape. */
export type ParsedCookie = {
  domain: string;
  expires?: number;
  httpOnly: boolean;
  name: string;
  path: string;
  secure: boolean;
  value: string;
};

/**
 * Parse `set-cookie` headers, defaulting `domain` to the host that sent them.
 *
 * Deliberately lenient: a header this cannot read is dropped rather than
 * thrown over, because one malformed cookie in a response is not a reason to
 * fail the request that carried it.
 */
export const parseSetCookie = (
  url: string,
  setCookie: readonly string[] | undefined
): ParsedCookie[] => {
  if (!setCookie || setCookie.length === 0) return [];
  const { hostname } = new URL(url);
  return setCookie.flatMap((header) => {
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
    // `Max-Age` wins over `Expires` where both are present, which is what the
    // RFC says and what every browser does.
    const expiresAt = Number.isFinite(seconds)
      ? Date.now() / 1000 + seconds
      : expires
        ? Date.parse(expires) / 1000
        : NaN;
    return [
      {
        domain: attribute('domain') ?? hostname,
        ...(Number.isFinite(expiresAt) ? { expires: expiresAt } : {}),
        httpOnly: attributes.some((a) => a.trim().toLowerCase() === 'httponly'),
        name: pair.slice(0, index).trim(),
        path: attribute('path') ?? '/',
        secure: attributes.some((a) => a.trim().toLowerCase() === 'secure'),
        value: pair.slice(index + 1).trim(),
      },
    ];
  });
};

/** Put a response's cookies in the browser's jar, all of them. */
export const applySetCookie = async (
  context: BrowserContext,
  url: string,
  setCookie: readonly string[] | undefined
): Promise<void> => {
  const cookies = parseSetCookie(url, setCookie);
  if (cookies.length > 0) await context.addCookies(cookies);
};
