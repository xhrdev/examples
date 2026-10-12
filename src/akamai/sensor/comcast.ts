/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sensor/comcast.ts
 * node --env-file=.env src/akamai/sensor/comcast.ts --headless
 */
import { runSensorTarget } from '#src/akamai/sensor/target.js';

/* The homepage, not `/account/`, and the reason is on login.xfinity.com.
 *
 * `/account/` redirects within a second into Xfinity's OAuth login, so the
 * session that decided this check was always login.xfinity.com's — and since
 * 2026-10 that host answers *every* sensor POST with a 403 (450 bytes) and
 * never moves `_abck` off `~-1~`. Not the solver: an uninstrumented Chrome
 * running the page's own sensor script gets the same 403, headless and headed,
 * from a residential address, through the ISP proxy, and from a person's own
 * everyday Chrome profile — all measured 2026-10-10. The sign-in form renders
 * regardless, so Akamai there is no longer scoring anything a browser can
 * earn, and a check that waits for acceptance on it can only time out.
 *
 * business.comcast.com still runs the sensor normally: the solver's bodies
 * are answered 201 and `_abck` is accepted in ~3 rounds (~4s), 2/2 on `/` and
 * `/shop/offers`. This is the same property and the same Akamai config the
 * check was measuring before the redirect took it elsewhere. */
await runSensorTarget({
  settleMs: 7000,
  success: (page) => `Akamai solved, reached ${new URL(page.url()).pathname}`,
  url: 'https://business.comcast.com/',
});
