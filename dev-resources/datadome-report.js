/**
 * Runs a fixed set of DataDome sites N times each (default 3) through the
 * load-test runner and prints a pass-count table, e.g. `3/3`. Not part of CI;
 * for a by-hand "does it still clear these sites" check.
 *
 * A run can meet two challenges, an interstitial and then a captcha, so a
 * bare pass count cannot say which one is failing. The table breaks them out:
 *
 *   Interstitial  got past / met. Getting past means accepted outright OR
 *                 answered with a captcha — DataDome took the submission and
 *                 moved on, so the interstitial was not what stopped the run.
 *   Captcha       accepted / met, whether escalated to or served directly.
 *                 `-` when no run reached one.
 *   Paths         how runs went, e.g. `i x1, i>c x2`. A run that clears on the
 *                 interstitial alone shows as `i` and never counts toward the
 *                 captcha column, so `3/3 | 0/2 | i x1, i>c x2` reads as: every
 *                 interstitial was fine, both captchas failed.
 *
 *   node --env-file=.env dev-resources/datadome-report.js [--iterations=N] [--only=a,b] [--concurrency=N] [--no-headless]
 *
 * Sites run concurrently (default 3); iterations of one site run one at a
 * time, each with a fresh proxy session, so no single target sees a burst.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const LOADTEST_PATH = path.join(PROJECT_ROOT, 'src/loadtest.ts');

const SITES = [
  'alaska',
  'saks',
  'anthropologie',
  'yelp',
  'etsy',
  'github-signup',
  'book-secure',
];

const flag = (name, fallback) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;

const ITERATIONS = Number(flag('iterations', 3));
const CONCURRENCY = Number(flag('concurrency', 3));
const HEADLESS = !process.argv.includes('--no-headless');
const only = flag('only', '');
const sites = only ? only.split(',') : SITES;
for (const s of sites) {
  if (!SITES.includes(s)) {
    console.error(`unknown site "${s}" — choose from ${SITES.join(', ')}`);
    process.exit(1);
  }
}

async function pool(items, worker, limit) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await worker(items[i]);
      }
    })
  );
  return out;
}

function runSite(site) {
  return new Promise((resolve) => {
    const args = [
      '--env-file=.env',
      LOADTEST_PATH,
      `--script=src/datadome/${site}`,
      `--iterations=${ITERATIONS}`,
      '--concurrency=1',
    ];
    if (HEADLESS) args.push('--headless');
    const started = Date.now();
    const child = spawn('node', args, { cwd: PROJECT_ROOT });
    let output = '';
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    child.on('error', (e) => (output += `spawn error: ${e.message}\n`));
    child.on('exit', (code) => {
      const pass = Number(/Pass .*?:\s+(\d+)/.exec(output)?.[1] ?? 0);
      const note = /BANNED/.test(output)
        ? 'banned'
        : /RATE LIMITED/.test(output)
          ? 'rate limited'
          : '';
      console.log(`\n--- ${site} ---\n${output}`);
      resolve({
        code,
        elapsed: `${((Date.now() - started) / 1000).toFixed(1)}s`,
        note,
        result: `${pass}/${ITERATIONS}`,
        site,
        ...stages(output),
      });
    });
  });
}

/**
 * Break a site's runner output into per-stage counts.
 *
 * Without `--quiet` the runner streams each iteration's own log after a
 * `[n/N] Starting...` line, one iteration at a time, so each slice is one
 * run. The solver logs every challenge as it arrives with the sequence so far
 * (`DataDome captcha detected (round 2, i -> c)`); the last such line is how
 * far the run got, and its RESULT line says whether it got through.
 */
function stages(output) {
  const tally = { c: [0, 0], i: [0, 0], paths: new Map() };
  for (const run of output.split(/^\[\d+\/\d+\] Starting\.\.\.$/mu).slice(1)) {
    const detected = [
      ...run.matchAll(
        /DataDome \w+ detected \(round \d+, ([ic](?: -> [ic])*)\)/gu
      ),
    ];
    if (!detected.length) continue;
    const path = detected.at(-1)[1].split(' -> ');
    const passed = /RESULT: SUCCESS/u.test(run);
    path.forEach((stage, index) => {
      tally[stage][1] += 1;
      // Every stage before the last was got past, or there'd be no next one.
      if (passed || index < path.length - 1) tally[stage][0] += 1;
    });
    const key = path.join('>');
    tally.paths.set(key, (tally.paths.get(key) ?? 0) + 1);
  }
  const ratio = ([got, met]) => (met ? `${got}/${met}` : '-');
  return {
    captcha: ratio(tally.c),
    interstitial: ratio(tally.i),
    paths: [...tally.paths].map(([path, n]) => `${path} x${n}`).join(', '),
  };
}

const results = await pool(sites, runSite, CONCURRENCY);

const rows = results.map((r) => [
  r.site,
  r.result,
  r.interstitial,
  r.captcha,
  r.paths,
  r.elapsed,
  r.note,
]);
const headers = [
  'Site',
  'Cleared',
  'Interstitial',
  'Captcha',
  'Paths',
  'Elapsed',
  'Note',
];
const widths = headers.map((h, i) =>
  Math.max(h.length, ...rows.map((r) => r[i].length))
);
const fmt = (cells) =>
  `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
console.log('\n=== DataDome Report ===');
console.log(fmt(headers));
console.log(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
for (const row of rows) console.log(fmt(row));

process.exit(results.every((r) => r.code === 0) ? 0 : 1);
