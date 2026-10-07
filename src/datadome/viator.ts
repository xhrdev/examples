/**
 * Run with:
 *
 * node --env-file=.env src/datadome/viator.ts
 * node --env-file=.env src/datadome/viator.ts --headless
 * node --env-file=.env src/datadome/viator.ts --screenshot
 *
 * Viator, the TripAdvisor-owned tours and activities marketplace. Fronted by
 * DataDome; a flagged client gets a 403 with an inline dd object.
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'viator',
  url: 'https://www.viator.com/',
});
