/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * run this script:

npm run tsx src/download-image.ts

 */
import fs from 'node:fs';
import assert from 'node:assert';
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

const HttpsProxyCookieAgent = createCookieAgent(HttpsProxyAgent);
const jar = new CookieJar();
const httpsProxyCookieAgent = new HttpsProxyCookieAgent(proxyUrl, {
  cookies: { jar },
});
httpsProxyCookieAgent.options.ca = xhrdevCa;

const gif = (
  await axios.request({
    headers: {
      'x-xhr-api-key': xhrApiKey,
    },
    httpsAgent: httpsProxyCookieAgent,
    responseType: 'arraybuffer',
    url: 'https://news.ycombinator.com/s.gif',
  })
).data;

const expected = Buffer.from([
  /* eslint-disable prettier/prettier */
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00,  // GIF89a..
  0x01, 0x00, 0x80, 0xff, 0x00, 0xc0, 0xc0, 0xc0,  // ........
  0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00,  // ...!....
  0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,  // ...,....
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44,  // .......D
  0x01, 0x00, 0x3b                                 // ..;
  /* eslint-enable prettier/prettier */
]);

assert.deepStrictEqual(gif, expected);

console.log(
  "image loaded in `gif`, use `fs.writeFileSync('image.gif')` to save it"
);
