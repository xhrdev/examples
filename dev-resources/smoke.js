/**
 * Runs every runnable src/akamai/ and src/datadome/ example once each,
 * through the load-test runner (--iterations=1 --concurrency=1), to check
 * that they still start up and run end-to-end. This is what `npm test`
 * invokes; it needs a working .env (proxy, solver, credentials) same as
 * the scripts themselves do.
 *
 * Runs with bounded concurrency (default 4, override with --concurrency=N) —
 * see the comment above CONCURRENCY below for why that's safe against these
 * particular targets.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const LOADTEST_PATH = path.join(PROJECT_ROOT, 'src/loadtest.ts');

// Browser-driven examples accept --headless; the HTTP-only ones don't.
//
// `advisory` runs a script and reports it without letting it fail the suite.
// It should be rare: `NOT_A_REGRESSION` below already keeps an infra-only
// outcome (banned exit IP, spent rate-limit budget) from failing the suite on
// its own, so `advisory: true` is for a script that's still genuinely
// unreliable for a reason neither of those cover — not a default to reach for
// whenever a target is a little slow.
//
// Every HTTP-client example (undici/axios/fetch grainger scripts,
// comcast-http.ts) lives in `dev-resources/http/` instead of under `src/`,
// and none of them are in this list: not being a real browser is the whole
// point of these, but it is also why CI's fresh, proxyless runner address
// gets `dd.solve.failed` / "Access Denied" from them where the same commits
// solve locally against a residential exit. Same story for every Lightpanda
// example (`*-lightpanda.ts`, `dev-resources/lightpanda/`): CI never gets a
// reliable pass from any of them (the linux Lightpanda build behaves
// differently from macOS, on top of the exit-address sensitivity above).
// Rather than carry either set as permanently-advisory noise in the suite,
// they're kept out of it entirely — still committed, still type-checked and
// linted, runnable by hand, just not part of what decides whether this
// suite is green, and not part of `npm run build` either (dev-resources is
// excluded from `tsconfig.build.json`), so none of it reaches customers.
const SCRIPTS = [
  // Verified 2026-09-26 against trial.xhr.dev through the shared residential
  // proxy: clean i -> c escalation, HTTP 200 in 52s (one transient timeout on
  // an earlier attempt through the same proxy, not reproduced on retry — not
  // treated as a pattern on a single occurrence). The 2026-09-23 "not cleared"
  // advisory note no longer describes reality; promoted to blocking.
  { headless: true, script: 'src/datadome/grainger' },
  // github.com/signup — added 2026-09-27 alongside oakley below to broaden
  // DataDome coverage past grainger/idealista. Not yet run enough through the
  // suite's actual network paths to promote off a single verification the
  // way grainger/hilton/chewy were; advisory until it has one.
  { advisory: true, headless: true, script: 'src/datadome/github-signup' },
  // saksfifthavenue.com and anthropologie.com — added 2026-09-27, two more
  // straightforward DataDome interstitials (same shape as grainger, no
  // login/SBSD). Advisory until each has a verification run, same policy as
  // github-signup/oakley above.
  { advisory: true, headless: true, script: 'src/datadome/saks' },
  { advisory: true, headless: true, script: 'src/datadome/anthropologie' },
  // Not advisory — verified 2026-09-26 that its only current failure mode is
  // already covered by `NOT_A_REGRESSION` below. Two consecutive runs through
  // the shared proxy both came back `BANNED` (exit=4): DataDome reports that
  // exact exit IP banned for idealista.com specifically (grainger and every
  // Akamai target passed through the same IP in the same session, so this is
  // per-property, not a dead proxy). The previously-documented escalation-
  // timer race is not what's happening now — this needs a fresh/rotating exit
  // IP to re-verify the code path, not a round-model change. `BANNED` will
  // keep reporting without failing the suite until that happens.
  { headless: true, script: 'src/datadome/idealista' },
  { headless: true, script: 'src/akamai/sensor/comcast' },
  // Still advisory. A promotion here on 2026-09-26 was based on one run
  // through the shared residential proxy (clean 3-round solve, 17s) — which
  // is not this repo's own CI path: build-and-test.yml runs this suite with
  // no proxy= (deliberately, for a fresh IP per job, see the .env step
  // above). Under that direct path a CI run the same day still got "Access
  // Denied" at 121s — exactly the exit-address sensitivity the pre-2026-09-26
  // comment here already described. Proxied and direct are different
  // network paths for this target; promoting off proxied evidence alone was
  // the mistake. Needs a green run through the *actual* no-proxy CI path
  // before promoting again.
  { advisory: true, headless: true, script: 'src/akamai/sensor/ca-edd' },
  // The SBSD channel, and all three run headless as of 2026-09-08. hilton was
  // the last headed entry — it used to refuse a headless Chrome outright — and
  // three headless runs now land `_abck` on round 5 and reach the results
  // page. Nothing here needs a virtual display any more.
  //
  // Verified 2026-09-26 against trial.xhr.dev through the shared proxy: clean
  // solve in 21.7s. hilton was historically the target most sensitive to a
  // reused exit address, but that hasn't reproduced here; promoted to
  // blocking. Revisit if the address-sensitivity pattern comes back.
  { headless: true, script: 'src/akamai/sbsd/hilton' },
  // The same channel on two properties that serve the bundle from an
  // obfuscated path rather than /.well-known/sbsd, which is what these are here
  // to exercise: the path is discovered from the bundle's UUID `v=`, and if
  // that detection breaks, no ledger is ever requested and both fail loudly.
  //
  // Both solve end to end, headless included — the ledger request no longer
  // carries speech-synthesis voice counts, which is what used to make these
  // desktop-only. Verified against aa.com headless with `getVoices` stubbed to
  // return [], which is a runner exactly.
  //
  // aircanada is the SBSD-only one: it does not score that document on _abck,
  // so the example runs sensor: 'page' and asserts on the booking page. If it
  // ever starts failing, check whether the property has started gating on the
  // sensor before assuming the SBSD lane broke.
  //
  // Still advisory — mixed results the same day (2026-09-26) undercut an
  // earlier promotion here. An isolated run against trial.xhr.dev through the
  // shared proxy passed clean (aa 19.4s, aircanada 28.1s), but a later run
  // through the same proxy — after several hours of heavier use against it —
  // failed both (aa in 14.5s, aircanada in 72.1s). That's consistent with the
  // exit-address sensitivity this comment used to document (cumulative, not
  // a one-shot thing) rather than a code regression, but one clean run
  // doesn't outweigh it. Needs a genuine green streak, not a single pass,
  // before promoting again.
  { advisory: true, headless: true, script: 'src/akamai/sbsd/aa' },
  { advisory: true, headless: true, script: 'src/akamai/sbsd/aircanada' },
  // chewy.com, verified working (commit 5de75f4) and now has a green CI-shaped
  // run too: 19.1s against trial.xhr.dev through the shared proxy, 2026-09-26.
  // Promoted to blocking.
  { headless: true, script: 'src/akamai/sbsd/chewy' },
  // ana.co.jp — the multi-realm SBSD/abck example (#70), brought up to date in
  // #72. Local runs on 2026-09-19: 1/2 (one system-error page, one clean
  // solve reaching the flight-search results) — the same exit-address
  // sensitivity as hilton/aa/aircanada, not a code regression. Advisory for
  // the same reason.
  { advisory: true, headless: true, script: 'src/akamai/sbsd/ana' },
  // oakley.com sign-in — added 2026-09-27 for a second SBSD property besides
  // hilton/aa/aircanada/chewy. Still advisory, and still for the reason below,
  // but the reason is now the real one: until 2026-10-10 this entry could not
  // run here at all. It needs a sign-in account, the workflow has never
  // written one, and the script threw on startup — so every CI run of it was a
  // 0.7s crash that `advisory: true` quietly absorbed. It now reports NOT
  // CONFIGURED when the account is absent and actually runs when `smoke.yml`
  // has the secrets, so "no verification run through this suite's network
  // paths yet" is finally a statement about the target rather than about the
  // harness. Advisory until it has one, same as github-signup.
  { advisory: true, headless: true, script: 'src/akamai/sbsd/oakley' },
  // Shape (formerly F5) has no example in this repo yet — add an entry here
  // once one exists rather than gating xhrdev's smoke suite on a target it
  // can't yet exercise.
];

/**
 * Whether a headed script has to be wrapped in a virtual display.
 *
 * ⚠ NOTHING IN `SCRIPTS` IS HEADED ANY MORE, so this does not fire and the
 * workflows no longer install xvfb. The mechanism stays because "this target
 * refuses a headless Chrome" is a real thing a target does — hilton did it
 * until 2026-09-08 — and adding such an entry back means restoring the
 * `Install xvfb` step alongside it, or the run dies at launch with
 * "Missing X server or $DISPLAY", which reads as a failed solve.
 *
 * CI runners have no X display, so a headed Chrome dies at launch with
 * "Missing X server or $DISPLAY" — which reads as a failed solve rather than a
 * missing display. Locally there is a real desktop and xvfb-run generally is
 * not installed, so the wrapper is applied only where it is both needed and
 * available.
 */
const needsVirtualDisplay =
  process.platform === 'linux' && !process.env['DISPLAY'];

// Scripts run with bounded concurrency rather than one at a time — a
// sequential run of everything in SCRIPTS, each potentially riding out a
// 90-150s solver/kill timeout on its own, made the suite take 10+ minutes
// wall-clock for no reason: every target here is a different site behind a
// different vendor (DataDome / Akamai sensor / Akamai SBSD), so running them
// at once is ordinary multi-tab browsing from one exit IP, not a burst
// against any single target. Override with --concurrency=N; keep it modest
// if you ever add two scripts against the *same* property (that would be a
// real burst).
const CONCURRENCY = Number(
  process.argv.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? 4
);

/** `src/datadome/grainger` -> `DataDome`, `src/akamai/sbsd/hilton` -> `Akamai SBSD`. */
function laneOf(script) {
  if (script.startsWith('src/datadome/')) return 'DataDome';
  if (script.startsWith('src/akamai/sensor/')) return 'Akamai Sensor';
  if (script.startsWith('src/akamai/sbsd/')) return 'Akamai SBSD';
  return '—';
}

// Output is buffered per script and flushed as one block when it finishes,
// rather than inherited straight to the terminal — with several scripts
// running at once, interleaved live output would be unreadable.
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

    const started = Date.now();
    const child = spawn(command, commandArgs, { cwd: PROJECT_ROOT });
    let output = '';
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));

    const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
    const finish = (code) => {
      console.log(`\n--- ${script} ---\n${output}`);
      resolve({ advisory, code, elapsed: elapsed(), script });
    };
    child.on('exit', (code) => finish(code ?? 1));
    child.on('error', (err) => {
      output += `  spawn error: ${err.message}\n`;
      finish(1);
    });
  });
}

/** Runs `items` through `worker`, at most `limit` at a time, preserving `items`' order in the returned array. */
async function runPool(items, worker, limit) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, lane)
  );
  return results;
}

// Outcomes that are about where the request left from, not about whether the
// code still works. Both are already reported as their own thing by the
// scripts and by the load-test runner, and neither is reachable by changing
// anything in this repo: a 429 is a spent budget, a ban is a burned exit IP.
// Gating on them means master goes red for something no commit can fix, which
// is the same reasoning that made grainger-lightpanda advisory.
const RATE_LIMIT_EXIT_CODE = 3;
const BANNED_EXIT_CODE = 4;
// A script that needs a sign-in account and was not given one — see
// `src/credentials.ts`. Third member of this family for the same reason as the
// other two: no commit can fix a missing secret, so gating on it means master
// goes red for something no change can turn green.
//
// It is here rather than left as a plain failure because of what it was doing
// instead. `oakley.ts` threw on its second statement when the pair was absent,
// and this workflow has never written one — so the suite's only credentialed
// script has spent every CI run dying in 0.7s with `advisory: true` hiding it.
// A named state in the table is the point: NOT CONFIGURED says the target was
// never asked, where FAIL (advisory) said it was asked and said no.
const NOT_CONFIGURED_EXIT_CODE = 5;
const NOT_A_REGRESSION = new Map([
  [BANNED_EXIT_CODE, 'BANNED'],
  [NOT_CONFIGURED_EXIT_CODE, 'NOT CONFIGURED'],
  [RATE_LIMIT_EXIT_CODE, 'RATE LIMITED'],
]);

const suiteStarted = Date.now();
const results = await runPool(SCRIPTS, runOne, CONCURRENCY);
const totalElapsed = `${((Date.now() - suiteStarted) / 1000).toFixed(1)}s`;

const failed = results.filter(
  (r) => r.code !== 0 && !r.advisory && !NOT_A_REGRESSION.has(r.code)
);

/** One line per column per row — reused for CI (piped into $GITHUB_STEP_SUMMARY), local runs, and the scheduled canary, so there's exactly one report format. */
function printReport(rows, totalElapsed) {
  const headers = ['Script', 'Lane', 'State', 'Elapsed'];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );
  const rule = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  const printRow = (cells) =>
    console.log(
      `|${cells.map((c, i) => ` ${c.padEnd(widths[i])} `).join('|')}|`
    );

  console.log('\n=== Smoke Test Summary ===');
  console.log(rule);
  printRow(headers);
  console.log(rule);
  for (const row of rows) printRow(row);
  console.log(rule);
  // Wall-clock for the whole run, not the sum of each script's own Elapsed
  // column — with CONCURRENCY > 1 those overlap, so this is what actually
  // answers "how long did `npm run smoke` take".
  console.log(`Total: ${totalElapsed}`);
}

const rows = results.map(({ advisory, code, elapsed, script }) => {
  const infrastructural = NOT_A_REGRESSION.get(code);
  const state =
    code === 0
      ? 'PASS'
      : code === NOT_CONFIGURED_EXIT_CODE
        ? // No "(not a regression)" tail: the other two are outcomes the
          // target produced, and this one means nothing ran at all.
          infrastructural
        : infrastructural
          ? `${infrastructural} (not a regression)`
          : `FAIL${advisory ? ' (advisory)' : ''}`;
  return [script, laneOf(script), state, elapsed];
});
printReport(rows, totalElapsed);

process.exit(failed.length > 0 ? 1 : 0);
