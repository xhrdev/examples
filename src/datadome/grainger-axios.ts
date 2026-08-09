/**
 * Run with:
 *
 * node --env-file=.env src/datadome/grainger-axios.ts
 * node --env-file=.env src/datadome/grainger-axios.ts --url=https://www.idealista.com/
 *
 * DataDome clearance cookies for grainger.com with **axios** — no browser.
 * Same four requests as grainger-undici.ts; see that file for the flow.
 *
 * Two axios specifics worth copying:
 *
 *   - `httpsAgent` + `proxy: false`. Axios's own `proxy` option rewrites the
 *     request line, which breaks HTTPS through a CONNECT proxy. Disable it and
 *     let an HttpsProxyAgent own the tunnel.
 *   - `validateStatus: () => true`. The whole point is to read a 403 body, so
 *     do not let axios throw on it.
 *
 * The cookie jar is what makes this version convenient: `datadome` is set on
 * the block response and again on the solve, and the jar carries it for you
 * rather than making you thread a Cookie header through by hand.
 */
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { createCookieAgent } from 'http-cookie-agent/http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { CookieJar } from 'tough-cookie';

import {
  challengeDocumentUrl,
  checkPreparedSubmission,
  type Context,
  documentHeaders,
  log,
  navigationHeaders,
  type Outcome,
  pageTitle,
  parseBlockPage,
  type PreparedSubmission,
  readClearanceCookie,
  run,
  solveEndpoint,
  solveRequestBody,
  submissionHeaders,
  TIMEOUT_MS,
} from '#src/datadome/http-utils.js';

/**
 * The jar has to live in the agent, not in the axios config.
 * `axios-cookiejar-support` refuses a plain `https.Agent` — pass it a `jar`
 * alongside an ordinary HttpsProxyAgent and it throws "does not support for
 * use with other http(s).Agent". Wrapping the proxy agent with
 * `createCookieAgent` gives you one object that both tunnels and stores
 * cookies.
 */
const HttpsProxyCookieAgent = createCookieAgent(HttpsProxyAgent);

/** A real page to prove the cookie works past the landing page. */
const PRODUCT_URL =
  'https://www.grainger.com/product/FEIT-ELECTRIC-Compact-LED-Bulb-Candelabra-56JH27?opr=HPRVP';

const attempt = async ({
  proxy,
  solverApiKey,
  solverUrl,
  targetUrl,
}: Context): Promise<null | Outcome> => {
  const jar = new CookieJar();
  const client = wrapper(
    axios.create({
      httpsAgent: new HttpsProxyCookieAgent(proxy, { cookies: { jar } }),
      // Let the agent handle the tunnel; axios's own proxy handling would
      // rewrite the request line and break CONNECT.
      proxy: false,
      // We need to inspect the 403 body, not throw on it.
      validateStatus: () => true,
    })
  );

  // 1. Trip the challenge.
  log(`GET ${targetUrl}`);
  const blocked = await client.get<string>(targetUrl, {
    headers: navigationHeaders(),
    responseType: 'text',
  });
  log(`  <- HTTP ${blocked.status} (${blocked.data.length} bytes)`);

  const dd = parseBlockPage(blocked.data);
  if (!dd) {
    log('  no DataDome challenge — the request went straight through');
    return null;
  }
  log(
    `  challenge: ${dd.rt === 'c' ? 'captcha' : 'interstitial'} cid=${dd.cid}`
  );

  // 2. Fetch the challenge document the solver needs to read.
  const documentUrl = challengeDocumentUrl(dd, targetUrl);
  log('GET challenge document');
  const document = await client.get<string>(documentUrl, {
    headers: documentHeaders(targetUrl),
    responseType: 'text',
  });
  log(`  <- HTTP ${document.status} (${document.data.length} bytes)`);

  // 3. Ask xhr.dev to build the submission — but not to send it. This one call
  //    goes to your own solver, so it must not use the proxy agent.
  log('POST /dd/solve?submit=false');
  const solve = await axios.post<PreparedSubmission>(
    solveEndpoint(solverUrl),
    solveRequestBody({
      dd,
      documentHtml: document.data,
      documentUrl,
      proxy,
      targetUrl,
    }),
    {
      headers: {
        'content-type': 'application/json',
        ...(solverApiKey ? { 'x-api-key': solverApiKey } : {}),
      },
      timeout: TIMEOUT_MS,
      validateStatus: () => true,
    }
  );
  if (solve.status !== 200) {
    throw new Error(
      `solver returned HTTP ${solve.status}: ${JSON.stringify(solve.data).slice(0, 300)}`
    );
  }
  const prepared = checkPreparedSubmission(solve.data);
  log('  <- prepared submission');

  // 4. Submit it ourselves, over the same proxy session. Captcha solves carry
  //    their payload in the query string (GET); interstitials post a body.
  log(`${prepared.body ? 'POST' : 'GET'} submission`);
  const submitted = await client.request<string>({
    ...(prepared.body === undefined ? {} : { data: prepared.body }),
    headers: submissionHeaders(prepared),
    method: prepared.body === undefined ? 'GET' : 'POST',
    responseType: 'text',
    url: prepared.url,
  });
  const cookie = readClearanceCookie(submitted.data);
  log(`  <- HTTP ${submitted.status}`);
  log(`clearance cookie: datadome=${cookie}`);

  // The jar already holds the clearance cookie for the target domain, so the
  // verification request needs no Cookie header of its own.
  await jar.setCookie(`datadome=${cookie}`, new URL(targetUrl).origin);

  log('verifying against the target');
  const verified = await client.get<string>(targetUrl, {
    headers: navigationHeaders(),
    responseType: 'text',
  });
  const title = pageTitle(verified.data);
  log(
    `  <- HTTP ${verified.status} (${verified.data.length} bytes) "${title ?? ''}"`
  );

  // Then a real page, on the same jar and the same pinned session. The
  // landing page is a weak test — it is cheap to serve and sites are
  // relaxed about it. A product page with a query string is what you
  // actually came for, so fetch one and make sure the cookie still holds.
  log('fetching a product page on the same jar');
  const product = await client.get<string>(PRODUCT_URL, {
    headers: { ...navigationHeaders(), referer: targetUrl },
    responseType: 'text',
  });
  log(
    `  <- HTTP ${product.status} (${product.data.length} bytes) "${pageTitle(product.data) ?? ''}"`
  );
  if (product.status !== 200) {
    throw new Error(
      `the clearance cookie did not carry to the product page: HTTP ${product.status}`
    );
  }

  return { cookie, status: verified.status, title };
};

await run(attempt);
