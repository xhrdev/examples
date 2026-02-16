/**
 * run this script:

npm run tsx src/substack/articles.ts

 */
/// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as fs from 'node:fs';
import { stringify } from 'node:querystring';
import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createCookieAgent } from 'http-cookie-agent/http';
import * as dotenv from 'dotenv';
import * as cheerio from 'cheerio';

import { proxyUrl, xhrdevCa } from '@src/utils';

wrapper(axios);
dotenv.config();

const xhrApiKey = process.env.XHR_API_KEY;
if (!xhrApiKey) throw new Error('set XHR_API_KEY in .env file');

const HttpsProxyCookieAgent = createCookieAgent(HttpsProxyAgent);
const jar = new CookieJar();
const httpsProxyCookieAgent = new HttpsProxyCookieAgent(proxyUrl, {
  cookies: { jar },
});
httpsProxyCookieAgent.options.ca = xhrdevCa;

/* =>
{
  articles: [
    {
      author: 'Desiree Bohorques',
      country: 'United States',
      date: 'April 4, 2025',
      id: 'R3G7ULRDV9DA6O',
      rating: '5.0',
      text: 'I recently purchased this life jacket for my dog, and it’s absolutely perfect! The size fits her just right when I followed the sizing chart, which made the whole process a breeze. It’s easy to put on and take off, thanks to the simple straps and secure buckles. The material is durable, and it keeps my dog comfortable and safe in the water. I highly recommend this life jacket for any dog owner looking for a reliable and well-fitting option!',
      title: 'Great fit'
    },
  ]
}
*/

const main = async () => {
  const { data: html } = await axios.request({
    headers: {
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'accept-language': 'en-GB,en;q=0.9',
      'x-xhr-api-key': xhrApiKey,
    },
    httpsAgent: httpsProxyCookieAgent,
    method: 'GET',
    url: 'https://edoriordan.substack.com/p/the-week-in-irish-startups-6b6',
  });

  const $ = cheerio.load(html);

  let dataHtml!: null | string;

  $('script').each((_, element) => {
    const scriptContent = $(element).html();
    if (
      scriptContent &&
      /window\._preloads\s*=\s*JSON\.parse/.test(scriptContent)
    ) {
      dataHtml = scriptContent;
      return false; // stops the .each() loop since we found our match
    }

    return true; // continues to next loop
  });

  const dataMatch = dataHtml ? dataHtml.match(/JSON\.parse\("(.+?)"\)/) : null;

  let data = null;
  if (dataMatch && dataMatch.length) {
    const [, dataStr] = dataMatch;
    data = JSON.parse(dataStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\')); // unescape it
  }

  console.log({ data });

  return;
};

await main();
