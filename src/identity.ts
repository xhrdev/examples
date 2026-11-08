/**
 * The CDP overrides that make a real Chrome present as `PROFILE`, whatever
 * build and display it is actually running on. Shared by both vendors: a
 * window or a client hint that disagrees with the profile the solver was told
 * about is the same mismatch to DataDome as it is to Akamai.
 */
import type { Browser, CDPSession } from 'playwright-core';

import { PROFILE, USER_AGENT_OVERRIDE } from '#src/profile.js';

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

/** Size and place the window the way the profile's readings say it is. */
export const pinWindowToProfile = async (cdp: CDPSession): Promise<void> => {
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

/** Worker realms the page-level override does not reach. */
const WORKER_TARGETS = ['service_worker', 'shared_worker'] as const;

/**
 * Present the profile in the worker realms too.
 *
 * `Emulation.setUserAgentOverride` on the page covers the page, its iframes
 * and its dedicated workers. A `SharedWorker` is its own target and keeps the
 * real browser: its `navigator.userAgent` and client hints name the installed
 * Chrome rather than the profile's, and its languages and `platformVersion`
 * are the machine's. A script that reads the same thing in the page and in a
 * shared worker (coupang's sec-g does) then sees two different browsers.
 *
 * The realm is caught paused at start, overridden, then resumed, so the
 * override is in place before any of its code reads `navigator`.
 */
export const applyWorkerIdentity = async (browser: Browser): Promise<void> => {
  const session = await browser.newBrowserCDPSession();
  const seen = new Set<string>();
  let nextId = 1;
  const toWorker = (sessionId: string, method: string, params: unknown) =>
    session.send('Target.sendMessageToTarget', {
      message: JSON.stringify({ id: nextId++, method, params }),
      sessionId,
    });

  session.on('Target.attachedToTarget', ({ targetInfo }) => {
    if (!(WORKER_TARGETS as readonly string[]).includes(targetInfo.type))
      return;
    // `Target.attachToTarget` below emits another `attachedToTarget` for the
    // same target, which without this re-enters and attaches forever.
    if (seen.has(targetInfo.targetId)) return;
    seen.add(targetInfo.targetId);
    let attached: null | string = null;
    void (async () => {
      try {
        const { sessionId } = await session.send('Target.attachToTarget', {
          flatten: false,
          targetId: targetInfo.targetId,
        });
        attached = sessionId;
        await toWorker(
          sessionId,
          'Emulation.setUserAgentOverride',
          USER_AGENT_OVERRIDE
        );
        await toWorker(
          sessionId,
          'Network.setUserAgentOverride',
          USER_AGENT_OVERRIDE
        );
      } catch (error) {
        console.warn(
          `[identity] ${targetInfo.type} ${targetInfo.url} keeps the real browser: ` +
            (error as Error).message
        );
      } finally {
        // Whatever happened, the target must not stay paused: the page is
        // waiting on it.
        if (attached !== null)
          void toWorker(attached, 'Runtime.runIfWaitingForDebugger', {}).catch(
            () => undefined
          );
      }
    })();
  });

  await session.send('Target.setAutoAttach', {
    autoAttach: true,
    filter: WORKER_TARGETS.map((type) => ({ exclude: false, type })),
    flatten: true,
    waitForDebuggerOnStart: true,
  });
};

export const applyIdentity = async (cdp: CDPSession): Promise<void> => {
  await cdp.send('Emulation.setUserAgentOverride', USER_AGENT_OVERRIDE);
  await matchScreenToProfile(cdp);
  await pinWindowToProfile(cdp);
};
