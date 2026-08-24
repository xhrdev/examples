/**
 * Run with:
 *
 * node --env-file=.env src/datadome/anthropologie.ts
 * node --env-file=.env src/datadome/anthropologie.ts --headless
 * node --env-file=.env src/datadome/anthropologie.ts --screenshot
 *
 * Anthropologie. Same shape as Saks, on an origin that answers HTTP/1.1
 * rather than h2 while challenging.
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'anthropologie',
  url: 'https://www.anthropologie.com/',
});
