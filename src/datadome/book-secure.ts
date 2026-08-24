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
  url: 'https://www.book-secure.com/',
});
