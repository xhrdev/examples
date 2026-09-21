/**
 * Run with:
 *
 *   npm run mcp:webfetch
 *   npm run mcp:webfetch -- --url=https://www.grainger.com/
 *
 * `web_fetch` through the hosted MCP server: one tool call, no local HTTP
 * client at all.
 *
 * Every other script in this directory drives part of the flow itself —
 * `grainger.ts` sends the DataDome submission, `aircanada.ts` sends the SBSD
 * ledger rows — because the vendor binds the result to whoever submits it.
 * `web_fetch` is the one tool that does not need that from you: the fetch,
 * the solve and the submission all happen inside the same server call, so
 * this script really is just:
 *
 *   1. web_fetch { url } -> { status, html, unblocked, ... }
 *
 * That is also its whole limitation, named in the tool's own description:
 * step 1 leaves from the server's address, not this machine's — there is no
 * `proxy=` here to set, because there is nothing left for this script to send.
 *
 * The default target is a plain, unprotected page rather than grainger.com.
 * This script exists to prove the tool works end to end even when nothing
 * challenges it, which is most of what an agent actually does with it — read
 * a page. Pass `--url=` at a DataDome-protected target to watch `unblocked`
 * flip from `"none"` to `"datadome"`, and `status` flip from `403` to `200`
 * without this script sending a second request of its own.
 */
import { callTool, connect, log, MCP_URL } from '#src/mcp/client.js';

type WebFetchResult = {
  contentType?: string;
  cookies?: string;
  error?: string;
  html?: string;
  note?: string;
  sbsdDetected?: boolean;
  status: number;
  title?: string;
  truncated?: boolean;
  unblocked: 'datadome' | 'none';
  url: string;
};

const readFlag = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`${name}=`))?.split('=')[1];

const targetUrl = readFlag('--url') ?? 'https://example.com/';
const apiKey = process.env['api_key'];
const solverHost = process.env['host'];

log(`MCP ${MCP_URL}`);
log(`web_fetch ${targetUrl}`);

// Bring your own key and solver when .env has them; otherwise this runs
// anonymously against the trial box, which is what a new user gets.
const client = await connect({
  ...(apiKey ? { 'x-api-key': apiKey } : {}),
  ...(solverHost ? { 'x-solver-host': solverHost } : {}),
});

const started = Date.now();
const result = (await callTool(client, 'web_fetch', {
  url: targetUrl,
})) as WebFetchResult;
log(`  <- in ${Date.now() - started}ms`);

await client.close();

if (result.error) {
  log(`RESULT: failure (${result.error})`);
  process.exit(1);
}

log(`status: ${result.status}`);
log(`unblocked: ${result.unblocked}`);
log(`title: ${result.title ?? '(none)'}`);
log(
  `html: ${result.html?.length ?? result.note ?? 0} bytes` +
    (result.truncated ? ' (truncated)' : '')
);
if (result.sbsdDetected)
  log(
    '  note: this page also runs Akamai SBSD, which web_fetch reports but does not drive — see akamai_sbsd_solve / aircanada.ts'
  );
if (result.cookies) log(`cookies earned: ${result.cookies}`);

// A plain 4xx/5xx with nothing to unblock is not this script's business to
// judge — the tool did its job and reported what the site said, the same way
// curl would. The one outcome worth failing on is a DataDome block that
// survived an attempted solve: unblocked: "datadome" means the tool tried,
// so a 4xx still coming back means the target refused the solve.
if (result.unblocked === 'datadome' && result.status >= 400) {
  log(
    `RESULT: failure (solved but the target still answered HTTP ${result.status})`
  );
  process.exit(1);
}

log('RESULT: ok');
