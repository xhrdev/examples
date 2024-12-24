/** run this script like:
XHR_API_KEY=xxx npm run tsx src/apollo.ts
 */
import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createCookieAgent } from 'http-cookie-agent/http';
import * as dotenv from 'dotenv';

import { getCsrfCookieFromJar } from '@src/utils';

wrapper(axios);
dotenv.config();

const email = process.env.email;
const password = process.env.password;

const HttpsProxyCookieAgent = createCookieAgent(HttpsProxyAgent);
const proxyUrl = 'https://proxy.prod.engineering.xhr.dev';
const jar = new CookieJar();

const httpsProxyCookieAgent = new HttpsProxyCookieAgent(proxyUrl, {
  cookies: { jar },
});

const cacheKey = Date.now();
const timezoneOffset = 480;

await axios.request({
  headers: {
    'x-xhr-api-key': process.env.XHR_API_KEY,
  },
  httpsAgent: httpsProxyCookieAgent,
  url: 'https://app.apollo.io/',
});

if (!jar.serializeSync()?.cookies.length) throw new Error('no cooks');

await axios.request({
  headers: {
    accept: '*/*',
    'content-type': 'application/json',
    'x-xhr-api-key': process.env.XHR_API_KEY,
  },
  httpsAgent: httpsProxyCookieAgent,
  url: `https://app.apollo.io/api/v1/auth/check?timezone_offset=${timezoneOffset}&current_finder_view_id=&cacheKey=${cacheKey}`,
});

const csrf = getCsrfCookieFromJar({ cookieName: 'X-CSRF-TOKEN', jar })?.value;

const { data: result } = await axios.request({
  data: JSON.stringify({
    cacheKey,
    email,
    password,
    timezone_offset: timezoneOffset,
  }),
  headers: {
    'content-type': 'application/json',
    'X-Csrf-Token': csrf,
    'x-xhr-api-key': process.env.XHR_API_KEY,
  },
  httpsAgent: httpsProxyCookieAgent,
  method: 'POST',
  url: 'https://app.apollo.io/api/v1/auth/login',
});

console.log({ result });
