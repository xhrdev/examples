/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * run this script:

npm run tsx src/apollo/data.ts

 */
import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createCookieAgent } from 'http-cookie-agent/http';
import * as dotenv from 'dotenv';

import { createJar, proxyUrl, xhrdevCa } from '@src/utils';

wrapper(axios);
dotenv.config();

const xhrApiKey = process.env.XHR_API_KEY;
if (!xhrApiKey) throw new Error('set XHR_API_KEY in .env file');

// paste from @src/apollo/auth script ====================== >
const cookies = 'paste in from @src/apollo/auth script';
const csrf = 'paste in from @src/apollo/auth script';
// end paste <==============================================

if (!csrf || !cookies)
  throw new Error('run auth script and set/paste appropriate var');

const jar = createJar({ cookies: JSON.parse(cookies) });

const HttpsProxyCookieAgent = createCookieAgent(HttpsProxyAgent);
httpsProxyCookieAgent.options.ca = xhrdevCa;

const cacheKey = Date.now();

const { data: searchResults } = await axios.request({
  data: JSON.stringify({
    cacheKey,
    num_fetch_result: 29,
    query: 'founders',
  }),
  headers: {
    'content-type': 'application/json',
    'x-csrf-token': csrf,
    'x-xhr-api-key': xhrApiKey,
  },
  httpsAgent: httpsProxyCookieAgent,
  method: 'POST',
  url: 'https://app.apollo.io/api/v1/omnisearch/search',
});

console.log({
  contacts: searchResults.contacts,
  oranizations: searchResults.organizations,
  people: searchResults.people,
  searchResults,
});
