/**
 * Run with:
 *
 * node --env-file=.env src/datadome/book-secure.ts
 * node --env-file=.env src/datadome/book-secure.ts --headless
 * node --env-file=.env src/datadome/book-secure.ts --screenshot
 *
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'book-secure-listing',
  url: 'https://www.book-secure.com/index.php?s=results&property=twtai25997&arrival=2026-09-27&departure=2026-09-28&code=EEFT&adults1=1&children1=0&locale=en_GB&currency=TWD&stid=x6i4mqavu&style=DIRECT&Hotelnames=ASIATWHomehotel&hname=ASIATWHomehotel&redir=BIZ&rt=1563262411',
});
