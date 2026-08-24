/**
 * Run with:
 *
 * node --env-file=.env src/datadome/github.ts
 * node --env-file=.env src/datadome/github.ts --headless
 * node --env-file=.env src/datadome/github.ts --screenshot
 *
 * GitHub signup. Only the signup path is fronted by DataDome; the rest of
 * github.com is not, so pointing this at the bare host solves nothing.
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'github',
  url: 'https://github.com/signup',
});
