/**
 * Run with:
 *
 * node --env-file=.env src/datadome/grainger.ts
 * node --env-file=.env src/datadome/grainger.ts --headless
 * node --env-file=.env src/datadome/grainger.ts --screenshot
 *
 * The reference target for this repo, through the browser bridge: the same
 * grainger.com that grainger-undici.ts, -axios.ts and -fetch.ts clear without
 * a browser. Reach for one of those if all you want is a cookie; this one is
 * what to copy when the site needs a browser anyway.
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'grainger',
  url: 'https://www.grainger.com/',
});
