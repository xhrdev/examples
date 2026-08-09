/**
 * This is a helper library, not a script. It holds the browser identity and
 * the DataDome endpoints that every version of the example needs — the
 * Playwright bridge in solver.ts and the browser-free clients alike.
 *
 * It exists so there is exactly one answer to "which Chrome are we claiming
 * to be". The identity is cross-checked by DataDome in several places at
 * once, so a copy that drifts does not fail loudly; it fails as a solve that
 * inexplicably stops being accepted.
 */

export const GEO_HOST = 'geo.captcha-delivery.com';
export const GEO_ORIGIN: string = `https://${GEO_HOST}`;

/**
 * A coherent Chrome-on-macOS identity. Every field the solver receives has to
 * agree with the headers actually put on the wire — changing the user agent
 * without changing the client hints alongside it is the most common way to
 * get a solve rejected.
 */
export const PROFILE = {
  brands: [
    { brand: 'Google Chrome', version: '149' },
    { brand: 'Chromium', version: '149' },
    { brand: 'Not)A;Brand', version: '24' },
  ],
  chromeFullVersion: '149.0.7827.201',
  chromeVersion: '149',
  deviceMemory: 32,
  hardwareConcurrency: 10,
  languages: 'en-US,en',
  os: 'macos',
  platformVersion: '26.5.2',
  screen: {
    availHeight: 948,
    availLeft: 0,
    availTop: 0,
    availWidth: 1512,
    colorDepth: 30,
    devicePixelRatio: 2,
    height: 982,
    innerHeight: 761,
    innerWidth: 1200,
    outerHeight: 904,
    outerWidth: 1200,
    pixelDepth: 30,
    screenX: 0,
    screenY: 143,
    width: 1512,
  },
  timezone: 'America/New_York',
  timezoneOffsetMinutes: 240,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  vendor: 'Google Inc.',
} as const;

/**
 * Derived, never written out by hand. The solver validates `profile.id`
 * against `js_profile.chromeVersion` and `js_profile.os`, so a literal here
 * would go stale the moment PROFILE is bumped and produce a 400 whose message
 * says nothing about the version.
 */
export const PROFILE_ID: string = `chrome-${PROFILE.chromeVersion}-${PROFILE.os}`;
