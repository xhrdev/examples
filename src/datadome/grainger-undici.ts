/**
 * Run with:
 *
 * node --env-file=.env src/datadome/grainger-undici.ts
 * node --env-file=.env src/datadome/grainger-undici.ts --url=https://www.idealista.com/
 *
 * DataDome clearance cookies for grainger.com with **undici** — no browser.
 *
 * There are three interchangeable versions of this example, one per HTTP
 * client. They do exactly the same four requests; only the client differs:
 *
 *   grainger-undici.ts   undici          (this file)
 *   grainger-axios.ts  axios + axios-cookiejar-support
 *   grainger-fetch.ts  Node's built-in fetch, no dependencies
 *
 * The four requests:
 *
 *   1. GET the target. DataDome answers 403 with an inline `var dd = {...}`.
 *   2. GET the challenge document from geo.captcha-delivery.com.
 *   3. POST /dd/solve?submit=false — the solver returns a prepared submission.
 *   4. Send that submission yourself. DataDome returns the clearance cookie.
 *
 * Step 4 has to come from your own IP: DataDome binds the cookie to whoever
 * submitted it, so letting the solver submit (`submit=true`, the default)
 * yields a cookie that is void from your address. See challenge.ts.
 */
// undici's `fetch` is the same implementation Node exposes globally, but its
// types expose `dispatcher`, which is how a per-request proxy is set.
import { fetch, ProxyAgent } from 'undici';

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

const attempt = async ({
  proxy,
  solverApiKey,
  solverUrl,
  targetUrl,
}: Context): Promise<null | Outcome> => {
  const dispatcher = new ProxyAgent(proxy);

  // 1. Trip the challenge.
  log(`GET ${targetUrl}`);
  const blocked = await fetch(targetUrl, {
    dispatcher,
    headers: navigationHeaders(),
  });
  const blockedHtml = await blocked.text();
  log(`  <- HTTP ${blocked.status} (${blockedHtml.length} bytes)`);

  const dd = parseBlockPage(blockedHtml);
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
  const document = await fetch(documentUrl, {
    dispatcher,
    headers: documentHeaders(targetUrl),
  });
  const documentHtml = await document.text();
  log(`  <- HTTP ${document.status} (${documentHtml.length} bytes)`);

  // 3. Ask xhr.dev to build the submission — but not to send it.
  log('POST /dd/solve?submit=false');
  const solve = await fetch(solveEndpoint(solverUrl), {
    body: JSON.stringify(
      solveRequestBody({ dd, documentHtml, documentUrl, proxy, targetUrl })
    ),
    headers: {
      'content-type': 'application/json',
      ...(solverApiKey ? { 'x-api-key': solverApiKey } : {}),
    },
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!solve.ok) {
    throw new Error(
      `solver returned HTTP ${solve.status}: ${(await solve.text()).slice(0, 300)}`
    );
  }
  const prepared = checkPreparedSubmission(
    (await solve.json()) as PreparedSubmission
  );
  log('  <- prepared submission');

  // 4. Submit it ourselves, over the same proxy session. Captcha solves carry
  //    their payload in the query string (GET); interstitials post a body.
  log(`${prepared.body ? 'POST' : 'GET'} submission`);
  const submitted = await fetch(prepared.url, {
    ...(prepared.body === undefined ? {} : { body: prepared.body }),
    dispatcher,
    headers: submissionHeaders(prepared),
    method: prepared.body === undefined ? 'GET' : 'POST',
  });
  const cookie = readClearanceCookie(await submitted.text());
  log(`  <- HTTP ${submitted.status}`);
  log(`clearance cookie: datadome=${cookie}`);

  // Prove it: the request that 403'd should now return the real page.
  log('verifying against the target');
  const verified = await fetch(targetUrl, {
    dispatcher,
    headers: { ...navigationHeaders(), cookie: `datadome=${cookie}` },
  });
  const html = await verified.text();
  const title = pageTitle(html);
  log(`  <- HTTP ${verified.status} (${html.length} bytes) "${title ?? ''}"`);

  return { cookie, status: verified.status, title };
};

await run(attempt);
