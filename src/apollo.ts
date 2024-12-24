/**
 * run this script like:
XHR_API_KEY=xxx npm run tsx src/apollo.ts
 */
import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createCookieAgent } from 'http-cookie-agent/http';

import { getCsrfCookieFromJar } from '@src/utils';

wrapper(axios);

const HttpsProxyCookieAgent = createCookieAgent(HttpsProxyAgent);
const proxyUrl = 'https://proxy.prod.engineering.xhr.dev';
const jar = new CookieJar();

const httpsProxyCookieAgent = new HttpsProxyCookieAgent(proxyUrl, {
  cookies: { jar },
});

await axios.request({
  headers: {
    'x-xhr-api-key': process.env.XHR_API_KEY,
  },
  httpsAgent: httpsProxyCookieAgent,
  url: 'https://app.apollo.io/',
});

if (!jar.serializeSync()?.cookies.length) throw new Error('no cooks');

const { data: result } = await axios.request({
  headers: {
    accept: '*/*',
    'content-type': 'application/json',
    'x-xhr-api-key': process.env.XHR_API_KEY,
  },
  httpsAgent: httpsProxyCookieAgent,
  url: `https://app.apollo.io/api/v1/auth/check?timezone_offset=480&current_finder_view_id=&cacheKey=${Date.now()}`,
});

const csrf = getCsrfCookieFromJar({ cookieName: 'X-CSRF-TOKEN', jar })?.value;

console.log({ csrf });
