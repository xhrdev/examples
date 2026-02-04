/**
 * run this script:

npm run tsx src/mr007.ts

 */
import * as fs from 'node:fs';
import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { chromium } from 'playwright';

wrapper(axios);

type Mr077Response = {
  cookie_string: string;
  cookies_dict: { [key: string]: string };
  cookies_list: {
    domain: string;
    name: string;
    value: string;
  }[];
  datadome_value: null | string;
  domain: string;
  error: null | string;
  message: string;
  status: number;
  title: string;
};
type Site = 'costco' | 'grainger' | 'instacart' | 'walmart';

const url = 'https://www.walmart.com/';
const jar = new CookieJar();

const mr007 = async ({
  site,
}: {
  site: Site;
}): Promise<Mr077Response['cookies_list']> => {
  const url = ((site: Site) => {
    switch (site) {
      case 'costco':
        return 'https://operantly-showiest-kittie.ngrok-free.dev/get-cookies?x_api_key=9KWUP2TUOO26TSW6P9A3&domain=https://www.costco.com/';
      case 'grainger':
        return 'https://operantly-showiest-kittie.ngrok-free.dev/get-datadome-grainger?x_api_key=9KWUP2TUOO26TSW6P9A3';
      case 'instacart':
        return 'https://operantly-showiest-kittie.ngrok-free.dev/get-cookies?x_api_key=9KWUP2TUOO26TSW6P9A3&domain=https://www.instacart.com';
      case 'walmart':
        return 'https://operantly-showiest-kittie.ngrok-free.dev/get-cookies?x_api_key=9KWUP2TUOO26TSW6P9A3&domain=https://www.walmart.com';
      default:
        throw new Error('unknown site');
    }
  })(site);

  const {
    data: { cookies_list: cookieList },
  } = await axios.request<Mr077Response>({
    headers: {
      'ngrok-skip-browser-warning': 'skip',
    },
    url,
  });

  return cookieList;
};

console.log('--- mr007 ---');
const site = new URL(url).hostname.split('.')[1] as Site;
const cookies = await mr007({ site });
if (cookies.length === 0) throw new Error('no cookies');
console.log({ cookies: cookies.slice(0, 2) });

cookies.forEach((c) => {
  const domainPart = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
  jar.setCookieSync(`${c.name}=${c.value}`, `https://${domainPart}/`);
});
// console.log({ jar: (jar.store as any).idx });
const playwrightCookies = cookies.map((c) => ({
  domain: c.domain,
  name: c.name,
  path: '/',
  sameSite: 'None' as const,
  secure: true,
  value: c.value,
}));

console.log('--- axios ---');
const { data, status } = await axios.request({
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
  jar,
  url,
});
console.log({ data, status });
fs.writeFileSync('./site-axios.html', data);

console.log('--- playwright ---');
const browser = await chromium.launch({
  args: ['--disable-blink-features=AutomationControlled'],
  devtools: !process.env.CI,
  headless: !!process.env.CI,
});
const context = await browser.newContext();
await context.addCookies(playwrightCookies);
const page = await context.newPage();

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const title = await page.title();
  const data0 = await page.content();
  console.log({ title });
  fs.writeFileSync('./site-playwright.html', data0);
  await new Promise((res) => setTimeout(res, 10000));
} catch (err) {
  console.error({ err });
} finally {
  await browser.close();
}
