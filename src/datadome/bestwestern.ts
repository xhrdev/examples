/**
 * Run with:
 *
 * node --env-file=.env src/datadome/bestwestern.ts
 * node --env-file=.env src/datadome/bestwestern.ts --headless
 * node --env-file=.env src/datadome/bestwestern.ts --screenshot
 *
 * Best Western. A captcha from the first request — the block page comes back
 * `rt:'c'` rather than the `rt:'i'` interstitial most of this directory
 * opens with, so there is no escalation to wait for and the puzzle is the
 * whole job. The booking paths under /en_US/book/ challenge the same way;
 * book.bestwestern.com is a redirect and not worth pointing at.
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'bestwestern',
  url: 'https://www.bestwestern.com/',
});
