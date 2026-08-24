/**
 * Run with:
 *
 * node --env-file=.env src/datadome/idealista.ts
 * node --env-file=.env src/datadome/idealista.ts --headless
 * node --env-file=.env src/datadome/idealista.ts --screenshot
 *
 * The escalation case. idealista.com opens with an interstitial (`rt:"i"`)
 * and frequently turns it into a captcha (`rt:"c"`) rather than accepting the
 * first submission, which is the `i -> c` chain the round loop in solver.ts
 * exists for. Run this one after changing anything in that loop.
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'idealista',
  url: 'https://www.idealista.com/',
});
