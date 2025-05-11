/**
 * run this script:

npm run tsx src/amazon/data.ts

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

const xhrApiKey = process.env.XHR_API_KEY;
if (!xhrApiKey) throw new Error('set XHR_API_KEY in .env file');

const HttpsProxyCookieAgent = createCookieAgent(HttpsProxyAgent);
const jar = new CookieJar();
const httpsProxyCookieAgent = new HttpsProxyCookieAgent(proxyUrl, {
  cookies: { jar },
});

// note: must be signed into amazon
//  - no cookies sent -> captcha challenge (xhrdev to add the auto bypass) (we have it)
//   - not signed in: no reviews
//   - signed in: success
const amazonCookie = process.env.AMAZON_COOKIE;
if (!amazonCookie) throw new Error('set AMAZON_COOKIE in .env file');

type Review = {
  author: string;
  country: string;
  date: string;
  id: string;
  rating: string;
  title: string;
};
const parseReviews = (html: string): Review[] => {
  const selector = '#cm-cr-dp-review-list li';
  const $ = cheerio.load(html);
  const reviews = $(selector)
    .toArray()
    .map((li) => {
      const el = $(li);

      let country = '';
      let date = '';
      const match = el
        .find('span[data-hook="review-date"]')
        .text()
        .match(/^Reviewed in the (.+?) on (.+)$/);
      if (match) {
        country = match[1];
        date = match[2];
      }

      return {
        author: el
          .find('div.a-profile-content span.a-profile-name')
          .first()
          .text(),
        country,
        date,
        id: el.attr('id'),
        rating: el.find('i[data-hook="review-star-rating"]').text().slice(0, 3),
        text: el
          .find(
            'span[data-hook="review-body"] div[data-hook="review-collapsed"] span'
          )
          .text(),
        title: el.find('a[data-hook="review-title"] span:nth-child(3)').text(),
      };
    });

  return reviews;
  /* =>
{
  reviews: [
    {
      author: 'Desiree Bohorques',
      country: 'United States',
      date: 'April 4, 2025',
      id: 'R3G7ULRDV9DA6O',
      rating: '5.0',
      text: 'I recently purchased this life jacket for my dog, and it’s absolutely perfect! The size fits her just right when I followed the sizing chart, which made the whole process a breeze. It’s easy to put on and take off, thanks to the simple straps and secure buckles. The material is durable, and it keeps my dog comfortable and safe in the water. I highly recommend this life jacket for any dog owner looking for a reliable and well-fitting option!',
      title: 'Great fit'
    },
    {
      author: 'Amazon Customer',
      country: 'United States',
      date: 'May 5, 2025',
      id: 'R22C3TG7XOIGZQ',
      rating: '5.0',
      text: "Fits both my dogs perfectly...can't wait until memorial weekend and we can open the pool!!!",
      title: 'Great quality, easy to put on!'
    },
  ]
}
*/
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const initialReviews = async (): Promise<string> => {
  const { data: html } = await axios.request({
    headers: {
      cookie: amazonCookie,
      'x-xhr-api-key': xhrApiKey,
      'x-xhr-managed-proxy': true.toString(),
    },
    httpsAgent: httpsProxyCookieAgent,
    url: 'https://www.amazon.com/gp/aw/d/B0BRZXRBZL/',
  });
  return html;
};

const reviewsPage = async (): Promise<string> => {
  const { data: html } = await axios.request({
    headers: {
      cookie: amazonCookie,
      'x-xhr-api-key': xhrApiKey,
      'x-xhr-managed-proxy': true.toString(),
    },
    httpsAgent: httpsProxyCookieAgent,
    url: 'https://www.amazon.com/product-reviews/B0BRZXRBZL/',
  });
  return html;
};

const main = async () => {
  const reviewsHtml = await reviewsPage();

  const reviews = parseReviews(reviewsHtml);
  console.log(reviews);
};

await main();
