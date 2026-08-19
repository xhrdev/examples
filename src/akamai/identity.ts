/**
 * The browser identity the Akamai examples install on a real Chrome.
 *
 * Akamai scores the sensor telemetry against the headers the browser actually
 * sends, so these overrides have to say the same thing as the profile the
 * solver was told to model. When they disagree the failure is silent and
 * expensive: `_abck` sits at `~-1~` for as many rounds as you give it, and
 * nothing in the transcript names the version as the reason.
 *
 * Everything here is derived from `src/profile.ts` for that reason — these
 * used to be literals copied into each script, which is exactly how they ended
 * up two major versions behind the Chrome the scripts were launching.
 */
import type { CDPSession } from 'playwright-core';

import { FULL_VERSION_LIST, PROFILE } from '#src/profile.js';

/** What the browser claims, and what `newContext({ userAgent })` is given. */
export const USER_AGENT: string = PROFILE.userAgent;

/**
 * The viewport, matched to the profile's inner window.
 *
 * `innerHeight` rather than a round number: the profile declares this window
 * to the solver, and a browser whose real viewport disagrees with the declared
 * one is a mismatch like any other.
 */
export const VIEWPORT: { height: number; width: number } = {
  height: PROFILE.screen.innerHeight,
  width: PROFILE.screen.innerWidth,
};

/**
 * Install the identity on a live page.
 *
 * `Emulation.setUserAgentOverride` rather than Playwright's `userAgent`
 * option alone, because only the CDP form carries `userAgentMetadata` — the
 * structured client hints Akamai reads. Playwright's option sets the header
 * and leaves `navigator.userAgentData` describing the real browser.
 */
export const applyIdentity = async (cdp: CDPSession): Promise<void> => {
  await cdp.send('Emulation.setUserAgentOverride', {
    acceptLanguage: 'en-US,en;q=0.9',
    userAgent: PROFILE.userAgent,
    userAgentMetadata: {
      architecture: 'arm',
      bitness: '64',
      brands: [...PROFILE.brands],
      fullVersion: PROFILE.chromeFullVersion,
      fullVersionList: FULL_VERSION_LIST,
      mobile: false,
      model: '',
      platform: 'macOS',
      platformVersion: PROFILE.platformVersion,
    },
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    deviceScaleFactor: PROFILE.screen.devicePixelRatio,
    height: PROFILE.screen.innerHeight,
    mobile: false,
    screenHeight: PROFILE.screen.height,
    screenWidth: PROFILE.screen.width,
    width: PROFILE.screen.innerWidth,
  });
};
