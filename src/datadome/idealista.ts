/**
 * Run with:
 *
 * node --env-file=.env src/datadome/idealista.ts
 * node --env-file=.env src/datadome/idealista.ts --headless
 */
import fs from 'node:fs';

import { chromium, type LaunchOptions } from 'playwright-core';

import { pinSession, toLaunchProxy } from '#src/proxy.js';
import { solve } from '#src/datadome/solver.js';

const url = 'https://www.idealista.com/';
const solverHost = process.env['host'];
const configuredProxy = process.env['proxy'];
const solverApiKey = process.env['solver_api_key'];
const chromePath = process.env['CHROME_PATH'] || '';
// How long the browser stays open after a run, to inspect what it landed on.
const browserHoldMs = 30_000;

if (!solverHost) throw new Error('set host= in .env');
if (!configuredProxy) throw new Error('set proxy= in .env');

const solverUrl = `http://${solverHost}:3000`;
const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

const { url: proxy } = pinSession(configuredProxy);

const launchOptions: LaunchOptions = {
  args: [
    '--window-size=1200,904',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
  ],
  headless: process.argv.includes('--headless'),
  ignoreDefaultArgs: ['--enable-automation', '--force-color-profile=srgb'],
  proxy: toLaunchProxy(proxy),
};

// eslint-disable-next-line security/detect-non-literal-fs-filename
if (chromePath && fs.existsSync(chromePath)) {
  launchOptions.executablePath = chromePath;
} else {
  launchOptions.channel = 'chrome';
}

const browser = await chromium.launch(launchOptions);
let closing = false;

const cleanup = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await browser.close().catch(() => undefined);
};

const holdBrowser = async (): Promise<void> => {
  if (closing || !browser.isConnected()) return;
  log(`Keeping browser open for ${browserHoldMs}ms (Ctrl+C to close now)`);
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      browser.off('disconnected', done);
      resolve();
    };
    const timer = setTimeout(done, browserHoldMs);
    browser.once('disconnected', done);
    if (!browser.isConnected()) done();
  });
};

process.once('SIGINT', () => {
  log('Caught SIGINT');
  void cleanup();
});
process.once('SIGTERM', () => {
  log('Caught SIGTERM');
  void cleanup();
});

try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    timezoneId: 'America/New_York',
    // Do not set locale here. Chromium's native Accept-Language ordering is
    // part of the DataDome request identity.
    viewport: null,
  });
  const page = await context.newPage();
  const result = await solve(page, {
    proxy,
    ...(solverApiKey ? { solverApiKey } : {}),
    solverUrl,
    url,
  });

  log(`RESULT: SUCCESS - DataDome returned HTTP ${result.responseStatus}`);
} catch (error) {
  process.exitCode = 1;
  log(`RESULT: FAIL - ${(error as Error).message}`);
} finally {
  await holdBrowser();
  await cleanup();
}
