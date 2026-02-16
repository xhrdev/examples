/**
 * run this script:

npm run tsx src/zillow/data.ts

 */
import * as fs from 'node:fs';
import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createCookieAgent } from 'http-cookie-agent/http';
import * as dotenv from 'dotenv';

import * as cheerio from 'cheerio'; // to parse html response

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

// can make this request or omit it, your choice
await axios.request({
  headers: {
    'x-xhr-api-key': xhrApiKey,
  },
  httpsAgent: httpsProxyCookieAgent,
  url: 'https://www.zillow.com/',
});

const { data: home } = await axios.request({
  headers: {
    accept: 'application/json', // for json response; use `text/html` for html
    'x-xhr-api-key': xhrApiKey,
  },
  httpsAgent: httpsProxyCookieAgent,
  url: 'https://www.zillow.com/homedetails/183-Victoria-St-San-Francisco-CA-94132/15194983_zpid/',
});

// fs.writeFileSync( '/Users/skilbjo/dev/examples/zillow.html', home);
// const home = fs.readFileSync(
// '/Users/skilbjo/dev/examples/zillow.html',
// 'utf-8'
// );

const homeParsed = ((html: string) => {
  const $ = cheerio.load(html);

  const scriptContent = $('#__NEXT_DATA__').html();
  if (!scriptContent) return { error: 'Next.js data block not found' };

  // Parse top level as unknown first for safety
  const rawData = JSON.parse(scriptContent) as {
    props: { pageProps: { componentProps: { gdpClientCache: string } } };
  };

  const cacheString = rawData.props.pageProps.componentProps.gdpClientCache;

  // Define cache as a record where keys are strings and values contain a property object
  const cache = JSON.parse(cacheString) as Record<
    string,
    {
      property: {
        address: {
          city: string;
          state: string;
          streetAddress: string;
          zipcode: string;
        };
        attributionInfo: {
          agentName: null | string;
          brokerName: null | string;
          mlsId: null | string;
        };
        bathrooms: number;
        bedrooms: number;
        daysOnZillow: number | string;
        homeStatus: string;
        livingAreaValue: number;
        lotSize: number | string;
        openHouseSchedule: unknown[];
        photos: Array<{ url: string }>;
        price: number;
        rentZestimate: null | number;
        resoFacts: {
          pricePerSquareFoot: null | number;
          taxAnnualAmount: null | number;
          taxAssessedValue: null | number;
        };
        schools: Array<{
          distance: number;
          grades: string;
          name: string;
          rating: number;
        }>;
        yearBuilt: number;
        zestimate: null | number;
        zpid: string;
      };
    }
  >;

  const queryKey = Object.keys(cache).find((k) =>
    k.includes('ViewShowcaseQuery')
  );

  // FIX: Guard clause handles the "Type undefined cannot be used as index type" error
  if (!queryKey || !cache[queryKey])
    return { error: 'Property data key not found in cache' };

  const property = cache[queryKey].property;

  return {
    address: {
      city: property.address.city,
      state: property.address.state,
      street: property.address.streetAddress,
      zip: property.address.zipcode,
    },
    financials: {
      annualTax: property.resoFacts.taxAnnualAmount,
      pricePerSqft: property.resoFacts.pricePerSquareFoot,
      taxAssessedValue: property.resoFacts.taxAssessedValue,
    },
    listing: {
      agent: property.attributionInfo.agentName,
      brokerage: property.attributionInfo.brokerName,
      daysOnZillow: property.daysOnZillow,
      mlsId: property.attributionInfo.mlsId,
      status: property.homeStatus,
    },
    openHouses: property.openHouseSchedule,
    photos: property.photos.map((p) => p.url),
    price: property.price,
    rentZestimate: property.rentZestimate,
    schools: property.schools.map((s) => ({
      distance: s.distance,
      grades: s.grades,
      name: s.name,
      rating: s.rating,
    })),
    stats: {
      baths: property.bathrooms,
      beds: property.bedrooms,
      lotSize: property.lotSize,
      sqft: property.livingAreaValue,
      yearBuilt: property.yearBuilt,
    },
    zestimate: property.zestimate,
    zpid: property.zpid,
  };
})(home);

console.log(homeParsed);
// has all clearance cookies, can be saved for future use
console.log((jar.store as unknown as { idx: Record<string, string> }).idx);
