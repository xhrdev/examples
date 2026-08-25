/**
 * Run with:
 *
 * node --env-file=.env src/datadome/yelp.ts
 * node --env-file=.env src/datadome/yelp.ts --headless
 * node --env-file=.env src/datadome/yelp.ts --screenshot
 *
 * Yelp signup. The odd one out: the signup page comes back HTTP 200 with
 * DataDome only present as the client-side tag (js.datadome.co/tags.js), so
 * whether you get a challenge at all depends on the exit IP. From an address
 * DataDome likes there is nothing to solve and the run fails with a timeout
 * rather than a block — that is the target, not the script.
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'yelp',
  url: 'https://biz.yelp.com/signup',
});
