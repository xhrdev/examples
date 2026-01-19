/**
 * run this script:

npm run tsx src/idealista/data.ts

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

// Enable cookie support
wrapper(axios);
dotenv.config();

const xhrApiKey = process.env.XHR_API_KEY;
if (!xhrApiKey) throw new Error('set XHR_API_KEY in .env file');

const HttpsProxyCookieAgent = createCookieAgent(HttpsProxyAgent);
const jar = new CookieJar();
const httpsProxyCookieAgent = new HttpsProxyCookieAgent(proxyUrl, {
  cookies: { jar },
});

const { data } = await axios.request({
  headers: {
    'x-xhr-api-key': xhrApiKey,
  },
  httpsAgent: httpsProxyCookieAgent,
  url: 'https://www.idealista.com/en/alquiler-locales/madrid-madrid/con-metros-cuadrados-menos-de_500,locales,en-planta-calle,alquiler-solo-inmueble,negocio-traspaso,locales-fiesta,restauracion,comercio-alimentacion/',
});

// has all clearance cookies, can be saved for future use
console.log((jar.store as unknown as { idx: Record<string, string> }).idx);

type Listing = {
  id: number;
  key_features: string[];
  layout: {
    bathrooms: null | number;
    rooms: null | number;
  };
  links: {
    listing_url: string;
    main_image_url: null | string;
  };
  location: {
    address: string;
    city: string;
    country: string;
    latitude: null | number;
    longitude: null | number;
  };
  operation: string;
  property_size: {
    constructed_m2: null | number;
  };
  property_type: string;
  published_at: null | string;
  rent: RentData;
  status: string;
  sustainability: string[];
  title: string;
};

type RentData = {
  amount: null | number;
  currency: string;
  rent_per_m2: {
    amount: null | number;
    currency: string;
  };
  transfer_currency: null | string;
  transfer_price: null | number;
};

const parsed = ((html: string): Listing[] => {
  const $ = cheerio.load(html);
  const listings: Listing[] = [];
  const base_url = 'https://www.idealista.com';

  // Reference date from the file header
  const referenceDate = new Date('2026-01-19T08:00:00Z');

  $('article.item').each((_, element) => {
    const $el = $(element);

    // 1. Basic IDs and Titles
    const id = parseInt($el.attr('data-element-id') || '0', 10);
    const fullTitle = $el.find('.item-link').text().trim();
    const linkPath = $el.find('.item-link').attr('href') || '';

    // 2. Extract Price Logic
    const priceText = $el.find('.item-price').text().replace(/[^\d]/g, '');
    const rentAmount = priceText ? parseInt(priceText, 10) : null;

    // 3. Extract Transfer Price
    const transferText = $el.find('.item-transfer').text();
    const transferMatch = transferText.match(/([\d,.]+)/);
    const transferAmount = transferMatch
      ? parseInt(transferMatch[0].replace(/[.,]/g, ''), 10)
      : null;

    // 4. Extract Size and Price/m2
    let sizeM2: null | number = null;
    let pricePerM2: null | number = null;

    $el.find('.item-detail').each((_, detail) => {
      const txt = $(detail).text();
      if (txt.includes('m²') && !txt.includes('/m²')) {
        sizeM2 = parseInt(txt.replace(/[^\d]/g, ''), 10);
      } else if (txt.includes('€/m²')) {
        pricePerM2 = parseFloat(txt.replace('€/m²', '').trim());
      }
    });

    // 5. Published Date Approximation
    const dateText = $el
      .find('.txt-highlight-red, .item-detail')
      .last()
      .text()
      .trim();
    let publishedAt: null | string = referenceDate.toISOString();
    if (dateText.includes('hours')) {
      const hours = parseInt(dateText, 10);
      const d = new Date(referenceDate);
      d.setHours(d.getHours() - hours);
      publishedAt = d.toISOString();
    } else if (dateText.match(/\d+\s+\w+/)) {
      // e.g. "17 Jan"
      publishedAt = `2026-${dateText.replace('Jan', '01')}-01T12:00:00Z`;
    }

    // 6. Location Breakdown
    const titleParts = fullTitle.split(',');
    const address = titleParts[0]?.trim() || '';
    const city = titleParts[titleParts.length - 1]?.trim() || 'Madrid';

    // 7. Image Extraction
    const imageUrl =
      $el.find('picture img').attr('src') ||
      $el.find('picture source').attr('srcset');

    listings.push({
      id,
      key_features: [], // Would require further regex on description
      layout: {
        bathrooms: null,
        rooms: null, // Not typically available on commercial summary cards
      },
      links: {
        listing_url: base_url + linkPath,
        main_image_url: imageUrl || null,
      },
      location: {
        address: address,
        city: city,
        country: 'Spain',
        latitude: null, // Summary page doesn't usually expose exact coords in HTML
        longitude: null,
      },
      operation: 'rent',
      property_size: {
        constructed_m2: sizeM2,
      },
      property_type: 'commercial properties',
      published_at: publishedAt,
      rent: {
        amount: rentAmount,
        currency: '€',
        rent_per_m2: {
          amount: pricePerM2,
          currency: '€',
        },
        transfer_currency: transferAmount ? '€' : null,
        transfer_price: transferAmount,
      },
      status: 'active',
      sustainability: [],
      title: fullTitle,
    });
  });

  return listings;
})(data);

console.log(parsed);
