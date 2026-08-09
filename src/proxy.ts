/**
 * This is a helper library, not a script. It exposes `pinSession`,
 * `toLaunchProxy` and `toUrl`, which every example uses to turn a proxy
 * string into the shape it needs.
 *
 * Proxy string handling, in one place.
 *
 * Every example needs the same three things from a proxy string: a pinned
 * session, Playwright's `{ server, username, password }` shape, and a plain
 * URL for the solver API. Each script used to carry its own copy of that
 * logic, and the copies disagreed — which is how a load test could silently
 * run every iteration through a single exit IP.
 *
 * Two rules worth knowing:
 *
 *   - Credentials are handed back **decoded**. A password like `p@ss` arrives
 *     percent-encoded from `new URL()`; Playwright wants the real characters.
 *   - Some providers authenticate with a password and no username, so never
 *     key the auth section off the username alone.
 */
import { randomInt } from 'node:crypto';

/**
 * Session tokens, as the major providers spell them:
 *
 *   oxylabs      user-<acct>-sessid-<n>
 *   rayobyte     <pass>-hardsession-<n>            (in the password)
 *   bright data  brd-customer-<acct>-session-<n>
 *   smartproxy   user-<acct>-session-<n>
 *   joinmassive  <acct>-session-<n>-sessionttl-<n>
 */
const SESSION_TOKEN_RE =
  /((?:^|[-_])(?:hard)?sess(?:ion)?(?:id)?[-_])([a-z0-9]+)/i;

/** An explicit opt-in for providers we do not recognise. */
const SESSION_PLACEHOLDER_RE = /\{session\}/gi;

/** Where to graft a token on when a known provider's string has none. */
const PROVIDERS = [
  { half: 'username', host: /(^|\.)oxylabs\.io$/i, token: 'sessid' },
  { half: 'password', host: /(^|\.)rayobyte\.com$/i, token: 'hardsession' },
] as const;

const parse = (raw: string): URL =>
  new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);

/** Re-serialise without the trailing path `href` would add. */
const serialise = (url: URL): string => {
  const auth =
    url.username || url.password
      ? `${url.username}${url.password ? `:${url.password}` : ''}@`
      : '';
  return `${url.protocol}//${auth}${url.host}`;
};

const rotate = (value: string, session: number): null | string => {
  if (SESSION_PLACEHOLDER_RE.test(value)) {
    return value.replace(SESSION_PLACEHOLDER_RE, String(session));
  }
  if (SESSION_TOKEN_RE.test(value)) {
    return value.replace(SESSION_TOKEN_RE, `$1${session}`);
  }
  return null;
};

/**
 * Pin the proxy to one exit IP for the duration of a flow.
 *
 * Clearance cookies are bound to the IP that earned them, so a pool that
 * rotates mid-flow hands you a cookie that is void on arrival.
 *
 * Rewrites an existing session token wherever it appears, honours a
 * `{session}` placeholder, and grafts the right token onto known providers
 * that have none. `pinned` is false when the string offers nothing to pin —
 * tell the user rather than pretending it worked.
 */
export const pinSession = (
  raw: string,
  session: number = randomInt(100_000, 1_000_000_000)
): { pinned: boolean; url: string } => {
  const url = parse(raw);

  // Assign decoded values back: the URL setter re-encodes, so encoding here
  // too would double-escape.
  const rotatedUser = rotate(decodeURIComponent(url.username), session);
  const rotatedPass = rotate(decodeURIComponent(url.password), session);
  if (rotatedUser !== null) url.username = rotatedUser;
  if (rotatedPass !== null) url.password = rotatedPass;
  if (rotatedUser !== null || rotatedPass !== null) {
    return { pinned: true, url: serialise(url) };
  }

  const provider = PROVIDERS.find(({ host }) => host.test(url.hostname));
  if (provider) {
    const current = decodeURIComponent(url[provider.half]);
    if (current) {
      url[provider.half] = `${current}-${provider.token}-${session}`;
      return { pinned: true, url: serialise(url) };
    }
  }

  return { pinned: false, url: serialise(url) };
};

/** The shape Playwright's `browser.launch({ proxy })` expects. */
export const toLaunchProxy = (
  raw: string
): { password?: string; server: string; username?: string } => {
  const url = parse(raw);
  const password = decodeURIComponent(url.password);
  const username = decodeURIComponent(url.username);
  return {
    ...(password ? { password } : {}),
    server: `${url.protocol}//${url.host}`,
    ...(username ? { username } : {}),
  };
};

/** A canonical proxy URL, credentials included — what the solver API takes. */
export const toUrl = (raw: string): string => serialise(parse(raw));
