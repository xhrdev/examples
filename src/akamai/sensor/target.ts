/**
 * The whole of an Akamai sensor example that only has to reach a page.
 *
 * comcast, ca-edd, cvs and lowes were the same script with a different URL and
 * a different line to print on success. The one real difference is `lenient`:
 * cvs.com and lowes.com do not always challenge, so a solver timeout with no
 * `_abck` round to answer looks identical to one that gave up, and the page
 * itself is what tells them apart.
 */
import type { Page } from 'playwright-core';

import {
  type AkamaiSessionOptions,
  looksDenied,
  runAkamaiTarget,
} from '#src/akamai/session.js';
import { solve } from '#src/akamai/sensor/solver.js';
import { RateLimitError } from '#src/rate-limit.js';
import { solverWsUrl } from '#src/solver-url.js';
import { log, sleep } from '#src/util.js';

export type SensorTargetOptions = Pick<AkamaiSessionOptions, 'locale'> & {
  /**
   * A solver failure other than a 429 falls through to the page check instead
   * of failing the run, and a blank page is a failure of its own.
   */
  lenient?: boolean;
  /** How long to let the page settle after the solve before reading it. */
  settleMs: number;
  /** The text after `SUCCESS - `, given the page that was reached. */
  // eslint-disable-next-line no-unused-vars -- function-type parameter
  success(page: Page): string;
  url: string;
};

export async function runSensorTarget({
  lenient = false,
  settleMs,
  success,
  url,
  ...sessionOptions
}: SensorTargetOptions): Promise<void> {
  await runAkamaiTarget(
    { ...sessionOptions, ignoreHTTPSErrors: true },
    async ({ apiKey, host, page, proxy }) => {
      try {
        await solve(page, {
          ...(proxy ? { proxy } : {}),
          ...(apiKey ? { solverApiKey: apiKey } : {}),
          solverUrl: solverWsUrl(host, '/akamai/session'),
          url,
        });
      } catch (e) {
        if (!lenient || e instanceof RateLimitError) throw e;
        log(`solve() did not complete: ${(e as Error).message}`);
      }

      await sleep(settleMs);

      const html = await page.content();
      log(`Final URL: ${page.url()}`);

      if (looksDenied(html)) return { code: 2, result: 'FAIL - Access Denied' };
      if (lenient && (await page.locator('body').innerText()).trim() === '')
        return { code: 1, result: 'FAIL - page never rendered' };
      return { code: 0, result: `SUCCESS - ${success(page)}` };
    }
  );
}
