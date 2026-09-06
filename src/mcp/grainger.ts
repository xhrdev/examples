/**
 * Run with:
 *
 *   npm run mcp:grainger
 *   npm run mcp:grainger -- --url=https://www.idealista.com/
 *   npm run mcp:grainger -- --send-proxy
 *
 * The same clearance-cookie flow as src/datadome/grainger-undici.ts, but with
 * the middle of it done by the hosted MCP server instead of by this process.
 *
 * That is the whole point of the comparison. Locally you make four requests
 * and one of them is to a solver you run. Here an agent makes two — the
 * blocked one and the submission — and hands the middle to a tool:
 *
 *   1. GET the target. DataDome answers 403 with an inline `var dd = {...}`.
 *   2. datadome_solve { url, blockedHtml } -> a prepared submission.
 *   3. Send that submission yourself. DataDome returns the clearance cookie.
 *   4. Retry the original request with it.
 *
 * Steps 1, 3 and 4 leave from this machine (through `proxy=` if you set one).
 * Step 2 is the hosted server's, and what it does inside is the thing worth
 * watching: it fetches the challenge document itself, which means that one
 * request leaves from *its* address rather than yours. `--send-proxy` passes
 * `proxy=` through so that fetch takes the same route the rest of the flow
 * does; running it both ways is how you find out whether the difference
 * matters for a given target.
 */
import { fetch, ProxyAgent } from 'undici';

import {
  navigationHeaders,
  pageTitle,
  parseBlockPage,
  type PreparedSubmission,
  readClearanceCookie,
  submissionHeaders,
} from '#src/datadome/http-utils.js';
import { pinSession } from '#src/proxy.js';
import { callTool, connect, log, MCP_URL } from '#src/mcp/client.js';

const readFlag = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`${name}=`))?.split('=')[1];

const targetUrl = readFlag('--url') ?? 'https://www.grainger.com/';
const sendProxy = process.argv.includes('--send-proxy');
const configuredProxy = process.env['proxy'];
const apiKey = process.env['api_key'];
const solverHost = process.env['host'];

const proxy = configuredProxy ? pinSession(configuredProxy).url : undefined;
const via = proxy ? { dispatcher: new ProxyAgent(proxy) } : {};

log(`MCP ${MCP_URL}`);
log(proxy ? 'egress: PROXY (session pinned)' : 'egress: DIRECT (this machine)');

// Bring your own key and solver when .env has them; otherwise this runs
// anonymously against the trial box, which is what a new user gets.
const client = await connect({
  ...(apiKey ? { 'x-api-key': apiKey } : {}),
  ...(solverHost ? { 'x-solver-host': solverHost } : {}),
});

// 1. Trip the challenge.
log(`GET ${targetUrl}`);
const blocked = await fetch(targetUrl, {
  ...via,
  headers: navigationHeaders(),
});
const blockedHtml = await blocked.text();
log(`  <- HTTP ${blocked.status} (${blockedHtml.length} bytes)`);

const dd = parseBlockPage(blockedHtml);
if (!dd) {
  // Not a failure: a warm IP is served the page. There is nothing to solve
  // and nothing this script can prove, so say which it was.
  log('  no DataDome challenge — the request went straight through');
  log('RESULT: skipped (not challenged)');
  await client.close();
  process.exit(0);
}
log(`  challenge: ${dd.rt === 'c' ? 'captcha' : 'interstitial'} cid=${dd.cid}`);

// 2. Hand the block page to the tool. No profile, no js_profile, no challenge
//    document — the server fills all of that in, which is the reason an agent
//    can call this with a URL and a body it already has.
log('datadome_solve');
const started = Date.now();
const prepared = (await callTool(client, 'datadome_solve', {
  blockedHtml,
  url: targetUrl,
  ...(sendProxy && proxy ? { proxy } : {}),
})) as PreparedSubmission;
log(`  <- prepared submission in ${Date.now() - started}ms`);

if (prepared.origin !== 'https://geo.captcha-delivery.com') {
  throw new Error(`unexpected submission origin: ${prepared.origin}`);
}

// 3. Submit it ourselves, over the same session we will browse from. This is
//    the step that cannot be delegated: DataDome binds the cookie to whoever
//    sends it.
log(`${prepared.body ? 'POST' : 'GET'} submission`);
const submitted = await fetch(prepared.url, {
  ...(prepared.body === undefined ? {} : { body: prepared.body }),
  ...via,
  headers: submissionHeaders(prepared),
  method: prepared.body === undefined ? 'GET' : 'POST',
});
const cookie = readClearanceCookie(await submitted.text());
log(`  <- HTTP ${submitted.status}`);
log(`clearance cookie: datadome=${cookie.slice(0, 32)}...`);

// 4. Prove it: the request that 403'd should now return the real page.
log('verifying against the target');
const verified = await fetch(targetUrl, {
  ...via,
  headers: { ...navigationHeaders(), cookie: `datadome=${cookie}` },
});
const html = await verified.text();
const title = pageTitle(html);
log(`  <- HTTP ${verified.status} (${html.length} bytes) "${title ?? ''}"`);

await client.close();

if (verified.status !== 200) {
  log(`RESULT: failure (HTTP ${verified.status} after clearance)`);
  process.exit(1);
}

log('RESULT: ok');
