/**
 * Run with:
 *
 * node --env-file=.env src/datadome/tripadvisor.ts
 * node --env-file=.env src/datadome/tripadvisor.ts --headless
 * node --env-file=.env src/datadome/tripadvisor.ts --screenshot
 *
 * tripadvisor.com homepage.
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'tripadvisor',
  url: 'https://www.tripadvisor.com/',
});
