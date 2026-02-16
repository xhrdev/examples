/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * run this script:

npm run tsx src/clio/auth.ts

 */
import * as qs from 'node:querystring';
import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createCookieAgent } from 'http-cookie-agent/http';
import * as dotenv from 'dotenv';

import {
  getCsrfCookieFromJar,
  proxyUrl,
  stringifyCookiesFromJar,
  xhrdevCa,
} from '@src/utils';

wrapper(axios);
dotenv.config();

const xhrApiKey = process.env.XHR_API_KEY;
if (!xhrApiKey) throw new Error('set XHR_API_KEY in .env file');

const email = process.env.CLIO_EMAIL;
const password = process.env.CLIO_PASSWORD;
if (!email || !password) throw new Error('set email and password in .env file');

const HttpsProxyCookieAgent = createCookieAgent(HttpsProxyAgent);
const jar = new CookieJar();
const httpsProxyCookieAgent = new HttpsProxyCookieAgent(proxyUrl, {
  cookies: { jar },
});
httpsProxyCookieAgent.options.ca = xhrdevCa;

const { data: loginPageHtml, request: redirectedRequest } =
  await axios.request<string>({
    headers: {
      'x-xhr-api-key': xhrApiKey,
    },
    httpsAgent: httpsProxyCookieAgent,
    method: 'GET',
    url: 'https://app.clio.com/',
  });

const finalUrl = redirectedRequest.res?.responseUrl;
const challengeMatch = finalUrl.match(/[?&]login_challenge=([^&]+)/);
if (!challengeMatch)
  throw new Error('Could not extract login_challenge from URL');
const [, challenge] = challengeMatch;
const authenticityTokenMatch = loginPageHtml.match(
  /name="authenticity_token"[^>]*value="([^"]+)"/
);
if (!authenticityTokenMatch)
  throw new Error('Could not extract authenticity_token from HTML');
const [, authenticityToken] = authenticityTokenMatch;

const { data: passwordPageHtml } = await axios.request<string>({
  data: qs.stringify({
    authenticity_token: authenticityToken,
    challenge,
    email,
  }),
  headers: {
    Referer: finalUrl,
    'x-xhr-api-key': xhrApiKey,
  },
  httpsAgent: httpsProxyCookieAgent,
  method: 'POST',
  url: `https://account.clio.com/ask_for_password?challenge=${challenge}`,
});

const newAuthenticityTokenMatch = passwordPageHtml.match(
  /name="authenticity_token"[^>]*value="([^"]+)"/
);
if (!newAuthenticityTokenMatch)
  throw new Error('Could not extract authenticity_token from password page');
const [, newAuthenticityToken] = newAuthenticityTokenMatch;

const { request, status } = await axios.request<string>({
  data: qs.stringify({
    authenticity_token: newAuthenticityToken,
    challenge,
    email,
    password,
  }),
  headers: {
    Referer: `https://account.clio.com/ask_for_password?challenge=${challenge}`,
    'x-xhr-api-key': xhrApiKey,
  },
  httpsAgent: httpsProxyCookieAgent,
  method: 'POST',
  url: 'https://account.clio.com/login',
  validateStatus: (status: number) => status < 500,
});
const redirectUrl = request.path;

console.log({ jar, redirectUrl, status });
