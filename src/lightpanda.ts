/**
 * This is a helper library, not a script. It starts a Lightpanda process and
 * hands back a Playwright page attached to it, for
 * `src/datadome/grainger-lightpanda.ts` and `src/akamai/comcast-lightpanda.ts`.
 *
 * Lightpanda (<https://lightpanda.io>) is a headless browser that speaks CDP
 * and runs V8, with no renderer and no graphics stack — a ~70MB binary that
 * starts in milliseconds. Playwright talks to it over `connectOverCDP`, so
 * most of an existing script carries over.
 *
 * `npm install` downloads the binary to `bin/` for you, via
 * `dev-resources/install-lightpanda.js`. It is also found on $PATH, or point
 * `LIGHTPANDA_PATH=` at a copy you already have.
 *
 * ## the connection is re-originated
 *
 * By default the browser does not talk to your proxy directly. It talks to a
 * local MITM proxy (`src/mitm.ts`) that terminates TLS and makes the upstream
 * request itself, with undici. Without that, DataDome answers Lightpanda with
 * a `t:"bv"` — banned visitor — challenge before any JavaScript runs, purely
 * on the connection: undici sending `User-Agent: Lightpanda/1.0` over the same
 * proxy still gets a plain `t:"fe"`. Pass `reoriginate: false` to see that for
 * yourself.
 *
 * The two flags that make it work are set here: `--ca-cert`, so the proxy's
 * self-signed certificate is trusted, and
 * `--insecure-disable-tls-host-verification`, because one certificate serves
 * every host. They apply to this one browser process, which only ever talks
 * to the local proxy.
 *
 * ## three things that differ from Chrome, and bite immediately
 *
 *   - **Never reuse the page Lightpanda starts with.** Attaching to it leaves
 *     Playwright waiting forever on the first navigation. Always
 *     `context.newPage()`.
 *   - **`context.newCDPSession()` crashes the process.** Lightpanda's reply to
 *     `Target.attachToTarget` trips an assertion inside Playwright, which is
 *     an uncatchable throw, not a rejected promise. So no CDP-level user-agent
 *     override, device metrics, or identity bridge — and no way to patch the
 *     user agent from inside the browser at all. `--user-agent` rejects any
 *     value containing "Mozilla", and `Emulation.setUserAgentOverride` is
 *     ignored on the wire. `mitm.ts` rewrites it upstream instead.
 *   - **`page.content()` and `frame.content()` never return.** Use
 *     `outerHtml()` below, which reads the DOM through `evaluate`.
 *
 * The proxy is a process-level flag rather than a per-context option, so a
 * session that needs its own exit IP needs its own process — which is what
 * `start()` gives you.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  type Browser,
  type BrowserContext,
  chromium,
  type Frame,
  type Page,
} from 'playwright-core';

import { type Capture, type Mitm, start as startMitm } from '#src/mitm.js';

// `npm install` drops the binary in bin/ (dev-resources/install-lightpanda.js).
// Fall back to $PATH so a system-wide install works with no configuration.
const VENDORED = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'bin',
  'lightpanda'
);
const BINARY =
  process.env['LIGHTPANDA_PATH'] ||
  (existsSync(VENDORED) ? VENDORED : 'lightpanda');
const READY_TIMEOUT_MS = 10_000;
const CDP_MAX_MESSAGE_SIZE = 32 * 1024 * 1024;

/**
 * Reserve a free port for the CDP server. Every session needs its own process
 * (see the header), so a fixed port would cap the machine at one browser and
 * fail the rest with "address already in use" — which is what `loadtest.ts
 * --concurrency=2` does to a `:lightpanda` script. Lightpanda binds the port
 * itself, so unlike the MITM proxy this can only ask the kernel for one and
 * hand over the number.
 */
const freePort = async (): Promise<number> => {
  const probe = createServer();
  try {
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    if (address === null || typeof address === 'string') {
      throw new Error('lightpanda: could not reserve a CDP port');
    }
    return address.port;
  } finally {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
};

export type Session = {
  browser: Browser;
  context: BrowserContext;
  /** The MITM proxy in front of the browser, unless `reoriginate` was false. */
  mitm: Mitm | undefined;
  page: Page;
  /** Close the browser connection and stop the Lightpanda process. */
  stop: () => Promise<void>;
};

export type StartOptions = {
  /**
   * URL patterns Lightpanda drops outright (`*` is a wildcard). Interception
   * costs a full refetch per request, so blocking analytics and tag managers
   * at the browser takes real load off the path. It does change the request
   * profile a bot manager sees, so block only what you are willing to be seen
   * not loading.
   */
  blockUrls?: string[];
  /**
   * The `user-agent` and `sec-ch-ua*` the MITM claims upstream. Defaults to
   * the DataDome profile; pass the one your solver was told about.
   */
  identity?: Record<string, string>;
  // eslint-disable-next-line no-unused-vars -- function-type parameter
  log?: (message: string) => void;
  /**
   * Called for every response the browser receives, decoded. This is the MITM
   * proxy's view, so it works whether or not anything is intercepting inside
   * Playwright. Ignored when `reoriginate` is false.
   */
  // eslint-disable-next-line no-unused-vars -- function-type parameter
  onResponse?: (capture: Capture) => void;
  /** The real proxy to reach the internet through. */
  proxy?: string;
  /**
   * Send the browser's traffic out through the local MITM proxy rather than
   * straight to `proxy`. On by default; see the header for why.
   */
  reoriginate?: boolean;
};

/** The whole DOM, as a string. `frame.content()` never returns on Lightpanda. */
export const outerHtml = (frame: Frame): Promise<string> =>
  frame.evaluate(() => document.documentElement.outerHTML);

/**
 * Spawn `lightpanda serve`, wait for the CDP port, and attach.
 * Always `await session.stop()`: the process does not exit on its own.
 */
export const start = async (options: StartOptions = {}): Promise<Session> => {
  const {
    blockUrls = [],
    identity,
    log = console.log,
    onResponse,
    proxy,
    reoriginate = true,
  } = options;

  const mitm = reoriginate
    ? await startMitm({
        debug: process.env['MITM_DEBUG'] === '1',
        ...(identity ? { identity } : {}),
        ...(onResponse ? { onResponse } : {}),
        ...(proxy ? { proxy } : {}),
      })
    : undefined;
  if (mitm) {
    // Never the proxy string itself: it carries credentials.
    const upstream = proxy ? new URL(proxy).host : 'direct';
    log(`mitm proxy on ${mitm.url} -> ${upstream}`);
  }

  const port = await freePort();
  const browserProxy = mitm ? mitm.url : proxy;
  const child = spawn(
    BINARY,
    [
      'serve',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      // Playwright fulfills an intercepted request by sending the whole body
      // back over CDP, base64'd. Lightpanda's default cap is 1MB, and it does
      // not reject the oversized message — it drops the connection, which
      // surfaces much later as "Target page, context or browser has been
      // closed" on every request still in flight. One 1MB analytics bundle is
      // enough. 32MB is plenty of headroom.
      '--cdp-max-message-size',
      String(CDP_MAX_MESSAGE_SIZE),
      ...(browserProxy ? ['--http-proxy', browserProxy] : []),
      ...(mitm
        ? [
            '--ca-cert',
            mitm.caCertPath,
            '--insecure-disable-tls-host-verification',
          ]
        : []),
      ...(blockUrls.length > 0 ? ['--block-urls', blockUrls.join(',')] : []),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });

  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const kill = (): void => {
    child.kill('SIGTERM');
  };
  const abort = async (error: Error): Promise<never> => {
    kill();
    await mitm?.stop();
    throw error;
  };

  for (;;) {
    if (spawnError) {
      return await abort(
        new Error(
          `could not start ${BINARY}: ${spawnError.message} — set LIGHTPANDA_PATH= or put it on $PATH`
        )
      );
    }
    if (child.exitCode !== null) {
      return await abort(
        new Error(`${BINARY} exited with code ${child.exitCode}`)
      );
    }
    try {
      const probe = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (probe.ok) {
        const version = (await probe.json()) as { Browser?: string };
        log(
          `lightpanda ready on ${endpoint} (${version.Browser ?? 'unknown'})`
        );
        break;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      return await abort(
        new Error(
          `${BINARY} did not open a CDP port on ${port} within ${READY_TIMEOUT_MS}ms`
        )
      );
    }
    await sleep(100);
  }

  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => undefined);
    return await abort(new Error('lightpanda opened no browser context'));
  }
  // A fresh page, never the one Lightpanda started with — see the header.
  const page = await context.newPage();

  return {
    browser,
    context,
    mitm,
    page,
    stop: async (): Promise<void> => {
      await browser.close().catch(() => undefined);
      kill();
      await mitm?.stop();
      // Let the port go before anything claims it again.
      await sleep(250);
    },
  };
};
