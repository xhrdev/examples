/**
 * run this script:

npx tsx src/playwright.ts

*/
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import * as dotenv from 'dotenv';

import { blockClientScripts, proxyUrl, sleep } from '@src/utils';

dotenv.config();

type PageGotoOptions = Parameters<Page['goto']>[1];

const xhrApiKey = process.env.XHR_API_KEY;
if (!xhrApiKey) throw new Error('set XHR_API_KEY in .env file');

const timeout = 30 * 1000;
const pageGotoOptions: PageGotoOptions = {
  timeout,
  waitUntil: 'domcontentloaded',
};

const url =
  'https://www.grainger.com/product/FEIT-ELECTRIC-Compact-LED-Bulb-Candelabra-56JH27?cpnuser=false&searchBar=true&searchQuery=56JH27&suggestConfigId=6';

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
  viewport: null,
});

const page = await context.newPage();
// await page.setViewportSize({ height: 1080, width: 1920 }); // to set a particular page size

try {
  await page.goto(url, pageGotoOptions);

  const title = await page.title();
  const content = await page.content();

  console.log({ content, title });
} finally {
  await page.waitForTimeout(timeout);
  await browser.close();
}
