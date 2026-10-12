/**
 * The whole of an SBSD example that only has to reach a homepage.
 *
 * chewy, tractorsupply and magazineluiza were the same script with a different
 * origin and a different way of recognising the block page, so that is all a
 * caller supplies. A property that needs a form filled in or a search driven
 * (hilton, aa, aircanada) uses `runAkamaiTarget` directly instead.
 */
import {
  type AkamaiSessionOptions,
  runAkamaiTarget,
} from '#src/akamai/session.js';
import { attach } from '#src/akamai/sbsd/solver.js';
import { trackSettle } from '#src/akamai/sbsd/settle.js';
import { log, sleep } from '#src/util.js';

export type SbsdHomepageOptions = Pick<
  AkamaiSessionOptions,
  'ignoreHTTPSErrors' | 'locale' | 'timezoneId'
> & {
  /** Whether the document that came back is the property's block page. */
  // eslint-disable-next-line no-unused-vars -- function-type parameter
  isDenied(document: { html: string; title: string }): boolean;
  origin: string;
};

export async function runSbsdHomepage({
  isDenied,
  origin,
  ...sessionOptions
}: SbsdHomepageOptions): Promise<void> {
  const url = `${origin}/`;

  await runAkamaiTarget(
    { ...sessionOptions, serviceWorkers: 'block' },
    async ({ apiKey, cookies, host, page }) => {
      // Installed before the first navigation: the SBSD carrier fires during
      // the bootstrap document, and a router attached afterwards would miss it.
      const akamai = attach(page, {
        host,
        origin,
        ...(apiKey ? { solverApiKey: apiKey } : {}),
      });
      const settle = trackSettle(page, akamai);

      await page.goto(url, { timeout: 90_000, waitUntil: 'domcontentloaded' });
      await settle();
      log(`Document reached: ${page.url()}`);

      try {
        await akamai.solveAbck();
        log(
          `_abck accepted: ~${(await cookies(origin))['_abck']?.split('~')[1]}~`
        );
      } catch (e) {
        log(`_abck not solved: ${(e as Error).message}`);
      }

      await page.goto(url, { timeout: 90_000, waitUntil: 'domcontentloaded' });
      await sleep(2000);

      const html = await page.content();
      const title = await page.title();
      log(`Final URL: ${page.url()} ("${title}")`);

      return isDenied({ html, title })
        ? { code: 2, result: 'FAIL - Access Denied' }
        : { code: 0, result: 'SUCCESS - Akamai solved, homepage reached' };
    }
  );
}
