/**
 * Run with:
 *
 * node --env-file=.env src/loadtest.ts --script=src/datadome/grainger-undici --iterations=20 --concurrency=3
 * node --env-file=.env src/loadtest.ts --script=src/akamai/ca-edd --headless --iterations=50 --concurrency=5
 *
 * Spawns any src/ script repeatedly with a rotating proxy session per
 * iteration and reports pass/fail/error rates. Pass --help for every flag.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { pinSession } from '#src/proxy.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'Usage: node --env-file=.env src/loadtest.ts [--script=src/<dir>/<script>] [--iterations=N] [--concurrency=N] [--headless] [--proxy=<url>] [--host=<ip>] [--quiet]'
  );
  process.exit(0);
}

function readFlag(name: string): string {
  const prefix = `${name}=`;
  const arg = args.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

const ITERATIONS = parseInt(readFlag('--iterations') || '100', 10);
const CONCURRENCY = parseInt(readFlag('--concurrency') || '1', 10);
const HOST = readFlag('--host');
const HEADLESS = args.includes('--headless');
const QUIET = args.includes('--quiet');
const PROXY_RAW = readFlag('--proxy') || process.env['proxy'] || '';
const SCRIPT = readFlag('--script') || 'src/akamai/ca-edd';

const BASE_SESSION = Math.floor(Math.random() * 900000) + 100000;

/** True once we have told the user their proxy cannot rotate. */
let warnedStaticProxy = false;

function buildProxyWithSession(rawProxy: string, sessionId: number): string {
  const { pinned, url } = pinSession(rawProxy, sessionId);
  if (!pinned && !warnedStaticProxy) {
    warnedStaticProxy = true;
    console.warn(
      'warning: no session token found in the proxy credentials, so every ' +
        'iteration will share one exit IP and the results will not be ' +
        "representative. Add your provider's session token, or put a " +
        '"{session}" placeholder in the username or password where the ' +
        'rotating value belongs.'
    );
  }
  return url;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const SCRIPT_PATH = path.join(PROJECT_ROOT, `${SCRIPT}.ts`);

function runIteration(i: number): Promise<{ code: number; elapsed: string }> {
  return new Promise((resolve) => {
    const childArgs = [SCRIPT_PATH];
    if (HEADLESS) childArgs.push('--headless');

    const env = { ...process.env };
    if (PROXY_RAW)
      env['proxy'] = buildProxyWithSession(PROXY_RAW, BASE_SESSION + i);
    if (HOST) env['host'] = HOST;

    const start = Date.now();
    let resolved = false;

    const child = spawn('node', childArgs, {
      env,
      stdio: QUIET ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });

    const killTimer = setTimeout(() => {
      if (!resolved) {
        child.kill();
        resolved = true;
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.error(`  [#${i + 1}] killed after 120s timeout`);
        resolve({ code: 1, elapsed });
      }
    }, 120_000);

    let output = '';
    if (child.stdout)
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
    if (child.stderr)
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(killTimer);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.error(`  [#${i + 1}] spawn error: ${err.message}`);
        resolve({ code: 1, elapsed });
      }
    });

    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(killTimer);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const exitCode = code ?? 1;
        if (QUIET && exitCode !== 0 && exitCode !== 2 && output)
          console.error(`  [#${i + 1}] output:\n${output.trim()}`);
        if (QUIET && exitCode === 2)
          console.error(`  [#${i + 1}] denied (exit=2)`);
        resolve({ code: exitCode, elapsed });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\n=== Load Test ===`);
console.log(`Script:      ${SCRIPT}`);
console.log(`Iterations:  ${ITERATIONS}`);
console.log(`Concurrency: ${CONCURRENCY}`);
console.log(`Headless:    ${HEADLESS}`);
console.log(`Quiet:       ${QUIET}`);
console.log(`Host:        ${HOST || process.env['host'] || '(not set)'}`);
console.log(`Proxy:       ${PROXY_RAW ? 'set' : 'NOT SET'}`);
console.log(
  `Credentials: ${process.env['username'] ? 'set' : 'NOT SET'} / ${process.env['password'] ? 'set' : 'NOT SET'}`
);
console.log();

const results = { completed: 0, denied: 0, error: 0, success: 0 };

function recordResult(i: number, code: number, elapsed: string): void {
  results.completed++;
  let status: string;
  if (code === 0) {
    status = 'PASS';
    results.success++;
  } else if (code === 2) {
    status = 'FAIL';
    results.denied++;
  } else {
    status = `ERROR (exit=${code})`;
    results.error++;
  }
  const iter = `[${results.completed}/${ITERATIONS}]`;
  console.log(
    `${iter} #${i + 1} ${status} (${elapsed}s) | pass=${results.success} fail=${results.denied} error=${results.error}`
  );
}

if (CONCURRENCY <= 1) {
  for (let i = 0; i < ITERATIONS; i++) {
    if (!QUIET) console.log(`[${i + 1}/${ITERATIONS}] Starting...`);
    const { code, elapsed } = await runIteration(i);
    recordResult(i, code, elapsed);
  }
} else {
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < ITERATIONS) {
      const i = nextIndex++;
      if (!QUIET) console.log(`  Starting #${i + 1}...`);
      const { code, elapsed } = await runIteration(i);
      recordResult(i, code, elapsed);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ITERATIONS) }, worker)
  );
}

const total = ITERATIONS;
const pct = (n: number): string => ((n / total) * 100).toFixed(1);
console.log(
  `\n=== Summary (${total} iterations, concurrency=${CONCURRENCY}) ===`
);
console.log(
  `  Pass (login accessible): ${results.success} (${pct(results.success)}%)`
);
console.log(
  `  Fail (Access Denied):    ${results.denied} (${pct(results.denied)}%)`
);
console.log(
  `  Error (timeout/crash):   ${results.error} (${pct(results.error)}%)`
);

process.exit(results.denied > 0 || results.error > 0 ? 1 : 0);
