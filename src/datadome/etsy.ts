/**
 * Run with:
 *
 * node --env-file=.env src/datadome/etsy.ts
 * node --env-file=.env src/datadome/etsy.ts --headless
 * node --env-file=.env src/datadome/etsy.ts --screenshot
 *
 * Etsy. Scores the request before it challenges — the block response carries
 * an x-datadome-riskscore header — and is the least forgiving target in this
 * directory. Expect it to need a clean residential IP.
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'etsy',
  url: 'https://www.etsy.com/listing/4409872205/linen-sheer-cafe-curtains-farmhouse',
});
