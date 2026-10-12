/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sbsd/chewy.ts
 * node --env-file=.env src/akamai/sbsd/chewy.ts --headless
 *
 * chewy.com. SBSD-only on the homepage — no `_abck` sensor script is ever
 * captured here, so `solveAbck()` is expected to report there is nothing to
 * solve; the ledger answer alone is what gets the page through.
 *
 * Was kept local per .gitignore while unproven: a plain Playwright navigation
 * (no solver) through the same proxy got an identical static
 * `AkamaiNetStorage`-served 403 ("No treats beyond this point") with no Bot
 * Manager cookie ever set, and the same happened through four other proxy
 * providers (ProxyCheap spare, oxylabs, rayobyte, decodo) — a blanket edge
 * deny that looked exit-IP-driven. This script, going through the settle/SBSD
 * flow below, reached the real homepage on the same exit that had just been
 * denied, so the block was never consistent; committed after a clean run.
 */
import { runSbsdHomepage } from '#src/akamai/sbsd/homepage.js';

await runSbsdHomepage({
  ignoreHTTPSErrors: true,
  isDenied: ({ html, title }) =>
    /access denied/iu.test(title) ||
    html.includes('No treats beyond this point'),
  origin: 'https://www.chewy.com',
});
