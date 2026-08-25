/**
 * Run with:
 *
 * node --env-file=.env src/datadome/book-secure.ts
 * node --env-file=.env src/datadome/book-secure.ts --headless
 * node --env-file=.env src/datadome/book-secure.ts --screenshot
 *
 * book-secure.com, the D-EDGE hotel reservation engine. Note the www — the
 * apex does not resolve.
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'book-secure',
  url: 'https://www.book-secure.com/index.php?s=results&property=sgsin31658&arrival=2026-09-15&departure=2026-09-16&adults1=2&children1=0&locale=en_GB&currency=SGD&stid=56mo09uiq',
});
