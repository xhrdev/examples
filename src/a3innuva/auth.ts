/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * run this script:

npm run tsx src/clio/auth.ts

 */
import * as qs from 'node:querystring';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createCookieAgent } from 'http-cookie-agent/http';
import * as dotenv from 'dotenv';

import {
  getCsrfCookieFromJar,
  proxyUrl,
  stringifyCookiesFromJar,
} from '@src/utils';

wrapper(axios);
dotenv.config();

const xhrApiKey = process.env.XHR_API_KEY;
if (!xhrApiKey) throw new Error('set XHR_API_KEY in .env file');

const email = process.env.A3INNUVA_EMAIL;
const password = process.env.A3INNUVA_PASSWORD;
const mfaSecret = process.env.A3INNUVA_MFA_SECRET;
if (!email || !password || !mfaSecret)
  throw new Error('set email and password in .env file');

const HttpsProxyCookieAgent = createCookieAgent(HttpsProxyAgent);
const jar = new CookieJar();
const httpsProxyCookieAgent = new HttpsProxyCookieAgent(proxyUrl, {
  cookies: { jar },
});

const { data: signInGet, request: request0 } = await axios.request<string>({
  headers: {
    'x-xhr-api-key': xhrApiKey,
  },
  httpsAgent: httpsProxyCookieAgent,
  method: 'GET',
  url: 'https://a3innuva.wolterskluwer.com/np1/',
});
const redirectUrl0 = request0.path;
if (!redirectUrl0 || !redirectUrl0.startsWith('/auth/core/login?signin='))
  throw new Error('unexpected redirectUrl');

const xsrf = ((html: string): string => {
  const $ = cheerio.load(html);
  const jsonText = $('#modelJson').text();
  if (!jsonText) throw new Error('no modelJson');
  const obj = JSON.parse(jsonText);

  return obj.antiForgery?.value;
})(signInGet);
if (!xsrf) throw new Error('no xsrf');
