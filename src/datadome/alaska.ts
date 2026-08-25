/**
 * Run with:
 *
 * node --env-file=.env src/datadome/alaska.ts
 * node --env-file=.env src/datadome/alaska.ts --headless
 * node --env-file=.env src/datadome/alaska.ts --screenshot
 *
 * myAlaska, the state login portal, and the only alaska.gov host of the
 * three tried here that DataDome actually fronts — labor.alaska.gov serves
 * directly and www.alaska.gov did not answer at all. Serves a 403 with an
 * inline dd object to a plain client.
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'alaska',
  url: 'https://commerce.alaska.gov/cbp/main/search/entities',
});
