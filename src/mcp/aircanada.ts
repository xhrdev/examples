/**
 * Run with:
 *
 *   npm run mcp:aircanada
 *   npm run mcp:aircanada -- --url=https://www.hilton.com/en/
 *
 * Akamai SBSD through the hosted MCP server, with **no browser at all**.
 *
 * The `sbsd/` examples in this repo drive the channel from Playwright: the
 * page loads the bundle, the bundle emits its carrier POSTs, and `attach()`
 * rewrites each one with the next row of the ledger. This does the same
 * exchange without any of that — the ledger is issued for a document this
 * process fetched, and this process sends the rows itself:
 *
 *   1. GET the document. The property serves the SBSD bundle in it and sets
 *      bm_s / bm_sz in the jar.
 *   2. akamai_sbsd_solve { url, html, cookieHeader } -> a FIFO ledger.
 *   3. POST each row to its resolvedUrl, in index order.
 *
 * Steps 1 and 3 leave from this machine, through `proxy=` if you set one, and
 * they are the ones that have to agree: the bm_s / bm_so the carriers earn
 * land in the jar of whoever sends them. Step 2 is the hosted server's, and
 * the one request it makes inside — fetching the bundle — leaves from *its*
 * address. That is not a binding that matters; the bundle is served to anyone
 * who asks for that exact `src`.
 *
 * ## why aircanada
 *
 * It is the SBSD-only target. hilton.com and aa.com run both channels and gate
 * on `_abck` as well, which needs a browser bridge and is not available on the
 * hosted server — so on those two this answers one channel of two and the
 * document stays blocked. aircanada does not gate on `_abck` at all, which
 * makes SBSD the only variable.
 *
 * ## the transport is the catch, and it is not an SBSD catch
 *
 * A protected property refuses a client whose TLS and HTTP/2 fingerprint is
 * your HTTP library's, usually with a 403 before any bundle is served — there
 * is then no challenge to solve. Headers alone move that line further than you
 * would think: measured here, `www.aircanada.com/ca/en/aco/home.html` answers
 * a bare `fetch` with a 403 "Access Denied" reference page and answers the
 * same request carrying `navigationHeaders()` with a 200 and a bundle. That is
 * why this script sends them. Where it is not enough, that is the problem to
 * fix first, and it is the same problem on every channel.
 */
import { fetch, ProxyAgent } from 'undici';

import { isSbsdBundle } from '#src/akamai/sbsd-bundle.js';
import { navigationHeaders } from '#src/datadome/http-utils.js';
import { callTool, connect, log, MCP_URL } from '#src/mcp/client.js';
import { PROFILE } from '#src/profile.js';
import { pinSession } from '#src/proxy.js';

type Ledger = {
  complete: boolean;
  error?: { code?: string; message?: string };
  expectedCap?: number;
  submissions?: {
    body: string;
    bytes: number;
    index: number;
    method?: string;
    resolvedUrl: string;
  }[];
};

const readFlag = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`${name}=`))?.split('=')[1];

const targetUrl =
  readFlag('--url') ?? 'https://www.aircanada.com/ca/en/aco/home.html';
const origin = new URL(targetUrl).origin;
const configuredProxy = process.env['proxy'];
const apiKey = process.env['api_key'];
const solverHost = process.env['host'];

const proxy = configuredProxy ? pinSession(configuredProxy).url : undefined;
const via = proxy ? { dispatcher: new ProxyAgent(proxy) } : {};

/**
 * The JavaScript-visible jar, which is what the ledger request wants. Nothing
 * here is httpOnly-aware, and it does not need to be: `document.cookieHeader`
 * is `document.cookie`, and the httpOnly cookies are deliberately not part of
 * what the page can see.
 */
const jar = new Map<string, string>();
const absorb = (headers: Headers): void => {
  for (const line of headers.getSetCookie()) {
    const pair = line.split(';')[0] ?? '';
    const split = pair.indexOf('=');
    if (split > 0)
      jar.set(pair.slice(0, split).trim(), pair.slice(split + 1).trim());
  }
};
const cookieHeader = (): string =>
  [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

log(`MCP ${MCP_URL}`);
log(proxy ? 'egress: PROXY (session pinned)' : 'egress: DIRECT (this machine)');

const client = await connect({
  ...(apiKey ? { 'x-api-key': apiKey } : {}),
  ...(solverHost ? { 'x-solver-host': solverHost } : {}),
});

// 1. Get the document. This is the request the whole thing is bound to.
log(`GET ${targetUrl}`);
const document = await fetch(targetUrl, {
  ...via,
  headers: navigationHeaders(),
});
const html = await document.text();
absorb(document.headers as unknown as Headers);
log(`  <- HTTP ${document.status} (${html.length} bytes)`);
log(`  jar: ${[...jar.keys()].join(', ') || '(empty)'}`);

if (document.status !== 200) {
  // A 403 here is the edge refusing this client's fingerprint before serving
  // any bundle. There is no challenge to solve, so say which failure it was.
  log('  the property refused this client before serving a bundle');
  log(`RESULT: skipped (HTTP ${document.status} on the document)`);
  await client.close();
  process.exit(0);
}

// Not required — the tool finds the bundle itself — but worth reporting,
// because "no bundle" and "bundle answered wrongly" are different problems.
const bundle = [...html.matchAll(/<script[^>]+\bsrc\s*=\s*["']([^"']+)["']/giu)]
  .map((match) => (match[1] ?? '').replaceAll('&amp;', '&'))
  .find((src) => {
    try {
      return isSbsdBundle(new URL(src, targetUrl));
    } catch {
      return false;
    }
  });

if (!bundle) {
  log('  no SBSD bundle in the document — this page is not on that channel');
  log('RESULT: skipped (no SBSD bundle)');
  await client.close();
  process.exit(0);
}
log(`  bundle: ${bundle.slice(0, 72)}...`);

// 2. Ask for the ledger. No profile, no bundle source, no realm snapshot —
//    the server fetches the bundle and defaults every reading that used to
//    need a live document, which is what makes this callable with a URL and
//    the HTML we already have.
log('akamai_sbsd_solve');
const started = Date.now();
const ledger = (await callTool(client, 'akamai_sbsd_solve', {
  ...(jar.size ? { cookieHeader: cookieHeader() } : {}),
  html,
  url: targetUrl,
})) as Ledger;
log(`  <- ledger in ${Date.now() - started}ms`);

if (!ledger.complete) {
  throw new Error(
    `ledger refused: ${ledger.error?.code ?? 'unknown'} — ${ledger.error?.message ?? ''}`
  );
}
log(`  complete, cap=${ledger.expectedCap}`);

// 3. Send the rows ourselves, in index order, over the session we are
//    browsing from. This is the step that cannot be delegated.
const submissions = ledger.submissions ?? [];
let answered = 0;

for (const row of submissions) {
  const response = await fetch(row.resolvedUrl, {
    ...via,
    body: row.body,
    headers: {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'content-type': 'text/plain;charset=UTF-8',
      cookie: cookieHeader(),
      origin,
      referer: targetUrl,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': PROFILE.userAgent,
    },
    method: row.method ?? 'POST',
  });
  await response.text();
  absorb(response.headers as unknown as Headers);

  log(`  row ${row.index}: ${row.bytes} bytes -> HTTP ${response.status}`);
  // Akamai answers a carrier 200 or 202; anything else is a rejection, and
  // continuing past one sends the rest of the ledger into a closed door.
  if (response.status >= 300) break;
  answered++;
}

await client.close();

log(`jar: ${[...jar.keys()].join(', ')}`);

if (answered !== submissions.length || submissions.length === 0) {
  log(`RESULT: failure (${answered}/${submissions.length} carriers accepted)`);
  process.exit(1);
}

// bm_s is set by the document; bm_so is what the answered carriers leave. Both
// present with every row accepted is the channel having run to completion.
if (!jar.has('bm_s') || !jar.has('bm_so')) {
  log('RESULT: failure (SBSD cookies missing after the carriers)');
  process.exit(1);
}

log(
  `RESULT: ok (${answered} carriers, bm_so=${jar.get('bm_so')?.slice(0, 16)}...)`
);
