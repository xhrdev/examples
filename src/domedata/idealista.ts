/**
 * Run with:
 *
 * node --env-file=.env src/domedata/grainger.ts
 * node --env-file=.env src/domedata/grainger.ts --headless
 */
import { randomInt } from 'node:crypto';
import fs from 'node:fs';

import { chromium, type LaunchOptions } from 'playwright-core';

import { solveDataDome } from '#src/domedata/solver.js';

const url = 'https://www.idealista.com/';
const solverHost = process.env['host'];
const configuredProxy = process.env['proxy'];
const chromePath = process.env['CHROME_PATH'] || '';
const browserHoldMs = Number(process.env['BROWSER_HOLD_MS'] ?? 30_000);

if (!solverHost) throw new Error('set host= in .env');
if (!configuredProxy) throw new Error('set proxy= in .env');
if (!Number.isSafeInteger(browserHoldMs) || browserHoldMs < 0) {
  throw new Error('BROWSER_HOLD_MS must be a non-negative integer');
}

const solverUrl = `http://${solverHost}:3000`;
const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

const parseProxy = (raw: string) => {
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const parsed = new URL(hasScheme ? raw : `http://${raw}`);
  const password = decodeURIComponent(parsed.password || '');
  const server = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  const username = decodeURIComponent(parsed.username || '');
  return {
    ...(password ? { password } : {}),
    server,
    ...(username ? { username } : {}),
  };
};

const sessionProxy = (raw: string): string => {
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const parsed = new URL(hasScheme ? raw : `http://${raw}`);
  const password = decodeURIComponent(parsed.password || '');
  const isRayobyte = /(^|\.)rayobyte\.com$/i.test(parsed.hostname);
  if (isRayobyte && password && !/-hardsession-\d+$/.test(password)) {
    parsed.password = `${password}-hardsession-${randomInt(100_000, 1_000_000_000)}`;
  }
  return parsed.href;
};

const proxy = sessionProxy(configuredProxy);

const launchOptions: LaunchOptions = {
  args: [
    '--window-size=1200,904',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
  ],
  headless: process.argv.includes('--headless'),
  ignoreDefaultArgs: ['--enable-automation', '--force-color-profile=srgb'],
  proxy: parseProxy(proxy),
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
  if (closing || !browser.isConnected() || browserHoldMs === 0) return;
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
  const result = await solveDataDome(page, {
    proxy,
    solverUrl,
    url,
  });

  log(
    `RESULT: SUCCESS - DataDome returned HTTP ${result.responseStatus}; product returned HTTP ${productResponse.status()}`
  );
} catch (error) {
  process.exitCode = 1;
  log(`RESULT: FAIL - ${(error as Error).message}`);
} finally {
  await holdBrowser();
  await cleanup();
}
