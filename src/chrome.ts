/**
 * How every browser example here launches Chrome.
 *
 * The flags are not incidental — dropping
 * `--disable-blink-features=AutomationControlled` changes what both vendors
 * see — so they live in one place where a fix reaches every runner rather
 * than the one you remembered to edit.
 */
import fs from 'node:fs';

import type { LaunchOptions } from 'playwright-core';

import { toLaunchProxy } from '#src/proxy.js';

/**
 * Launch options for a real Chrome: `CHROME_PATH` when it points at a binary,
 * the installed Chrome channel otherwise, headless only with `--headless`.
 */
export const chromeLaunchOptions = ({
  args = [],
  proxy,
}: {
  args?: readonly string[];
  /** Undefined goes out from this machine's own address. */
  proxy?: string | undefined;
} = {}): LaunchOptions => {
  const chromePath = process.env['CHROME_PATH'] || '';
  return {
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      ...args,
    ],
    headless: process.argv.includes('--headless'),
    ...(proxy ? { proxy: toLaunchProxy(proxy) } : {}),
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    ...(chromePath && fs.existsSync(chromePath)
      ? { executablePath: chromePath }
      : { channel: 'chrome' }),
  };
};
