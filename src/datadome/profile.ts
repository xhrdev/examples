/**
 * DataDome's endpoints, and the profile every `/dd/solve` request declares.
 *
 * The identity itself lives in `src/profile.ts`, shared with Akamai. What is
 * here is its DataDome shape: the two objects the solve body carries, written
 * once so the browser bridge and the HTTP clients cannot disagree about them.
 */
import { PROFILE, PROFILE_ID } from '#src/profile.js';

export { PROFILE, PROFILE_ID } from '#src/profile.js';

export const GEO_HOST = 'geo.captcha-delivery.com';
export const GEO_ORIGIN: string = `https://${GEO_HOST}`;

/**
 * `js_profile`: what the page's own scripts would read. The browser bridge
 * overlays the readings it took from the live challenge frame (languages,
 * screen, connection); a client without a browser sends this as it is.
 */
export const JS_PROFILE: Readonly<Record<string, unknown>> = {
  brands: PROFILE.brands,
  chromeFullVersion: PROFILE.chromeFullVersion,
  chromeVersion: PROFILE.chromeVersion,
  deviceMemory: PROFILE.deviceMemory,
  hardwareConcurrency: PROFILE.hardwareConcurrency,
  languages: PROFILE.languages,
  os: PROFILE.os,
  platformVersion: PROFILE.platformVersion,
  screen: PROFILE.screen,
  timezone: PROFILE.timezone,
  timezoneOffsetMinutes: PROFILE.timezoneOffsetMinutes,
  vendor: PROFILE.vendor,
};

/**
 * `profile`: which registered profile to solve as. The solver checks `id`
 * against `js_profile.chromeVersion` and `js_profile.os`, which is why both
 * are derived from the same PROFILE.
 */
export const SOLVER_PROFILE: Readonly<Record<string, unknown>> = {
  chromeFullVersion: PROFILE.chromeFullVersion,
  httpHeaderTemplates: { form: [], iframe: [], image: [], xhr: [] },
  id: PROFILE_ID,
  os: PROFILE.os,
  timezone: PROFILE.timezone,
  timezoneOffsetMinutes: PROFILE.timezoneOffsetMinutes,
  tlsClientHello: '',
  userAgent: PROFILE.userAgent,
};
