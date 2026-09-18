import type { CDPSession } from 'playwright-core';

import { FULL_VERSION_LIST, PROFILE } from '#src/profile.js';

export const USER_AGENT: string = PROFILE.userAgent;

export const VIEWPORT: null = null;

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

const matchScreenToProfile = async (cdp: CDPSession): Promise<void> => {
  const screen = await readPrimaryScreen(cdp);
  if (screenDrift(screen).length === 0) return;

  const dpr = PROFILE.screen.devicePixelRatio;

  const refuse = (drift: string[]): string =>
    `This display cannot carry the ${PROFILE.os}/Chrome ${PROFILE.chromeVersion} profile: ` +
    `${drift.join(', ')}. Chrome reports its real screen and nothing this build ` +
    `accepts can give it a different work area, so: run headful (headless has no ` +
    `menu bar to report — it starts at 800x600 with availHeight === height), on the ` +
    `display PROFILE.screen was captured from, or recapture PROFILE.screen here.`;

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
    console.warn(`[identity] ${refuse(screenDrift(screen))}`);
    return;
  }

  const drift = screenDrift(await readPrimaryScreen(cdp));
  if (drift.length > 0) console.warn(`[identity] ${refuse(drift)}`);
};

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
