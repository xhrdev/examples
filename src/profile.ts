/**
 * The browser identity every example claims, for both vendors and both
 * languages.
 *
 * There is exactly one answer in this repo to "which Chrome are we claiming to
 * be", and this is it. That matters more than it looks: the identity is
 * cross-checked in several places at once — the sensor telemetry against the
 * `sec-ch-ua` headers actually put on the wire, `profile.id` against
 * `js_profile.chromeVersion` and `js_profile.os` — so a copy that drifts does
 * not fail loudly. It fails as solves that inexplicably stop being accepted,
 * with `_abck` parked at `~-1~` and nothing in any error message naming the
 * version as the cause.
 *
 * It used to live in `src/datadome/profile.ts`, where Akamai could not reach
 * it, so the Akamai scripts carried their own literals and drifted a full two
 * major versions behind. Everything now derives from here:
 *
 *   src/datadome/profile.ts   re-exports it with the DataDome endpoints
 *   src/akamai/solver.ts      the telemetry sent over the session socket
 *   src/akamai/*.ts           the CDP overrides installed on the real browser
 *   src/mcp.ts                what the MCP tools declare on every solve
 *   py-src/profile.json       generated from here; see `npm run emit:profile`
 *
 * The Python clients cannot import TypeScript, so they read a generated JSON
 * copy instead. It is committed so `pip install` alone is enough to run them,
 * and `src/profile.test.ts` fails if it drifts from this file.
 *
 * WHEN YOU BUMP THIS, take the values from the solver's own fixture for that
 * profile rather than editing version numbers in place. Fields move that a
 * find-and-replace will not catch: the GREASE brand changed shape between 149
 * and 151 (`Not)A;Brand` v24 became `Not=A?Brand` v99) and the brand array
 * reordered, and the window readings moved with it. The profile must also be
 * registered on the container you are pointing at — ask it, by sending a
 * deliberately unknown id and reading the `Available: [...]` list back.
 */

/**
 * A coherent Chrome-on-macOS identity. Every field the solver receives has to
 * agree with the headers actually put on the wire — changing the user agent
 * without changing the client hints alongside it is the most common way to get
 * a solve rejected.
 */
export const PROFILE = {
  brands: [
    { brand: 'Not=A?Brand', version: '99' },
    { brand: 'Google Chrome', version: '151' },
    { brand: 'Chromium', version: '151' },
  ],
  chromeFullVersion: '151.0.7922.109',
  chromeVersion: '151',
  deviceMemory: 32,
  hardwareConcurrency: 10,
  languages: 'en-US,en',
  os: 'macos',
  platformVersion: '26.5.2',
  screen: {
    availHeight: 948,
    availLeft: 0,
    availTop: 34,
    availWidth: 1512,
    colorDepth: 30,
    devicePixelRatio: 2,
    height: 982,
    innerHeight: 817,
    innerWidth: 1200,
    outerHeight: 904,
    outerWidth: 1200,
    pixelDepth: 30,
    screenX: 22,
    screenY: 56,
    width: 1512,
  },
  timezone: 'America/New_York',
  timezoneOffsetMinutes: 240,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  vendor: 'Google Inc.',
} as const;

/**
 * Derived, never written out by hand. The solver validates `profile.id`
 * against `js_profile.chromeVersion` and `js_profile.os`, so a literal here
 * would go stale the moment PROFILE is bumped and produce a 400 whose message
 * says nothing about the version.
 */
export const PROFILE_ID: string = `chrome-${PROFILE.chromeVersion}-${PROFILE.os}`;

/**
 * The `sec-ch-ua` header, built from the same brands the telemetry declares.
 *
 * Chrome's own formatting, which is what makes this worth deriving rather than
 * writing out: brands in registry order, `"name";v="version"`, comma-space
 * separated. Both vendors compare this against the version the sensor payload
 * claims, so a hand-written copy is a mismatch waiting to happen.
 */
export const SEC_CH_UA: string = PROFILE.brands
  .map(({ brand, version }) => `"${brand}";v="${version}"`)
  .join(', ');

/**
 * The full-version brand list for CDP's `userAgentMetadata`.
 *
 * Same brands again, but carrying `chromeFullVersion` rather than the major.
 * The GREASE entry keeps its own version padded to four parts, which is what
 * branded Chrome sends.
 */
export const FULL_VERSION_LIST: { brand: string; version: string }[] =
  PROFILE.brands.map(({ brand, version }) => ({
    brand,
    version: brand.includes('Brand')
      ? `${version}.0.0.0`
      : PROFILE.chromeFullVersion,
  }));
