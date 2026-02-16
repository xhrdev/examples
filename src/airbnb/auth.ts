/**
 * run this script:

npm run tsx src/airbnb/auth.ts

 */
import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createCookieAgent } from 'http-cookie-agent/http';
import * as dotenv from 'dotenv';

import { proxyUrl, xhrdevCa } from '@src/utils';

wrapper(axios);
dotenv.config();

const xhrApiKey = process.env.XHR_API_KEY;
if (!xhrApiKey) throw new Error('set XHR_API_KEY in .env file');

const email = process.env.AIRBNB_EMAIL;
const password = process.env.AIRBNB_PASSWORD;
console.log({ email, password });
if (!email || !password) throw new Error('set email and password in .env file');

const HttpsProxyCookieAgent = createCookieAgent(HttpsProxyAgent);
const jar = new CookieJar();
httpsProxyCookieAgent.options.ca = xhrdevCa;

await axios.request({
  headers: {
    'x-xhr-api-key': xhrApiKey,
  },
  httpsAgent: httpsProxyCookieAgent,
  url: 'https://www.airbnb.com/login',
});

if (!jar.serializeSync()?.cookies.length) throw new Error('no cookies');
