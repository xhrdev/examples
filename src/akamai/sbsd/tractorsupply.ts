/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sbsd/tractorsupply.ts
 * node --env-file=.env src/akamai/sbsd/tractorsupply.ts --headless
 *
 * tractorsupply.com.
 */
import { looksDenied } from '#src/akamai/session.js';
import { runSbsdHomepage } from '#src/akamai/sbsd/homepage.js';

await runSbsdHomepage({
  ignoreHTTPSErrors: true,
  isDenied: ({ html }) => looksDenied(html),
  origin: 'https://www.tractorsupply.com',
});
