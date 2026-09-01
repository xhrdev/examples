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
  { headless: true, script: 'src/datadome/idealista' },
  { headless: true, script: 'src/akamai/sensor/comcast' },
  { script: 'src/akamai/sensor/comcast-lightpanda' },
  { headless: true, script: 'src/akamai/sensor/ca-edd' },
  // The SBSD channel. `headed` rather than `headless: true` because hilton
  // refuses a headless Chrome however good the payloads are — the same solve
  // that lands on round 5 headed sits at `~-1~` past round 30 headless — so it
  // runs against a virtual display instead (see needsVirtualDisplay).
  //
  // Advisory because hilton is the target here most sensitive to the exit
  // address, and that sensitivity is cumulative: one desktop address measured
  // 2/4 direct, then 0/2 after another handful of runs, while an ISP proxy held
  // 4/4 across the same window. CI gets a fresh address per job, which is the
  // good end of that range — so this may well be steady. Promote it to blocking
  // once a run of green ones says so, rather than assuming either way.
  { advisory: true, headed: true, script: 'src/akamai/sbsd/hilton' },
  // The same channel on properties that serve the bundle from an obfuscated
  // path rather than /.well-known/sbsd, which is what these two are here to
  // exercise: the path is discovered from the bundle's UUID `v=`, and if that
  // detection ever breaks, the ledger is never requested and these fail loudly.
  //
  // Advisory, and for a weaker reason than hilton's: neither has been seen
  // through to the end. The SBSD half works on both, but `_abck` did not reach
  // ~0~ in any local run, while comcast and hilton solved from the same address
  // in the same window — so it is not the solver, and not obviously the exit
  // either. CI runs from an address these properties have no history with,
  // which is the missing control; let these report for a while and read the
  // results before deciding what they mean.
  { advisory: true, headed: true, script: 'src/akamai/sbsd/aa' },
  { advisory: true, headed: true, script: 'src/akamai/sbsd/aircanada' },
];

/**
 * Whether a headed script has to be wrapped in a virtual display.
 *
 * CI runners have no X display, so a headed Chrome dies at launch with
 * "Missing X server or $DISPLAY" — which reads as a failed solve rather than a
 * missing display. Locally there is a real desktop and xvfb-run generally is
 * not installed, so the wrapper is applied only where it is both needed and
 * available.
 */
const needsVirtualDisplay =
  process.platform === 'linux' && !process.env['DISPLAY'];

function runOne({ advisory, headed, headless, script, useEnvProxy }) {
  return new Promise((resolve) => {
    const args = [
      LOADTEST_PATH,
      `--script=${script}`,
      '--iterations=1',
      '--concurrency=1',
    ];
    if (headless) args.push('--headless');
    if (useEnvProxy) args.push('--use-env-proxy');

    const nodeArgs = ['--env-file=.env', ...args];
    const [command, commandArgs] =
      headed && needsVirtualDisplay
        ? ['xvfb-run', ['-a', 'node', ...nodeArgs]]
        : ['node', nodeArgs];

    console.log(`\n--- ${script} ---`);
    const child = spawn(command, commandArgs, {
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
