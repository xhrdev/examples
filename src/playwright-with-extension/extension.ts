/**
 * This is a helper library, not a script. It exposes `launchWithExtension`,
 * which loads the xhr.dev Autosolver Chrome extension into a real Chrome and
 * hands the browser back as a Playwright context.
 *
 * Every other example in this repo drives the solver from Node: the script
 * holds the session, computes nothing, and relays payloads through a page it
 * controls. The extension inverts that. It lives in the browser, watches for
 * challenges itself, and answers them in whatever tab you happen to be on —
 * so the Playwright script here does not solve anything. It opens a page and
 * waits, and the extension does the work underneath it.
 *
 * That makes this the example to copy when what you want is a *browsing
 * session* that stays cleared, rather than a cookie to carry somewhere else.
 *
 * ## Three things about loading an extension that are not obvious
 *
 *   - Chrome 137 removed `--load-extension`. The switch is ignored, no error is
 *     printed, and the extension simply is not there. It goes in over CDP
 *     instead, with `--enable-unsafe-extension-debugging`.
 *   - `Extensions.loadUnpacked` is a *browser-level* CDP command, so it cannot
 *     be sent over a page session. It goes over the raw browser WebSocket
 *     before Playwright attaches.
 *   - Playwright's bundled Chromium is not a substitute for Chrome here. It
 *     cannot load an extension headless at all, and the anti-bot vendors score
 *     it differently — measured against aa.com, `_abck` never leaves `~-1~` in
 *     the bundled build and is accepted in a few rounds in real Chrome.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  type Browser,
  type BrowserContext,
  chromium,
  type Worker,
} from 'playwright-core';

/** Where a checkout of xhrdev/extension might be. */
const EXTENSION_CANDIDATES = [
  process.env['extension_path'],
  process.env['EXTENSION_PATH'],
  path.join(process.cwd(), '..', 'extension'),
  path.join(os.homedir(), 'dev', 'extension'),
];

/** Where Chrome might be. Playwright installs the first Linux one in CI. */
const CHROME_CANDIDATES = [
  process.env['CHROME_PATH'],
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
];

/* eslint-disable no-unused-vars -- function-type parameters */
export type ExtensionSession = {
  close: () => Promise<void>;
  context: BrowserContext;
  extensionId: string;
  /** Drive a solve directly, as the popup's buttons do. */
  solve: (
    tabId: number,
    vendor: 'akamai' | 'datadome',
    url: string
  ) => Promise<unknown>;
  /** What the extension thinks happened on a tab. */
  status: (tabId: number) => Promise<ExtensionStatus>;
  /** The extension's own tab id for the frontmost page. */
  tabId: () => Promise<number>;
  /** Every line the extension has logged, newest last. */
  transcript: () => Promise<string[]>;
  /** Block until a tab reaches a settled outcome. */
  waitForOutcome: (
    tabId: number,
    timeoutMs?: number
  ) => Promise<ExtensionStatus['outcome']>;
};

/**
 * The slice of the extension API the `evaluate` bodies below touch.
 *
 * Declared here rather than adding `@types/chrome`: those bodies are
 * serialised and run inside the extension's own contexts, not in this process,
 * so nothing here needs the global to exist at runtime — only to typecheck. A
 * dependency describing the entire extension surface would be a large answer
 * to three calls.
 */
declare const chrome: {
  runtime: { sendMessage: (message: unknown) => Promise<unknown> };
  storage: {
    local: { set: (values: Record<string, unknown>) => Promise<void> };
  };
  tabs: {
    query: (query: Record<string, unknown>) => Promise<Array<{ id?: number }>>;
  };
};

export type ExtensionSettings = {
  /** Sent as `x-api-key`. Only a hosted trial box needs one. */
  apiKey?: string;
  /** Solve without being asked when a challenge is detected. Default true. */
  autoSolve?: boolean;
  /** Origins to instrument from the first byte; Akamai needs this. */
  eagerOrigins?: string[];
  /** `host=` in either form `src/solver-url.ts` accepts. */
  host: string;
};

export type ExtensionStatus = {
  log: Array<{ at: number; level: string; message: string; scope: string }>;
  outcome: {
    at: number;
    detail?: Record<string, unknown>;
    message?: string;
    state: 'blocked' | 'failed' | 'running' | 'solved';
    vendor: string;
  } | null;
  running: boolean;
};

const firstExisting = (
  candidates: Array<string | undefined>
): string | undefined =>
  candidates.find(
    (candidate): candidate is string =>
      Boolean(candidate) &&
      // This file's own constants plus two environment variables the operator
      // set deliberately. There is no untrusted path here.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.existsSync(candidate as string)
  );

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });

const waitForEndpoint = async (
  endpoint: string
): Promise<{ webSocketDebuggerUrl: string }> => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      return (await response.json()) as { webSocketDebuggerUrl: string };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Chrome never opened a debugging endpoint at ${endpoint}`);
};

/** `Extensions.loadUnpacked` is browser-level, so it goes over the raw socket. */
const loadUnpacked = (
  debuggerUrl: string,
  extensionPath: string
): Promise<{ id: string }> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(debuggerUrl);
    socket.onopen = (): void =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Extensions.loadUnpacked',
          params: { path: extensionPath },
        })
      );
    socket.onmessage = (event): void => {
      const message = JSON.parse(String(event.data)) as {
        error?: unknown;
        id?: number;
        result?: { id: string };
      };
      if (message.id !== 1) return;
      socket.close();
      if (message.error) {
        reject(
          new Error(
            `Extensions.loadUnpacked failed: ${JSON.stringify(message.error)}. ` +
              'This needs --enable-unsafe-extension-debugging and a Chrome new ' +
              'enough to have the Extensions CDP domain.'
          )
        );
      } else resolve(message.result as { id: string });
    };
    socket.onerror = (): void =>
      reject(new Error('could not reach the browser endpoint'));
  });

/**
 * Launch Chrome with the extension loaded and configured.
 *
 * Returns once the extension's service worker is running and its settings are
 * written, so the caller can navigate straight away.
 */
export async function launchWithExtension(
  settings: ExtensionSettings,
  options: { headless?: boolean } = {}
): Promise<ExtensionSession> {
  const extensionPath = firstExisting(EXTENSION_CANDIDATES);
  if (!extensionPath) {
    throw new Error(
      'could not find a checkout of the extension. Clone ' +
        'git@github.com:xhrdev/extension.git next to this repo, or set ' +
        'extension_path= in .env to point at it.'
    );
  }
  const chromePath = firstExisting(CHROME_CANDIDATES);
  if (!chromePath) {
    throw new Error(
      'could not find Google Chrome. Set CHROME_PATH, or run ' +
        "`npx playwright install chrome`. Playwright's bundled Chromium will " +
        'not do: it cannot load an extension headless.'
    );
  }

  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'xhrdev-extension-')
  );
  const port = await freePort();
  const child: ChildProcess = spawn(
    chromePath,
    [
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--enable-unsafe-extension-debugging',
      `--remote-debugging-port=${port}`,
      // The same flags every browser example here uses. Dropping
      // AutomationControlled changes what the vendors see.
      '--disable-blink-features=AutomationControlled',
      '--window-size=1200,904',
      ...(options.headless ? ['--headless=new'] : []),
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  const endpoint = `http://127.0.0.1:${port}`;
  const version = await waitForEndpoint(endpoint);
  const { id: extensionId } = await loadUnpacked(
    version.webSocketDebuggerUrl,
    extensionPath
  );

  const browser: Browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0] as BrowserContext;

  // The extension's own worker, not one of Chrome's component extensions.
  const mine = (): undefined | Worker =>
    context
      .serviceWorkers()
      .find((worker) => worker.url().includes(extensionId));
  let worker = mine();
  const deadline = Date.now() + 30_000;
  while (!worker && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    worker = mine();
  }
  if (!worker) throw new Error('the extension service worker never started');

  await worker.evaluate((values) => chrome.storage.local.set(values), {
    apiKey: settings.apiKey ?? '',
    autoSolve: settings.autoSolve ?? true,
    eagerOrigins: settings.eagerOrigins ?? [],
    host: settings.host,
  } as Record<string, unknown>);

  // The message API cannot be driven from the service worker: a message never
  // reaches its own sender, so `status` asked there answers nobody. An
  // extension page is what the popup is, so this is the same path the product
  // uses rather than a test-only door.
  const rpcPage = await context.newPage();
  await rpcPage.goto(`chrome-extension://${extensionId}/options.html`);
  const call = async <T>(message: Record<string, unknown>): Promise<T> =>
    rpcPage.evaluate(async (payload) => {
      const response = (await chrome.runtime.sendMessage(payload)) as {
        error?: string;
        ok?: boolean;
        value?: unknown;
      };
      if (!response?.ok)
        throw new Error(response?.error ?? 'the extension did not answer');
      return response.value;
    }, message) as Promise<T>;

  const status = (tabId: number): Promise<ExtensionStatus> =>
    call<ExtensionStatus>({ tabId, type: 'status' });

  const session: ExtensionSession = {
    close: async (): Promise<void> => {
      await browser.close().catch(() => undefined);
      child.kill();
      // Chrome is still flushing its profile when `kill` returns, and removing
      // the directory underneath it fails with ENOTEMPTY. Wait for the process
      // to actually go, then retry the removal — a leftover temp directory is
      // not worth failing a run over, so it is best-effort either way.
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null)
          return resolve();
        const timer = setTimeout(resolve, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      try {
        fs.rmSync(userDataDir, {
          force: true,
          maxRetries: 10,
          recursive: true,
          retryDelay: 200,
        });
      } catch {
        // Left for the OS to clean out of its temp directory.
      }
    },
    context,
    extensionId,
    solve: (tabId, vendor, url) => call({ tabId, type: 'solve', url, vendor }),
    status,
    tabId: async (): Promise<number> => {
      const pages = context
        .pages()
        .filter((page) => !page.url().startsWith('chrome-extension://'));
      const target = pages.at(-1);
      if (target) await target.bringToFront();
      return worker.evaluate(() =>
        chrome.tabs
          .query({ active: true, currentWindow: true })
          .then((tabs) => tabs[0]?.id ?? -1)
      );
    },
    transcript: async (): Promise<string[]> =>
      (await status(-1)).log.map(
        (entry) => `[${entry.scope}] ${entry.message}`
      ),
    waitForOutcome: async (tabId, timeoutMs = 180_000) => {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const current = await status(tabId);
        if (
          current.outcome &&
          !current.running &&
          current.outcome.state !== 'running'
        ) {
          return current.outcome;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return null;
    },
  };
  return session;
}
