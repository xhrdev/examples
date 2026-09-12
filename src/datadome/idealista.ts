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
 *
 * The homepage is the target on purpose. This example was briefly repointed at
 * a Madrid search-results page, and that is a different test: DataDome guards
 * a listings page — the thing scrapers actually want — far harder than a
 * homepage, and answers with a captcha on first contact rather than an
 * interstitial. Solve it and the next document is a block page, so the round
 * loop reports a recurrent challenge and the `i -> c` chain never runs at all.
 * Same code, same address, minutes apart: the homepage escalated and solved,
 * the search page was blocked. A harder target is worth having, but as its own
 * example rather than in place of the escalation one.
 *
 * Advisory in the smoke suite: the site's own escalation timer can beat the
 * solver's answer for the interstitial round, and it can also re-serve the
 * same interstitial rather than escalating at all. The first case is fixed —
 * a round that escalates while its relay is still in flight now gets
 * abandoned instead of corrupting the new round — the second still reads as
 * "The challenge document recurred in the same round" and needs the round
 * model to allow a same-type retry, not just an escalation.
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'idealista',
  url: 'https://www.idealista.com/',
});
