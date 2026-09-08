/**
 * Run with:
 *
 *   npm run mcp:smoke
 *
 * Does the hosted MCP server answer, and is it the server we think it is?
 *
 * No solving, no target — this is the protocol and the wiring: initialize
 * negotiates, the tool list is what we ship, a tool call round-trips, and the
 * caller headers that carry the whole configuration survive the trip through
 * CloudFront. Run it before blaming a solve for something the transport did.
 */
import { callTool, connect, log, MCP_URL } from '#src/mcp/client.js';

const solverHost = process.env['host'];
const apiKey = process.env['api_key'];

const expectedTools = [
  'akamai_queue_metrics',
  'akamai_sbsd_solve',
  'datadome_solve',
  'health_check',
  'solver_info',
  'solver_stats',
];

log(`MCP ${MCP_URL}`);

// --- anonymous: no headers at all, which is how the docs tell people to start
const anonymous = await connect();

const { tools } = await anonymous.listTools();
const names = tools.map(({ name }) => name).toSorted();
log(`tools: ${names.join(', ')}`);

if (JSON.stringify(names) !== JSON.stringify(expectedTools)) {
  throw new Error(`unexpected tool list; wanted ${expectedTools.join(', ')}`);
}

const info = (await callTool(anonymous, 'solver_info')) as {
  mode: string;
  solver_url: string;
};
log(`anonymous -> ${info.solver_url}`);
log(`  mode: ${info.mode}`);
if (!info.mode.startsWith('anonymous')) {
  throw new Error('a caller sending no headers should be anonymous');
}

const health = await callTool(anonymous, 'health_check');
log(`health_check: ${JSON.stringify(health)}`);

await anonymous.close();

// --- configured: the headers have to reach the origin intact, and they cross
//     CloudFront to get there. If an origin request policy ever stops
//     forwarding them, every caller silently falls back to the trial box.
if (solverHost || apiKey) {
  const configured = await connect({
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
    ...(solverHost ? { 'x-solver-host': solverHost } : {}),
  });

  const mine = (await callTool(configured, 'solver_info')) as {
    mode: string;
    solver_url: string;
  };
  log(`configured -> ${mine.solver_url}`);
  log(`  mode: ${mine.mode}`);

  if (mine.mode.startsWith('anonymous')) {
    throw new Error(
      'sent x-api-key/x-solver-host and the server still thinks we are anonymous — the headers did not arrive'
    );
  }
  if (
    solverHost &&
    !mine.solver_url.includes(solverHost.replace(/^\w+:\/\//, ''))
  ) {
    throw new Error(`x-solver-host did not take: ${mine.solver_url}`);
  }

  log(`stats: ${JSON.stringify(await callTool(configured, 'solver_stats'))}`);

  await configured.close();
} else {
  log('no host=/api_key= in .env — skipped the configured-caller checks');
}

log('RESULT: ok');
