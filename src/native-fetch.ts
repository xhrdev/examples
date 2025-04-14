/**
 * Run this script:

npm run tsx src/native-fetch.ts

 */
import * as dotenv from 'dotenv';
import { fetch, ProxyAgent } from 'undici';

import { proxyUrl } from '@src/utils';

dotenv.config();

const xhrApiKey = process.env.XHR_API_KEY;
if (!xhrApiKey) throw new Error('Set XHR_API_KEY in .env file');

const response = await fetch('https://core.cro.ie', {
  dispatcher: new ProxyAgent(proxyUrl),
  headers: {
    'x-xhr-api-key': xhrApiKey,
  },
  redirect: 'follow',
});

if (!response.ok)
  throw new Error(`Request failed with status ${response.status}`);
const setCookies: string[] = [];
response.headers.forEach((value, key) => {
  if (key.toLowerCase() === 'set-cookie') setCookies.push(value);
});

console.log({
  cookies: setCookies,
  response: await response.text(),
});
