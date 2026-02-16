/**
 * Run this script:

npx tsx src/puppeteer.ts

*/
import puppeteer from 'puppeteer';
import type { Page } from 'puppeteer';
import * as dotenv from 'dotenv';

dotenv.config();

// Usage

type PageGotoOptions = Parameters<Page['goto']>[1];

const proxyUrl = 'https://magic.xhr.dev';
const xhrApiKey = process.env.XHR_API_KEY;
if (!xhrApiKey) throw new Error('set XHR_API_KEY in .env file');

const timeout = 10 * 1000;
const pageGotoOptions: PageGotoOptions = {
  timeout,
  waitUntil: 'domcontentloaded',
};

const url = 'https://news.ycombinator.com';

const browser = await puppeteer.launch({
  acceptInsecureCerts: true,
  args: [`--proxy-server=${proxyUrl}`],
  devtools: !process.env.CI,
  headless: !!process.env.CI,
});

const page = await browser.newPage();

// Set extra HTTP headers
await page.setExtraHTTPHeaders({
  'x-xhr-api-key': xhrApiKey,
});

try {
  await page.goto(url, pageGotoOptions);

  const title = await page.title();
  const content = await page.content();

  console.log({ content, title });
} finally {
  const delay = (time: number) =>
    new Promise((resolve) => setTimeout(resolve, time));
  await delay(timeout);
  await browser.close();
}
