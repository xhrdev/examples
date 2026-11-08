/**
 * Run with:
 *
 *   node --env-file=.env src/akamai/sbsd/login.ts oakley --proxy=http://user:pass@host:port
 *   node --env-file=.env src/akamai/sbsd/login.ts united --proxy=http://user:pass@host:port
 *   ... add --headless, --replay-url=https://... or --out=path to taste
 *
 * `sbsd login`. Sign in to oakley.com or united.com through a given proxy —
 * answering both Akamai channels on the way in, exactly as `oakley.ts` and
 * `united.ts` do — and emit the session as an artifact another client can
 * use: every cookie the browser holds for the origin, the user agent it
 * claimed, the exit IP it all came from, and a curl command that carries
 * them.
 *
 * The contract the artifact encodes: these cookies replay from any HTTP
 * client, curl included, iff the request leaves from the same IP (the same
 * proxy) with the same user agent. Akamai binds its clearance to the
 * address that earned it and the site binds the login to the cookie; drop
 * either half and the 200s stop.
 *
 * Before reporting success the script proves that contract itself, with
 * curl: the replay URL is fetched a second time through the same proxy,
 * carrying nothing but the emitted headers and the emitted cookie header,
 * with a TLS handshake Chrome never made. Redirects are followed to where
 * they land — signed-in land on the account, anonymous land back on the
 * form — and that landing is the pass line.
 *
 * Where things land:
 *
 *   target/sbsd-login-<target>.json   the session, machine-readable
 *   stdout                            cookie header, user agent, exit IP,
 *                                     and the ready-to-paste curl command
 *
 * The artifact contains the proxy credentials and live session cookies;
 * `target/` is gitignored, keep it that way.
 *
 * Exit codes follow the suite: 0 signed in and replay verified; 1 sign-in
 * rejected or replay refused; 2 Access Denied; 3 rate limit; 5 no
 * credentials configured. united sends the account holder a text per
 * MFA challenge, so do not loop it.
 */

import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

import type { Page } from 'playwright-core';
import { fetch, ProxyAgent } from 'undici';

import type { AkamaiSessionOptions } from '#src/akamai/session.js';
import {
  looksDenied,
  openAkamaiSession,
  reportRunError,
} from '#src/akamai/session.js';
import { trackSettle } from '#src/akamai/sbsd/settle.js';
import { type AkamaiHandle, attach } from '#src/akamai/sbsd/solver.js';
import {
  type Credentials,
  NOT_CONFIGURED_EXIT_CODE,
  resolveCredentials,
} from '#src/credentials.js';
import { navigationHeaders } from '#src/datadome/http-utils.js';
import { PROFILE } from '#src/profile.js';
import { proxyUrl } from '#src/proxy.js';
import { log, readFlag, sleep } from '#src/util.js';

type TargetConfig = {
  /**
   * Where an anonymous session ends up when the replay URL is followed.
   *
   * A signed-in replay lands anywhere else; an anonymous one lands back on
   * the form (oakley: GET /login 303s a signed-in session to
   * /my-account/profile and 200s the form for an anonymous one; both
   * measured with a no-cookie control on 2026-11-07). Absent: a 200 that
   * is not denied is all that can be said from outside.
   */
  loginForm?: RegExp;
  /** Where the sign-in flow starts. */
  loginUrl: string;
  /** Whose cookies the artifact carries. */
  origin: string;
  /** The URL the curl replay is proven against. */
  replayUrl: string;
  session: AkamaiSessionOptions;
};

type TargetName = 'oakley' | 'united';

const TARGETS: Record<TargetName, TargetConfig> = {
  oakley: {
    loginForm: /^https:\/\/www\.oakley\.com\/en-us\/login/u,
    loginUrl: 'https://www.oakley.com/en-us/login',
    origin: 'https://www.oakley.com',
    replayUrl: 'https://www.oakley.com/en-us/login',
    session: {
      ignoreHTTPSErrors: true,
      locale: 'en-US',
      serviceWorkers: 'block',
    },
  },
  united: {
    loginUrl: 'https://www.united.com/en/us',
    origin: 'https://www.united.com',
    replayUrl: 'https://www.united.com/en/us',
    session: { locale: 'en-US', serviceWorkers: 'block' },
  },
};

/** What a sign-in flow decided. */
type LoginOutcome =
  | { detail: string; kind: 'rejected' }
  | { kind: 'denied' }
  | { kind: 'mfa-unanswered' }
  | { kind: 'signed-in' };

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const targetName = (readFlag('--target') ??
  positional[0] ??
  'oakley') as TargetName;
if (!Object.hasOwn(TARGETS, targetName)) {
  log(
    `usage: login.ts <${Object.keys(TARGETS).join('|')}> ` +
      `--proxy=http://user:pass@host:port — unknown target ${JSON.stringify(targetName)}`
  );
  process.exit(1);
}
const target = TARGETS[targetName];

/* `openAkamaiSession` reads the proxy from the environment; a CLI flag wins
 * over whatever `.env` carries so one shell can drive several proxies. */
const proxyFlag = readFlag('--proxy');
if (proxyFlag) process.env['proxy'] = proxyFlag;
const proxy = process.env['proxy'];

const credentials = resolveCredentials(targetName);
if (!credentials) {
  log(
    `RESULT: NOT CONFIGURED - set ${targetName}_username= and ` +
      `${targetName}_password= in .env (or the generic username=/password=)` +
      ` for the sign-in step`
  );
  process.exit(NOT_CONFIGURED_EXIT_CODE);
}

/* ------------------------------------------------------------------ *
 * Egress
 * ------------------------------------------------------------------ */

/**
 * The exit IP the proxy gives, probed before a browser or a solve is spent
 * on it. A mistyped proxy URL should fail here in two seconds, not four
 * minutes into an Akamai flow.
 */
const probeExitIp = async (proxy: string | undefined): Promise<string> => {
  const via = proxy ? { dispatcher: new ProxyAgent(proxyUrl(proxy)) } : {};
  for (const url of [
    'https://checkip.amazonaws.com/',
    'https://api.ipify.org/',
  ]) {
    try {
      const response = await fetch(url, {
        ...via,
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) continue;
      // eslint-disable-next-line security/detect-unsafe-regex -- bounded, no nesting
      const ip = /\b\d{1,3}(?:\.\d{1,3}){3}\b/.exec(await response.text())?.[0];
      if (ip) return ip;
    } catch {
      // try the next probe
    }
  }
  throw new Error(
    proxy
      ? `could not reach the internet through ${new URL(proxyUrl(proxy)).host} — check the proxy URL`
      : 'could not reach the internet from this machine'
  );
};

let exitIp: string;
try {
  exitIp = await probeExitIp(proxy);
} catch (e) {
  log(`ERROR: ${(e as Error).message}`);
  process.exit(1);
}
log(
  `Egress: ${proxy ? `proxy ${new URL(proxyUrl(proxy)).host}` : 'DIRECT'} — exit IP ${exitIp}`
);

/* ------------------------------------------------------------------ *
 * The sign-in flows (the per-target scripts, verbatim in behaviour)
 * ------------------------------------------------------------------ */

const pageTitleOf = (html: string): string =>
  /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '?';

const signInOakley = async (
  page: Page,
  akamai: AkamaiHandle,
  settle: () => Promise<void>,
  { password, username }: Credentials,
  target: TargetConfig
): Promise<LoginOutcome> => {
  await page.goto(target.loginUrl, {
    timeout: 90_000,
    waitUntil: 'domcontentloaded',
  });
  await settle();
  log(`Document reached: ${page.url()}`);

  try {
    await akamai.solveAbck();
    log('_abck accepted');
  } catch (e) {
    log(`_abck not solved: ${(e as Error).message}`);
  }

  try {
    // requestSubmit, not a click: the OneTrust banner treats either as
    // consent and reloads over the login POST. See oakley.ts for the history.
    const loginForm = page.locator('#loginForm');
    await loginForm.waitFor({ state: 'attached', timeout: 15_000 });
    await loginForm.locator('input[name="j_username"]').fill(username);
    await loginForm.locator('input[name="j_password"]').fill(password);
    log('Filled credentials, submitting...');
    await loginForm.evaluate((form) =>
      (form as HTMLFormElement).requestSubmit()
    );
  } catch (e) {
    return {
      detail: `sign-in actions failed: ${(e as Error).message}`,
      kind: 'rejected',
    };
  }

  await page
    .waitForURL(
      (u) =>
        !new URL(u).pathname.startsWith('/en-us/login') &&
        !new URL(u).pathname.includes('j_spring_security_check'),
      { timeout: 30_000 }
    )
    .catch(() => {});
  await sleep(3000);

  const html = await page.content();
  log(`Final URL: ${page.url()}`);
  log(`Page title: ${pageTitleOf(html)}`);

  if (looksDenied(html)) return { kind: 'denied' };

  const userStatus =
    (await page.context().cookies(target.origin)).find(
      (c) => c.name === 'User_Status'
    )?.value ?? '';
  log(`User_Status cookie: ${userStatus}`);

  const stillOnLogin =
    new URL(page.url()).pathname.startsWith('/en-us/login') ||
    page.url().includes('j_spring_security_check');

  if (!stillOnLogin && !userStatus.startsWith('anonymous'))
    return { kind: 'signed-in' };
  if (stillOnLogin)
    return {
      detail: 'form still shown; not an Akamai block',
      kind: 'rejected',
    };
  return {
    detail: 'left /login but the session is still a guest',
    kind: 'rejected',
  };
};

const signInUnited = async (
  page: Page,
  akamai: AkamaiHandle,
  settle: () => Promise<void>,
  { password, username }: Credentials,
  target: TargetConfig
): Promise<LoginOutcome> => {
  const otpFile = process.env['united_otp_file'] ?? 'target/united-otp';
  // The auth calls are the verdict: the DOM only reflects them a moment later.
  const authStatus: Record<string, number> = {};
  page.on('response', (response) => {
    const { pathname } = new URL(response.url());
    if (pathname.startsWith('/xapi/auth/'))
      authStatus[pathname] = response.status();
  });

  await page.goto(target.loginUrl, {
    timeout: 90_000,
    waitUntil: 'domcontentloaded',
  });
  await settle();
  log(`Document reached: ${page.url()}`);

  try {
    await akamai.solveAbck();
  } catch (e) {
    log(`_abck not solved: ${(e as Error).message}`);
  }

  try {
    await page.locator('#loginButton').click({ timeout: 20_000 });
    const usernameForm = page.locator('form:has(#MPIDEmailField)');
    await usernameForm.locator('#MPIDEmailField').fill(username);
    await usernameForm.locator('button[type="submit"]').first().click();
    log('Username submitted, waiting for the password step...');

    const passwordForm = page.locator('form:has(input[name="password"])');
    await passwordForm.locator('input[name="password"]').fill(password, {
      timeout: 30_000,
    });
    log('Filled credentials, submitting...');
    await passwordForm
      .locator('button[type="submit"]:has-text("Sign in")')
      .click();
  } catch (e) {
    return {
      detail: `sign-in actions failed: ${(e as Error).message}`,
      kind: 'rejected',
    };
  }

  // 202 from /signin is the MFA challenge; answer it if a code arrives.
  for (let i = 0; i < 30 && !authStatus['/xapi/auth/signin']; i++)
    await sleep(500);
  if (authStatus['/xapi/auth/signin'] === 202) {
    log(`MFA challenge. Waiting up to 180s for the code in ${otpFile}...`);
    rmSync(otpFile, { force: true });
    let code = '';
    for (let i = 0; i < 90 && !code; i++) {
      await sleep(2000);
      if (existsSync(otpFile))
        code = /\d{6}/.exec(readFileSync(otpFile, 'utf8'))?.[0] ?? '';
    }
    if (code) {
      rmSync(otpFile, { force: true });
      await page.keyboard.type(code, { delay: 120 });
      await page
        .locator('button[type="submit"]:has-text("Continue")')
        .last()
        .click();
      log('Code entered');
      authStatus['mfa'] = 1;
    }
  }

  await page
    .waitForFunction(
      () => {
        const button = document.querySelector('#loginButton');
        return !button || !/sign in/i.test(button.textContent ?? '');
      },
      undefined,
      { timeout: 30_000 }
    )
    .catch(() => {});
  await sleep(3000);

  const html = await page.content();
  log(`Final URL: ${page.url()}`);
  log(`Page title: ${pageTitleOf(html)}`);
  log(`Auth responses: ${JSON.stringify(authStatus)}`);

  if (looksDenied(html) || Object.values(authStatus).includes(403))
    return { kind: 'denied' };
  if (authStatus['/xapi/auth/signin'] === 202 && !authStatus['mfa'])
    return { kind: 'mfa-unanswered' };

  const signedIn =
    (authStatus['/xapi/auth/signin'] === 200 ||
      authStatus['/xapi/auth/validate-otp'] === 200) &&
    !(await page
      .locator('#loginButton')
      .filter({ hasText: /sign in/i })
      .count());
  if (signedIn) return { kind: 'signed-in' };
  return {
    detail: 'panel still shown; not an Akamai block',
    kind: 'rejected',
  };
};

/* ------------------------------------------------------------------ *
 * The artifact
 * ------------------------------------------------------------------ */

/** POSIX single-quote: embed safely in a copy-paste shell command. */
const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

const curlCommand = ({
  headers,
  proxy,
  url,
}: {
  headers: Record<string, string>;
  proxy: string | undefined;
  url: string;
}): string =>
  [
    'curl',
    '--http2',
    '--compressed',
    '-sS',
    '-L',
    '--max-redirs',
    '3',
    '-D',
    '-',
    '-o',
    '/dev/null',
    ...(proxy ? ['-x', shellQuote(proxy)] : []),
    ...Object.entries(headers).map(
      ([name, value]) => ['-H', shellQuote(`${name}: ${value}`)] as string[]
    ),
    shellQuote(url),
  ]
    .flat()
    .join(' ');

/** What the curl replay came back with. */
type CurlReplay = {
  denied: boolean;
  error?: string;
  /** Where the redirect chain ended up. */
  finalUrl: string;
  status: null | number;
};

/**
 * Replay the session with curl itself, through the same proxy.
 *
 * The artifact exists so curl can use it, so curl is also what checks it —
 * an undici check would prove the wrong transport (its TLS got this
 * connection reset outright on the first run). Run through `execFile` with
 * an argv array: no shell, no quoting, the same headers the printed command
 * carries. Redirects are followed, because where the chain lands is the
 * verdict: a signed-in oakley session bounced off /login lands on the
 * account profile; an anonymous one lands back on the form. The body is
 * kept beside the artifact for eyeballing.
 *
 * Never throws, and retries: the second-ever run died mid-transfer to a
 * reset through the datacenter proxy while the identical manual replay
 * succeeded moments later. The session was earned at sign-in; a transport
 * hiccup is retried, then recorded as data, never thrown.
 */
const replayWithCurl = async ({
  bodyFile,
  headers,
  proxy,
  url,
}: {
  bodyFile: string;
  headers: Record<string, string>;
  proxy: string | undefined;
  url: string;
}): Promise<CurlReplay> => {
  let lastError = 'curl did not run';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { stdout } = await promisify(execFile)(
        'curl',
        [
          '--http2',
          '--compressed',
          '-sS',
          '-L',
          '--max-redirs',
          '3',
          '--max-time',
          '45',
          '-o',
          bodyFile,
          '-w',
          '%{http_code} %{url_effective}',
          ...(proxy ? ['-x', proxy] : []),
          ...Object.entries(headers)
            .map(([name, value]) => ['-H', `${name}: ${value}`])
            .flat(),
          url,
        ],
        { timeout: 60_000 }
      );
      const [code, finalUrl] = stdout.trim().split(/\s+/);
      const status = Number.parseInt(code ?? '', 10);
      const body = existsSync(bodyFile) ? readFileSync(bodyFile, 'utf8') : '';
      return {
        denied: looksDenied(body),
        finalUrl: finalUrl ?? url,
        status: Number.isNaN(status) ? null : status,
      };
    } catch (e) {
      const { code: exit, stderr } = e as {
        code?: number | string;
        stderr?: string;
      };
      lastError = `curl exited ${exit ?? '?'}${stderr ? `: ${stderr.trim()}` : ''} (attempt ${attempt}/3)`;
      log(`Replay attempt ${attempt} failed — ${lastError}`);
      await sleep(2000);
    }
  }
  return { denied: false, error: lastError, finalUrl: url, status: null };
};

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

const session = await openAkamaiSession(target.session);
const {
  apiKey: solverApiKey,
  context,
  exit: cleanup,
  host: solverHost,
  page,
} = session;

const akamai = attach(page, {
  host: solverHost,
  origin: target.origin,
  ...(solverApiKey ? { solverApiKey } : {}),
});

const settle = trackSettle(page, akamai);

try {
  const outcome =
    targetName === 'oakley'
      ? await signInOakley(page, akamai, settle, credentials, target)
      : await signInUnited(page, akamai, settle, credentials, target);

  if (outcome.kind !== 'signed-in') {
    const why =
      outcome.kind === 'denied'
        ? 'Access Denied — the solver did not get us through'
        : outcome.kind === 'mfa-unanswered'
          ? 'MFA required — no code arrived in time'
          : `sign-in rejected (${outcome.detail})`;
    log(`RESULT: FAIL - ${why}`);
    await cleanup(outcome.kind === 'denied' ? 2 : 1);
  } else {
    // ---- signed in: emit the session ------------------------------
    const jar = await context.cookies(target.origin);
    const cookieHeader = jar.map((c) => `${c.name}=${c.value}`).join('; ');
    const headers = { ...navigationHeaders(), cookie: cookieHeader };
    const replayUrl = readFlag('--replay-url') ?? target.replayUrl;

    log(
      `Signed in. Session cookies (${jar.length}): ${jar.map((c) => c.name).join(', ')}`
    );
    log(`User agent: ${PROFILE.userAgent}`);
    log(`Cookie header: ${cookieHeader}`);

    // Prove it with curl itself, the client the artifact is for: same proxy,
    // the emitted user agent, the cookie header, nothing else. Never throws
    // — the session was earned at sign-in and a transport hiccup in the
    // check must not discard it.
    const out = readFlag('--out') ?? `target/sbsd-login-${targetName}.json`;
    const bodyFile = `${out.replace(/\.json$/, '')}.html`;
    const replay = await replayWithCurl({
      bodyFile,
      headers,
      proxy,
      url: replayUrl,
    });
    // A 'loginForm' target is the stronger check: the redirect chain must
    // end anywhere but back on the form. One without it can only ask for a
    // 200 that is not denied.
    const verified =
      replay.status === 200 &&
      !replay.denied &&
      !(target.loginForm?.test(replay.finalUrl) ?? false);
    log(
      replay.error
        ? `Replay check: ERROR — ${replay.error}`
        : `Replay check: GET ${replayUrl} -> HTTP ${replay.status}, landed on ${replay.finalUrl}` +
            `${replay.denied ? ' DENIED' : ''} (body saved to ${bodyFile})`
    );

    const artifact = {
      cookieHeader,
      cookies: jar.map((c) => ({
        domain: c.domain,
        expires: c.expires,
        httpOnly: c.httpOnly,
        name: c.name,
        path: c.path,
        sameSite: c.sameSite,
        secure: c.secure,
        value: c.value,
      })),
      curl: curlCommand({ headers, proxy, url: replayUrl }),
      emittedAt: new Date().toISOString(),
      exitIp,
      headers,
      origin: target.origin,
      proxy: proxy ?? '(direct — this machine)',
      replay: { ...replay, verified },
      replayUrl,
      target: targetName,
      userAgent: PROFILE.userAgent,
    };

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
    log(`Session written: ${out}`);

    log('Replay it from curl (same proxy, same user agent):');
    log(`  ${artifact.curl}`);

    if (verified) {
      log(
        'RESULT: SUCCESS - signed in; curl replayed the session through the ' +
          'same proxy with the emitted user agent and cookie header'
      );
      await cleanup(0);
    } else {
      const why = replay.error
        ? `replay errored (${replay.error})`
        : `the replay was refused (HTTP ${replay.status}, landed on ${replay.finalUrl}` +
          `${replay.denied ? ', Access Denied' : ''})`;
      log(
        `RESULT: FAIL - signed in, but ${why}. The session is in ${out}; ` +
          'the binding may want more than IP + user agent.'
      );
      await cleanup(1);
    }
  }
} catch (e) {
  await reportRunError(session, e);
}
