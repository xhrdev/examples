/**
 * Run with:
 *
 * node --env-file=.env src/datadome/neimanmarcus.ts
 * node --env-file=.env src/datadome/neimanmarcus.ts --headless
 * node --env-file=.env src/datadome/neimanmarcus.ts --screenshot
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'neimanmarcus',
  url: 'https://www.neimanmarcus.com/p/gorski-reversible-toscana-lamb-shearling-jacket-prod282500173',
});
