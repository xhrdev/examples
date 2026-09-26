/**
 * Run with:
 *
 * node --env-file=.env src/datadome/agrizone.ts
 * node --env-file=.env src/datadome/agrizone.ts --headless
 * node --env-file=.env src/datadome/agrizone.ts --screenshot
 *
 * agrizone.net/recherche/ challenges with DataDome (403 + a `datadome=`
 * cookie on the first response). Not clearing yet — kept locally per
 * .gitignore rather than committed, until it does.
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'agrizone',
  url: 'https://www.agrizone.net/recherche/',
});
