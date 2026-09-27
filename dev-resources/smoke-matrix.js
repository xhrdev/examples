/**
 * Runs the full smoke suite three times concurrently, once per network
 * profile — no proxy, a datacenter IP, an ISP IP — and prints one summary
 * table per profile at the end. Not part of CI; this is for a side-by-side
 * "how does xhrdev do across different exit IPs" comparison (e.g. for a
 * public write-up), run by hand.
 *
 * Each profile is a different exit IP, so running them at once is not a
 * burst against any target — same reasoning as smoke.js's own CONCURRENCY.
 *
 * Usage:
 *
 *   DATACENTER_PROXY=http://user:pass@host:port \
 *   ISP_PROXY=http://user:pass@host:port \
 *     node --env-file=.env dev-resources/smoke-matrix.js [--concurrency=N] [--profile=slug[,slug...]]
 *
 * Neither proxy URL is committed anywhere — pass them as env vars each time.
 * `--concurrency=N` is forwarded to every profile's own smoke.js run
 * (default 4 there); with three profiles running at once that's up to 3xN
 * concurrent browser sessions, so drop it to --concurrency=2 on a modest
 * machine. `--profile=` restricts the run to one or more of no-proxy,
 * datacenter, isp (comma-separated) instead of all three — e.g.
 * --profile=isp to run just that leg on its own.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const SMOKE_PATH = path.join(PROJECT_ROOT, 'dev-resources/smoke.js');

// Each profile's full output (every script's own log, not just the summary
// table) goes here — the console only prints the summary, which is clean
// for a screenshot, but a FAIL needs the detail to know if it's real.
const LOG_DIR = path.join(PROJECT_ROOT, 'target/smoke-matrix');
mkdirSync(LOG_DIR, { recursive: true });

const CONCURRENCY_FLAG = process.argv.find((a) =>
  a.startsWith('--concurrency=')
);

const ALL_PROFILES = [
  { label: 'No proxy', proxy: '', slug: 'no-proxy' },
  {
    label: 'Datacenter proxy',
    mask: true,
    proxy: process.env['DATACENTER_PROXY'] || '',
    requiredEnv: 'DATACENTER_PROXY',
    slug: 'datacenter',
  },
  {
    label: 'ISP proxy',
    mask: true,
    proxy: process.env['ISP_PROXY'] || '',
    requiredEnv: 'ISP_PROXY',
    slug: 'isp',
  },
];

const PROFILE_FLAG = process.argv.find((a) => a.startsWith('--profile='));
const requestedSlugs = PROFILE_FLAG
  ? new Set(PROFILE_FLAG.slice('--profile='.length).split(','))
  : null;
if (requestedSlugs) {
  const known = new Set(ALL_PROFILES.map((p) => p.slug));
  for (const slug of requestedSlugs) {
    if (!known.has(slug)) {
      console.error(
        `unknown profile "${slug}" — choose from ${[...known].join(', ')}`
      );
      process.exit(1);
    }
  }
}
const PROFILES = requestedSlugs
  ? ALL_PROFILES.filter((p) => requestedSlugs.has(p.slug))
  : ALL_PROFILES;

for (const { label, proxy, requiredEnv } of PROFILES) {
  if (requiredEnv && !proxy) {
    console.error(`missing proxy for "${label}" — set ${requiredEnv}`);
    process.exit(1);
  }
}

/** `1.2.3.4` -> `x.x.x.4` — enough to show a screenshot has a real, distinct exit IP per profile without handing over the exact address (a reusable paid resource, and a target for anti-bot vendors' own OSINT-built blocklists). Left alone if it isn't a plain IPv4 (the "unknown (...)" error string, or some future proxy's IPv6 address). */
function partiallyMask(ip) {
  const octets = ip.split('.');
  if (octets.length !== 4) return ip;
  return `x.x.x.${octets[3]}`;
}

/** The exit IP a profile's traffic actually leaves from, for the table header — a marketing screenshot should show the real address, not just the label. */
async function resolveExitIp(proxy) {
  try {
    const via = proxy
      ? { dispatcher: new (await import('undici')).ProxyAgent(proxy) }
      : {};
    const res = await fetch('https://api.ipify.org', {
      signal: AbortSignal.timeout(10_000),
      ...via,
    });
    return (await res.text()).trim();
  } catch (err) {
    return `unknown (${err.message})`;
  }
}

function runProfile({ label, proxy }) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (proxy) env['proxy'] = proxy;
    else delete env['proxy'];

    const args = [SMOKE_PATH];
    if (CONCURRENCY_FLAG) args.push(CONCURRENCY_FLAG);

    const started = Date.now();
    const child = spawn('node', ['--env-file=.env', ...args], {
      cwd: PROJECT_ROOT,
      env,
    });
    let output = '';
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));
    const finish = (code) =>
      resolve({
        code,
        elapsed: `${((Date.now() - started) / 1000).toFixed(1)}s`,
        label,
        output,
      });
    child.on('exit', (code) => finish(code ?? 1));
    child.on('error', (err) => {
      output += `\nspawn error: ${err.message}`;
      finish(1);
    });
  });
}

const exitIps = await Promise.all(PROFILES.map((p) => resolveExitIp(p.proxy)));

// `::add-mask::` is a GitHub Actions log command — it tells the runner to
// redact this exact string everywhere in the job's log from here on, not
// just the line we print it on. Belt-and-suspenders alongside the partial
// masking below: this catches the full address if it turns up incidentally
// elsewhere (e.g. a proxy connection error). Harmless outside CI (just an
// unrecognised line nobody parses). The datacenter/ISP IPs are a paid,
// reusable resource of ours; the no-proxy IP is just this run's ephemeral
// runner address, so it isn't masked.
for (const [i, { mask }] of PROFILES.entries()) {
  if (mask && !exitIps[i].startsWith('unknown (')) {
    console.log(`::add-mask::${exitIps[i]}`);
  }
}

const results = await Promise.all(PROFILES.map(runProfile));

for (const [i, { elapsed, label, output }] of results.entries()) {
  const logPath = path.join(
    LOG_DIR,
    `${label.toLowerCase().replace(/\s+/g, '-')}.log`
  );
  writeFileSync(logPath, output);

  const summaryStart = output.indexOf('=== Smoke Test Summary ===');
  const summary = summaryStart === -1 ? output : output.slice(summaryStart);
  const displayIp = PROFILES[i].mask ? partiallyMask(exitIps[i]) : exitIps[i];
  console.log(`\n${'#'.repeat(60)}`);
  console.log(`# ${label} — exit IP ${displayIp} — ${elapsed} wall-clock`);
  console.log('#'.repeat(60));
  console.log(summary);
  console.log(
    `(full per-script output: ${path.relative(PROJECT_ROOT, logPath)})`
  );
}

const failed = results.filter((r) => r.code !== 0);
if (failed.length > 0) {
  console.log(
    `\n${failed.length}/${results.length} profile(s) had a blocking failure — see each table above.`
  );
}
