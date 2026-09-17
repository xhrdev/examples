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
 *
 * The other half of the job is to install as little as possible. Every
 * emulation override is a second source of truth for something the browser
 * already knows, and Chrome does not keep the two consistent: emulating the
 * screen flattened `screen.availHeight` onto `screen.height` (no macOS Chrome
 * reports that — there is a menu bar), and overriding `acceptLanguage` with a
 * header string put the q-value inside `navigator.languages`. Both went out on
 * `/akam/13/pixel_*`, which nothing in these scripts models. So the geometry
 * is now real, and the window — not the emulator — is what makes it match.
 */
import type { CDPSession } from 'playwright-core';

import { FULL_VERSION_LIST, PROFILE } from '#src/profile.js';

/** What the browser claims, and what `newContext({ userAgent })` is given. */
export const USER_AGENT: string = PROFILE.userAgent;

/**
 * `null`, meaning "use the browser window's own size", and it has to stay that
 * way.
 *
 * Playwright implements a fixed `viewport` with
 * `Emulation.setDeviceMetricsOverride`, and under that override Chrome builds
 * the page's screen from the emulated metrics. Measured, same display, same
 * build, nothing else changed:
 *
 *   viewport: null              screen 1512x982, avail 1512x948, availTop 34
 *   viewport: 1200x817          screen 1200x817, avail 1200x817, availTop  0
 *
 * Passing the profile's inner size therefore costs the real screen size and
 * the real work area together, to buy a viewport the window already has: with
 * `null`, the same run reported `inner [1200,817]` / `outer [1200,904]` on its
 * own, and `Browser.setWindowBounds` below makes that deterministic rather
 * than a property of whatever size Chrome happened to open at.
 *
 * Still exported, and still passed as `viewport:` by the scripts, because the
 * value that must reach `newContext` is exactly this one.
 */
export const VIEWPORT: null = null;

/**
 * The screen fields the profile declares and `Emulation.getScreenInfos`
 * reports back. A drift gets named rather than guessed at.
 */
const SCREEN_FIELDS = [
  'availHeight',
  'availLeft',
  'availTop',
  'availWidth',
  'colorDepth',
  'devicePixelRatio',
  'height',
  'width',
] as const;

type ScreenReading = Record<(typeof SCREEN_FIELDS)[number], number>;

const screenDrift = (reading: ScreenReading): string[] =>
  SCREEN_FIELDS.filter((field) => reading[field] !== PROFILE.screen[field]).map(
    (field) =>
      `${field}=${reading[field]} (profile says ${PROFILE.screen[field]})`
  );

const readPrimaryScreen = async (
  cdp: CDPSession
): Promise<{ id: string } & ScreenReading> => {
  const { screenInfos } = await cdp.send('Emulation.getScreenInfos');
  const primary = screenInfos.find((info) => info.isPrimary) ?? screenInfos[0];
  if (!primary) throw new Error('Emulation.getScreenInfos returned no screens');
  return primary;
};

/**
 * Make `screen` report the profile, without emulating it.
 *
 * On the display the profile was captured from there is nothing to do, and
 * that is the whole point: a real screen is the only one whose
 * `availHeight`/`availTop` carry the macOS menu bar, because
 * `Emulation.setDeviceMetricsOverride` has no parameter that separates the
 * available area from the screen (checked against the full parameter list in
 * playwright-core's `types/protocol.d.ts`, and measured: every call to it,
 * including a `width: 0, height: 0` scale-factor-only call, sets
 * `availHeight === height` and `availTop === 0`).
 *
 * The protocol does define a command that could separate them —
 * `Emulation.updateScreen`, documented "Only supported in headless mode",
 * taking physical pixels and a `workAreaInsets` — so it is tried. On the Chrome
 * these scripts pin it does not exist: 146.0.7680.81 answers
 * `'Emulation.updateScreen' wasn't found` in headless and headful alike, and
 * headless Chrome's other lever, `--screen-info`, has no work-area key in that
 * build either (`workAreaInsets=` aborts the launch with the same status as a
 * deliberately nonsense key, while `colorDepth=`/`devicePixelRatio=` are
 * accepted). Faking one in JS is not an option that improves anything: an
 * `availHeight` that answers a descriptor read, a `toString` or a second realm
 * differently from a native accessor is a sharper tell than the flat work area
 * it replaces.
 *
 * So there is nothing to install, and a display that does not already carry the
 * profile's geometry is refused by name rather than quietly shipping a screen
 * that disagrees with the profile the solver was handed. In practice: run
 * headful, on the display `PROFILE.screen` was captured from. Headless starts
 * at 800x600 with no work area and is refused for that reason.
 */
const matchScreenToProfile = async (cdp: CDPSession): Promise<void> => {
  const screen = await readPrimaryScreen(cdp);
  if (screenDrift(screen).length === 0) return;

  const dpr = PROFILE.screen.devicePixelRatio;
  const refuse = (drift: string[]): Error =>
    new Error(
      `This display cannot carry the ${PROFILE.os}/Chrome ${PROFILE.chromeVersion} profile: ` +
        `${drift.join(', ')}. Chrome reports its real screen and nothing this build ` +
        `accepts can give it a different work area, so: run headful (headless has no ` +
        `menu bar to report — it starts at 800x600 with availHeight === height), on the ` +
        `display PROFILE.screen was captured from, or recapture PROFILE.screen here.`
    );

  // Inert on Chrome 146 — the method is not implemented and this always
  // throws. Kept because it is the only command in the protocol that takes a
  // work area, so a Chrome that ships it makes headless correct for free; the
  // refusal below is what actually happens today.
  try {
    await cdp.send('Emulation.updateScreen', {
      colorDepth: PROFILE.screen.colorDepth,
      devicePixelRatio: dpr,
      height: PROFILE.screen.height * dpr,
      left: 0,
      screenId: screen.id,
      top: 0,
      width: PROFILE.screen.width * dpr,
      workAreaInsets: {
        bottom:
          (PROFILE.screen.height -
            PROFILE.screen.availTop -
            PROFILE.screen.availHeight) *
          dpr,
        left: PROFILE.screen.availLeft * dpr,
        right:
          (PROFILE.screen.width -
            PROFILE.screen.availLeft -
            PROFILE.screen.availWidth) *
          dpr,
        top: PROFILE.screen.availTop * dpr,
      },
    });
  } catch {
    throw refuse(screenDrift(screen));
  }

  const drift = screenDrift(await readPrimaryScreen(cdp));
  if (drift.length > 0) throw refuse(drift);
};

/**
 * Size and place the window the way the profile says, which is what makes the
 * viewport right without emulating it.
 *
 * The outer size is the profile's; the inner size follows from it, because the
 * browser subtracts its own chrome (measured headful on the pinned Chrome for
 * Testing 146.0.7680.81: 87px, so the profile's `904` outer gives its `817`
 * inner). `screenX`/`screenY` come from the same capture, so a window that is
 * asked where it is answers with the profile's numbers too. Headless is not a
 * case here — `matchScreenToProfile` has already refused it.
 */
const pinWindowToProfile = async (cdp: CDPSession): Promise<void> => {
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', {
    bounds: {
      height: PROFILE.screen.outerHeight,
      left: PROFILE.screen.screenX,
      top: PROFILE.screen.screenY,
      width: PROFILE.screen.outerWidth,
      windowState: 'normal',
    },
    windowId,
  });
};

/**
 * Install the identity on a live page.
 *
 * `Emulation.setUserAgentOverride` rather than Playwright's `userAgent`
 * option alone, because only the CDP form carries `userAgentMetadata` — the
 * structured client hints Akamai reads. Playwright's option sets the header
 * and leaves `navigator.userAgentData` describing the real browser.
 *
 * `acceptLanguage` is `PROFILE.languages`, a preference list and not a header:
 * Chrome splits it on commas for `navigator.languages` and re-serializes it
 * with q-values for the header. Handing it the header form `en-US,en;q=0.9`
 * gets both wrong at once, and this was measured on Chrome 146 and 151 alike —
 * `navigator.languages` became `["en-US","en;q=0.9"]`, which is not a language
 * tag any browser produces, and the header went out as
 * `en-US,en;q=0.9;q=0.9`. `en-US,en` yields `["en-US","en"]` and
 * `Accept-Language: en-US,en;q=0.9`, which is what Chrome sends on its own.
 */
export const applyIdentity = async (cdp: CDPSession): Promise<void> => {
  await cdp.send('Emulation.setUserAgentOverride', {
    acceptLanguage: PROFILE.languages,
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
  await matchScreenToProfile(cdp);
  await pinWindowToProfile(cdp);
};
