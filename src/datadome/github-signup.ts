/**
 * Run with:
 *
 * node --env-file=.env src/datadome/github-signup.ts
 * node --env-file=.env src/datadome/github-signup.ts --headless
 * node --env-file=.env src/datadome/github-signup.ts --screenshot
 *
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'github-signup',
  url: 'https://github.com/signup',
});
