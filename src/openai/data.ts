/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * run this script:

npm run tsx src/openai/data.ts

 */
import * as fs from 'node:fs';
import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createCookieAgent } from 'http-cookie-agent/http';
import * as dotenv from 'dotenv';
import * as cheerio from 'cheerio';

import { proxyUrl } from '@src/utils';

wrapper(axios);
dotenv.config();

const HttpsProxyCookieAgent = createCookieAgent(HttpsProxyAgent);
const jar = new CookieJar();
const httpsProxyCookieAgent = new HttpsProxyCookieAgent(proxyUrl, {
  cookies: { jar },
});
const xhrApiKey = process.env.XHR_API_KEY;
if (!xhrApiKey) throw new Error('set XHR_API_KEY in .env file');

const { data: result } = await axios.request({
  headers: {
    'x-xhr-api-key': xhrApiKey,
  },
  httpsAgent: httpsProxyCookieAgent,
  url: 'https://chatgpt.com/share/67edd1d8-8e8c-800a-b41e-fc08a4332b24',
});
/*
fs.writeFileSync('./openai.html', result);
*/

/*
const result = fs.readFileSync('./openai.html', 'utf-8');
*/
const $ = cheerio.load(result);
const s = $('script').eq(5).html();
if (!s) throw new Error('no script');
const match = s.match(/enqueue\((["'`])(.+?)\1\)/s);
if (!match) throw new Error('JSON string not found');
let jsonString = match[2];
jsonString = jsonString.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
const lastBracket = Math.max(
  jsonString.lastIndexOf(']'),
  jsonString.lastIndexOf('}')
);
jsonString = jsonString.slice(0, lastBracket + 1);
const data = <(Record<string, unknown> | string)[]>JSON.parse(jsonString);
/*
fs.writeFileSync('./openai.json', JSON.stringify(data, null, 2));
const data = <(Record<string, unknown> | string)[]>(
  JSON.parse(fs.readFileSync('./openai.json', 'utf-8'))
);
*/
const content = data.find(
  (_) =>
    typeof _ === 'string' &&
    _.startsWith('Below is a concise example of a simple')
);

console.log(content);
