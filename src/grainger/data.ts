/**
 * run this script:

npm run tsx src/grainger/data.ts

 */
import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createCookieAgent } from 'http-cookie-agent/http';
import * as dotenv from 'dotenv';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as cheerio from 'cheerio'; // to parse html response

import { proxyUrl } from '@src/utils';

wrapper(axios);
dotenv.config();

const xhrApiKey = process.env.XHR_API_KEY;
if (!xhrApiKey) throw new Error('set XHR_API_KEY in .env file');

const HttpsProxyCookieAgent = createCookieAgent(HttpsProxyAgent);
const jar = new CookieJar();
const httpsProxyCookieAgent = new HttpsProxyCookieAgent(proxyUrl, {
  cookies: { jar },
});

// can make this request or omit it, your choice
await axios.request({
  headers: {
    'x-xhr-api-key': xhrApiKey,
  },
  httpsAgent: httpsProxyCookieAgent,
  url: 'https://www.grainger.com/',
});

const { data: product } = await axios.request({
  headers: {
    accept: 'application/json', // for json response; use `text/html` for html
    'x-xhr-api-key': xhrApiKey,
  },
  httpsAgent: httpsProxyCookieAgent,
  url: 'https://www.grainger.com/product/FEIT-ELECTRIC-Compact-LED-Bulb-Candelabra-56JH27?cpnuser=false&searchBar=true&searchQuery=56JH27&suggestConfigId=6',
});

console.log(product);
// has all clearance cookies, can be saved for future use
console.log((jar.store as unknown as { idx: Record<string, string> }).idx);
