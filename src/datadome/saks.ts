/**
 * Run with:
 *
 * node --env-file=.env src/datadome/saks.ts
 * node --env-file=.env src/datadome/saks.ts --headless
 * node --env-file=.env src/datadome/saks.ts --screenshot
 *
 * Saks Fifth Avenue. A straightforward interstitial on the home page.
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'saks',
  url: 'https://www.saksfifthavenue.com/',
});
