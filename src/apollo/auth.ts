/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * run this script:

npm run tsx src/apollo/auth.ts

 */
import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createCookieAgent } from 'http-cookie-agent/http';
import * as dotenv from 'dotenv';

import {
  getCsrfCookieFromJar,
  proxyUrl,
  xhrdevCa,
  stringifyCookiesFromJar,
} from '@src/utils';

wrapper(axios);
dotenv.config();

const xhrApiKey = process.env.XHR_API_KEY;
if (!xhrApiKey) throw new Error('set XHR_API_KEY in .env file');

const email = process.env.APOLLO_EMAIL;
const password = process.env.APOLLO_PASSWORD;
if (!email || !password) throw new Error('set email and password in .env file');

const HttpsProxyCookieAgent = createCookieAgent(HttpsProxyAgent);
const jar = new CookieJar();
httpsProxyCookieAgent.options.ca = xhrdevCa;

const cacheKey = Date.now();
const timezoneOffset = 480;

await axios.request({
  headers: {
    'x-xhr-api-key': xhrApiKey,
  },
  httpsAgent: httpsProxyCookieAgent,
  url: 'https://app.apollo.io/',
});

if (!jar.serializeSync()?.cookies.length) throw new Error('no cookies');

await axios.request({
  headers: {
    accept: '*/*',
    'content-type': 'application/json',
    'x-xhr-api-key': xhrApiKey,
  },
  httpsAgent: httpsProxyCookieAgent,
  url: `https://app.apollo.io/api/v1/auth/check?timezone_offset=${timezoneOffset}&current_finder_view_id=&cacheKey=${cacheKey}`,
});

const csrf = getCsrfCookieFromJar({ cookieName: 'X-CSRF-TOKEN', jar })?.value;
if (!csrf) throw new Error('no csrf');

const { data: result } = await axios.request({
  data: JSON.stringify({
    cacheKey,
    email,
    password,
    timezone_offset: timezoneOffset,
  }),
  headers: {
    'content-type': 'application/json',
    'x-csrf-token': csrf,
    'x-xhr-api-key': xhrApiKey,
  },
  httpsAgent: httpsProxyCookieAgent,
  method: 'POST',
  url: 'https://app.apollo.io/api/v1/auth/login',
});

console.log({ cookies: stringifyCookiesFromJar({ jar }), csrf });
