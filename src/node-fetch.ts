/**
 * Run this script:

npm run tsx src/node-fetch.ts

 */
import fetch from 'node-fetch';
import { CookieJar } from 'tough-cookie';
import { default as fetchCookie } from 'fetch-cookie';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as dotenv from 'dotenv';

import { proxyUrl, xhrdevCa } from '@src/utils';

dotenv.config();

const xhrApiKey = process.env.XHR_API_KEY;
if (!xhrApiKey) throw new Error('Set XHR_API_KEY in .env file');

// Create Cookie Jar and Fetch with Cookies
const jar = new CookieJar();
const fetchWithCookies = fetchCookie(fetch, jar);
const agent = new HttpsProxyAgent(proxyUrl);
agent.options.ca = xhrdevCa;

// First Request
const response = await fetchWithCookies('https://core.cro.ie', {
  agent,
  headers: {
    'x-xhr-api-key': xhrApiKey,
  },
});

if (!response.ok)
  throw new Error(`Request failed with status ${response.status}`);
if (!jar.serializeSync()?.cookies.length) throw new Error('No cookies');

console.log({
  cookies: jar.serializeSync()?.cookies,
  response: await response.text(),
});
