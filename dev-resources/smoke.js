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
const SCRIPTS = [
  { script: 'src/datadome/grainger-undici' },
  { script: 'src/datadome/grainger-axios' },
  { script: 'src/datadome/grainger-fetch', useEnvProxy: true },
  { headless: true, script: 'src/datadome/grainger' },
  // Documented as flaky in src/datadome/README.md: even with its own 3
  // built-in retries, a Lightpanda-driven solve only verifies ~60% of the
  // time. Non-blocking so that known variance doesn't fail the whole suite.
  { blocking: false, script: 'src/datadome/grainger-lightpanda' },
  { headless: true, script: 'src/datadome/idealista' },
  { headless: true, script: 'src/akamai/comcast' },
  // dev-resources/lightpanda-download.js only runs on a plain `npm install`;
  // CI and Docker both install with --ignore-scripts by design (see that
  // file), so the binary this needs is never present there. Non-blocking so
  // CI can still exercise every other example.
  { blocking: false, script: 'src/akamai/comcast-lightpanda' },
  { headless: true, script: 'src/akamai/ca-edd' },
];

function runOne({ headless, script, useEnvProxy }) {
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
    child.on('exit', (code) => resolve({ code: code ?? 1, script }));
    child.on('error', (err) => {
      console.error(`  spawn error: ${err.message}`);
      resolve({ code: 1, script });
    });
  });
}

const results = [];
for (const entry of SCRIPTS) {
  results.push({
    ...(await runOne(entry)),
    blocking: entry.blocking !== false,
  });
}

const failed = results.filter((r) => r.code !== 0 && r.blocking);

console.log('\n=== Smoke Test Summary ===');
for (const { blocking, code, script } of results) {
  const label =
    code === 0
      ? 'PASS'
      : blocking
        ? `FAIL (exit=${code})`
        : `FLAKY (exit=${code}, non-blocking)`;
  console.log(`  ${label}  ${script}`);
}

process.exit(failed.length > 0 ? 1 : 0);
