import type { Page } from 'playwright-core';

import type { AkamaiHandle } from '#src/akamai/sbsd/solver.js';
import { sleep } from '#src/util.js';

const QUIET_MS = 5000;

/**
 * Wait for an SBSD bootstrap to finish reloading itself.
 *
 * Call this before the first navigation: it starts watching for documents
 * then, and a watcher attached afterwards would miss the very reload it is
 * there to wait for. Await the returned function after `page.goto`.
 *
 * Two conditions, both necessary. A carrier answered says the bootstrap has
 * done its job and the reload is coming; the quiet window says it has arrived.
 * Waiting on the quiet window alone returns during the pause before the
 * carrier ever fires, which on aa.com is several seconds long.
 */
export const trackSettle = (
  page: Page,
  akamai: Pick<AkamaiHandle, 'carriersAnswered'>
): (() => Promise<void>) => {
  let lastDocumentAt = Date.now();
  page.on('response', (response) => {
    const request = response.request();
    if (
      request.resourceType() === 'document' &&
      request.frame() === page.mainFrame() &&
      !(response.status() >= 300 && response.status() < 400)
    )
      lastDocumentAt = Date.now();
  });

  return async () => {
    const deadline = Date.now() + 60_000;
    while (
      (akamai.carriersAnswered() === 0 ||
        Date.now() - lastDocumentAt < QUIET_MS) &&
      Date.now() < deadline
    )
      await sleep(500);
    await page.waitForLoadState('domcontentloaded');
    await sleep(1500);
  };
};
