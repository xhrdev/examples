/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sbsd/coupang.ts
 * node --env-file=.env src/akamai/sbsd/coupang.ts --headless
 *
 * coupang.com. A first visit can be served the sensor alone, but an address
 * it has seen before gets a ~440-byte "Access Denied" bootstrap carrying the
 * SBSD bundle, and the real homepage only after the carrier is answered. So it
 * runs under `attach()`, which handles either: SBSD when it is there, then
 * `_abck` to `~0~` (three rounds).
 */
import { looksDenied } from '#src/akamai/session.js';
import { runSbsdHomepage } from '#src/akamai/sbsd/homepage.js';

await runSbsdHomepage({
  ignoreHTTPSErrors: true,
  isDenied: ({ html }) => looksDenied(html),
  origin: 'https://www.coupang.com',
});
