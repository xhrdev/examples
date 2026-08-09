/**
 * Run with:
 *
 * node --use-env-proxy --env-file=.env src/datadome/grainger-fetch.ts
 * node --use-env-proxy --env-file=.env src/datadome/grainger-fetch.ts --url=https://www.idealista.com/
 *
 * DataDome clearance cookies for grainger.com with **nothing but Node** — no
 * browser, and no dependencies at all. Same four requests as
 * grainger-http.ts; see that file for the flow.
 *
 * Note the `--use-env-proxy` flag. Node's global `fetch` has no per-request
 * proxy option, but since v24 it will honour `HTTP_PROXY` / `HTTPS_PROXY` when
 * that flag (or `NODE_USE_ENV_PROXY=1`) is set. This script sets those
 * variables from `proxy=` in your `.env` before making any request.
 *
 * That is also this version's one limitation: the proxy is process-wide, so
 * every request — including the one to your own solver — goes through it. If
 * your solver is not reachable from the proxy's network, use the undici
 * version, where the proxy is per-request.
 */
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
} from '#src/datadome/challenge.js';

if (
  !process.execArgv.includes('--use-env-proxy') &&
  !process.env['NODE_USE_ENV_PROXY']
) {
  throw new Error(
    'run this one with --use-env-proxy (or NODE_USE_ENV_PROXY=1), otherwise ' +
      "Node's built-in fetch ignores the proxy and you will be making " +
      'requests from your own address'
  );
}

const attempt = async ({
  proxy,
  solverApiKey,
  solverUrl,
  targetUrl,
}: Context): Promise<null | Outcome> => {
  // Node reads these once per request, so setting them here is enough to pin
  // this attempt's session.
  process.env['HTTP_PROXY'] = proxy;
  process.env['HTTPS_PROXY'] = proxy;
  // Keep solver traffic off the proxy where the runtime allows it.
  process.env['NO_PROXY'] = new URL(solverUrl).hostname;

  // 1. Trip the challenge.
  log(`GET ${targetUrl}`);
  const blocked = await fetch(targetUrl, { headers: navigationHeaders() });
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
    headers: submissionHeaders(prepared),
    method: prepared.body === undefined ? 'GET' : 'POST',
  });
  const cookie = readClearanceCookie(await submitted.text());
  log(`  <- HTTP ${submitted.status}`);
  log(`clearance cookie: datadome=${cookie}`);

  // Prove it: the request that 403'd should now return the real page.
  log('verifying against the target');
  const verified = await fetch(targetUrl, {
    headers: { ...navigationHeaders(), cookie: `datadome=${cookie}` },
  });
  const html = await verified.text();
  const title = pageTitle(html);
  log(`  <- HTTP ${verified.status} (${html.length} bytes) "${title ?? ''}"`);

  return { cookie, status: verified.status, title };
};

await run(attempt);
