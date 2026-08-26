/**
 * Runs every runnable src/akamai/ and src/datadome/ example once each,
 * through the load-test runner (--iterations=1 --concurrency=1), to check
 * that they still start up and run end-to-end. This is what `npm test`
 * invokes; it needs a working .env (proxy, solver, credentials) same as
 * the scripts themselves do.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const LOADTEST_PATH = path.join(PROJECT_ROOT, 'src/loadtest.ts');

// Browser-driven examples accept --headless; the HTTP-only ones (undici,
// axios, fetch) and the Lightpanda ones (always headless, no flag) don't.
// grainger-fetch uses node's built-in fetch, which silently ignores the
// proxy unless node itself is started with --use-env-proxy.
//
// `advisory` runs a script and reports it without letting it fail the suite.
//
// idealista is advisory because there is nothing left in this repo to fix. It
// serves a captcha, we solve it, the carrier GET returns 200 — and then the
// next document it hands back is not a second captcha but DataDome's terminal
// block page: "Se ha detectado un uso indebido", the blocked IP printed on it,
// and a support form. 28KB against the captcha's 580KB, with no
// `captcha__element` in it at all. The round loop reports that as a recurrent
// challenge, which is a fair description of what it saw and a misleading one
// of what happened: the solve was not rejected for being wrong, the address
// was blocked after making it.
//
// So it is not a missing captcha variant and not a client bug. Two things
// point at the browser interaction itself being scored: it happens from a
// residential address and from CI runners alike, and the HTTP clients — which
// never execute DataDome's script — solve the same target and are cleared.
// That is solver work, tracked separately, not something a change here
// reaches.
//
// grainger-lightpanda was advisory on the theory that DataDome refuses the
// cookie a solve from a Lightpanda page earns — 11 attempts across two runs,
// no successes, where the same commit verified locally. That note named its
// own confound: the proxy carried no session token, so `pinSession` left every
// attempt on one exit IP and retrying could not vary the one thing that
// mattered.
//
// The confound was the cause. Since CI stopped setting `proxy=`, it has solved
// on both runs, `DIRECT = SOLVED` each time, on a fresh runner address. Two
// runs against a recorded eleven is not enough to promote it back to blocking
// on its own, so it stays advisory for now — but the reason written here is no
// longer the reason, and it should be made blocking once a few more runs hold.
// See the "status" section of src/datadome/grainger-lightpanda.ts, which needs
// the same correction.
const SCRIPTS = [
  { script: 'src/datadome/grainger-undici' },
  { script: 'src/datadome/grainger-axios' },
  { script: 'src/datadome/grainger-fetch', useEnvProxy: true },
  { headless: true, script: 'src/datadome/grainger' },
  { advisory: true, script: 'src/datadome/grainger-lightpanda' },
  { advisory: true, headless: true, script: 'src/datadome/idealista' },
  { headless: true, script: 'src/akamai/comcast' },
  { script: 'src/akamai/comcast-lightpanda' },
  { headless: true, script: 'src/akamai/ca-edd' },
];

function runOne({ advisory, headless, script, useEnvProxy }) {
  return new Promise((resolve) => {
    const args = [
      LOADTEST_PATH,
      `--script=${script}`,
      '--iterations=1',
      '--concurrency=1',
    ];
    if (headless) args.push('--headless');
    if (useEnvProxy) args.push('--use-env-proxy');

    console.log(`\n--- ${script} ---`);
    const child = spawn('node', ['--env-file=.env', ...args], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve({ advisory, code: code ?? 1, script }));
    child.on('error', (err) => {
      console.error(`  spawn error: ${err.message}`);
      resolve({ advisory, code: 1, script });
    });
  });
}

// Outcomes that are about where the request left from, not about whether the
// code still works. Both are already reported as their own thing by the
// scripts and by the load-test runner, and neither is reachable by changing
// anything in this repo: a 429 is a spent budget, a ban is a burned exit IP.
// Gating on them means master goes red for something no commit can fix, which
// is the same reasoning that made grainger-lightpanda advisory.
const RATE_LIMIT_EXIT_CODE = 3;
const BANNED_EXIT_CODE = 4;
const NOT_A_REGRESSION = new Map([
  [BANNED_EXIT_CODE, 'BANNED'],
  [RATE_LIMIT_EXIT_CODE, 'RATE LIMITED'],
]);

const results = [];
for (const entry of SCRIPTS) {
  results.push(await runOne(entry));
}

const failed = results.filter(
  (r) => r.code !== 0 && !r.advisory && !NOT_A_REGRESSION.has(r.code)
);

console.log('\n=== Smoke Test Summary ===');
for (const { advisory, code, script } of results) {
  const infrastructural = NOT_A_REGRESSION.get(code);
  const status =
    code === 0
      ? 'PASS'
      : infrastructural
        ? `${infrastructural} (exit=${code}) — not a regression, not failing the suite`
        : `FAIL (exit=${code})${advisory ? ', advisory — not failing the suite' : ''}`;
  console.log(`  ${status}  ${script}`);
}

process.exit(failed.length > 0 ? 1 : 0);
