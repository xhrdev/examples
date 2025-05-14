/**
 * run this script:

npm run tsx src/amazon/data.ts

 */
import * as fs from 'node:fs';
import { stringify } from 'node:querystring';
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
const amazonCsrf = process.env.AMAZON_CSRF;
if (!amazonCsrf) throw new Error('set AMAZON_COOKIE in .env file');

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

      /* eslint-disable @typescript-eslint/no-non-null-assertion */
      return {
        author: el
          .find('div.a-profile-content span.a-profile-name')
          .first()
          .text(),
        country,
        date,
        id: el.attr('id')!,
        rating: el.find('i[data-hook="review-star-rating"]').text().slice(0, 3),
        text: el
          .find(
            'span[data-hook="review-body"] div[data-hook="review-collapsed"] span'
          )
          .text(),
        title: el.find('a[data-hook="review-title"] span:nth-child(3)').text(),
      };
      /* eslint-enable @typescript-eslint/no-non-null-assertion */
    });

  return reviews;
};
const parseReviews0 = (html: string): Review[] => {
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

      /* eslint-disable @typescript-eslint/no-non-null-assertion */
      return {
        author: el
          .find('div.a-profile-content span.a-profile-name')
          .first()
          .text(),
        country,
        date,
        id: el.attr('id')!,
        rating: el
          .find('i[data-hook="review-star-rating"] span')
          .text()
          .slice(0, 3),
        text: el.find('span[data-hook="review-body"] span').text().trim(),
        title: el.find('a[data-hook="review-title"] span:nth-child(3)').text(),
      };
      /* eslint-enable @typescript-eslint/no-non-null-assertion */
    });

  return reviews;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const productReviews = async (): Promise<string> => {
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

/*
 no query params:
  - https://www.amazon.com/product-reviews/B0BRZXRBZL/

https://www.amazon.com/product-reviews/B07RCZL2F3/ref=cm_cr_arp_d_paging_btm_next_2?pageNumber=2&sortBy=recent
 */
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

const reviewsAjax = async ({
  pageNum,
}: {
  pageNum: number;
}): Promise<string> => {
  const { data: amazonjsonui } = await axios.request<string>({
    data: stringify({
      asin: 'B07RCZL2F3',
      canShowIntHeader: 'undefined',
      deviceType: 'desktop',
      filterByAge: '',
      filterByKeyword: '',
      filterByLanguage: '',
      filterByStar: '',
      formatType: '',
      mediaType: '',
      pageNumber: pageNum.toString(),
      pageSize: '10',
      reftag: `cm_cr_getr_d_paging_btm_next_${pageNum}`,
      reviewerType: '',
      scope: 'reviewsAjax3',
      shouldAppend: 'undefined',
      sortBy: 'recent',
    }),
    headers: {
      'anti-csrftoken-a2z': amazonCsrf,
      cookie: amazonCookie,
      'x-xhr-api-key': xhrApiKey,
      'x-xhr-managed-proxy': true.toString(),
    },
    httpsAgent: httpsProxyCookieAgent,
    method: 'POST',
    url: `https://www.amazon.com/hz/reviews-render/ajax/reviews/get/ref=cm_cr_getr_d_paging_btm_next_${pageNum}`,
  });

  return JSON.parse(amazonjsonui.split('\n').filter((_) => _ !== '&&&')[6])[2];
};

const main0 = async () => {
  const page1 = await reviewsPage();

  const $ = cheerio.load(page1);
  const totalReviews = $('div[data-hook=cr-filter-info-review-rating-count]')
    .text()
    .trim()
    .match(/(\d+)/)?.[1];
  if (!totalReviews) throw new Error('no reviews?');
  const rounded = Math.ceil(parseInt(totalReviews, 10) / 10) * 10; // if `totalReviews` is `473`, this returns 480
  const totalPages = Math.ceil(rounded / 10);
  console.log({ rounded, totalPages });

  let reviews: Review[] = [];
  reviews = parseReviews0(page1);
  let pageN = 2;

  while (pageN <= totalPages) {
    const page = await reviewsPage();
    reviews = [...reviews, ...parseReviews0(page)];
    pageN += 1;
    console.log(reviews.length);
  }

  console.log(reviews);
};

const main = async () => {
  const page1 = await reviewsAjax({ pageNum: 1 });
  console.log(page1);
  const reviews = parseReviews0(page1);
  console.log(reviews);
};

await main();
