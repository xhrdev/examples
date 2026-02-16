/**
 * run this script:

NODE_EXTRA_CA_CERTS=./xhrdev.pem npx tsx src/playwright.ts

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

const url = 'https://supplierconnect.maersk.com/';

const browser = await chromium.launch({
  args: ['--disable-blink-features=AutomationControlled'],
  devtools: !process.env.CI,
  headless: !!process.env.CI,
});

const context = await browser.newContext({
  extraHTTPHeaders: {
    'x-xhr-api-key': xhrApiKey,
  },
  ignoreHTTPSErrors: false,
  proxy: {
    server: proxyUrl,
  },
  viewport: null,
});

const page = await context.newPage();
// await page.setViewportSize({ height: 1080, width: 1920 }); // to set a particular page size
await page.route('**/*', blockClientScripts);

try {
  await sleep(3000); // to enable "preserve log" in devtools network tab
  await page.goto(url, pageGotoOptions);

  const title = await page.title();
  const content = await page.content();

  console.log({ content, title });

  await sleep(30000);
} finally {
  await page.waitForTimeout(timeout);
  await browser.close();
}
