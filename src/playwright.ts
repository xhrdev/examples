/**
 * run this script:

npx tsx src/playwright.ts

*/
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import * as dotenv from 'dotenv';

import { proxyUrl } from '@src/utils';

dotenv.config();

type PageGotoOptions = Parameters<Page['goto']>[1];

const xhrApiKey = process.env.XHR_API_KEY;
if (!xhrApiKey) throw new Error('set XHR_API_KEY in .env file');

const timeout = 30 * 1000;
const pageGotoOptions: PageGotoOptions = {
  timeout,
  waitUntil: 'domcontentloaded',
};

const url = 'https://www.grainger.com/';

const browser = await chromium.launch({
  devtools: !process.env.CI,
  headless: !!process.env.CI,
});

const context = await browser.newContext({
  extraHTTPHeaders: {
    'x-xhr-api-key': xhrApiKey,
  },
  ignoreHTTPSErrors: true,
  proxy: {
    server: proxyUrl,
  },
});
const page = await context.newPage();

try {
  await page.goto(url, pageGotoOptions);

  const title = await page.title();
  const content = await page.content();

  console.log({ content, title });
} finally {
  await page.waitForTimeout(timeout);
  await browser.close();
}
