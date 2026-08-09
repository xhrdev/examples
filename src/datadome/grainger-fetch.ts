/**
 * Run with:
 *
 * node --use-env-proxy --env-file=.env src/datadome/grainger-fetch.ts
 * node --use-env-proxy --env-file=.env src/datadome/grainger-fetch.ts --url=https://www.idealista.com/
 *
 * DataDome clearance cookies for grainger.com with **nothing but Node** — no
 * browser, and no dependencies at all. Same four requests as
 * grainger-undici.ts; see that file for the flow.
 *
 * Note the `--use-env-proxy` flag. Node's `fetch` takes its proxy from
 * `HTTP_PROXY` / `HTTPS_PROXY` rather than a per-request option, and only
 * reads them when started with that flag (or `NODE_USE_ENV_PROXY=1`). This
 * script sets them from `proxy=` in your `.env`, and sets `NO_PROXY` so the
 * call to your own solver goes direct — that one is required, not a nicety:
 * a datacenter proxy will not tunnel to the solver's port, so without it the
 * solve request simply fails.
 *
 * The only thing you give up versus the undici version is that this
 * configuration is per-process, not per-request, so one process cannot use
 * two different proxies at once. Every example here uses a single proxy, and
 * the load-test runner spawns a process per iteration, so in practice it
 * makes no difference.
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
} from '#src/datadome/http-utils.js';

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
  // Required: the solver is on your own network, and a datacenter proxy will
  // refuse to tunnel to it. Node matches this against the bare host, so an IP
  // works as well as a name.
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
