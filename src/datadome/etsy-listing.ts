/**
 * Run with:
 *
 * node --env-file=.env src/datadome/etsy-listing.ts
 * node --env-file=.env src/datadome/etsy-listing.ts --headless
 * node --env-file=.env src/datadome/etsy-listing.ts --screenshot
 *
 * A second Etsy listing. Kept as a local reproduction — not solving
 * reliably yet.
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'etsy-listing',
  url: 'https://www.etsy.com/listing/1815313407/anniversary-gift-for-himpersonalized',
});
