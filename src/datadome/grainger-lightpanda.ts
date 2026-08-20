/**
 * Run with:
 *
 * node --env-file=.env src/datadome/grainger-lightpanda.ts
 * node --env-file=.env src/datadome/grainger-lightpanda.ts --url=https://www.idealista.com/
 *
 * The DataDome flow driven by **Lightpanda** instead of Chrome — a headless
 * browser with no renderer, a ~70MB binary that starts in milliseconds. See
 * `src/lightpanda.ts` for how it is started and what it does differently.
 *
 * ## Lightpanda cannot reach DataDome on its own
 *
 * Point it straight at a proxy and DataDome answers with `rt:"c"` and
 * **`t:"bv"`** — a banned visitor — before a line of JavaScript has run, where
 * the same proxy IP a second later gets a plain `t:"fe"` from
 * `grainger-undici.ts`. It is not the user agent: undici sending
 * `User-Agent: Lightpanda/1.0` over that proxy still gets `t:"fe"`. It is the
 * connection, and nothing inside the browser can change it — `--user-agent`
 * rejects any value containing "Mozilla" and `Emulation.setUserAgentOverride`
 * is ignored on the wire.
 *
 * So `src/lightpanda.ts` puts `src/mitm.ts` in front of it: a local proxy that
 * terminates TLS and re-makes each request with undici, which is the client
 * the browser-free examples already use. With that in place the ban is gone —
 * grainger serves a normal interstitial and the solve comes back in a second
 * or two. Two details of that proxy were found here and matter:
 *
 *   - a request with **no `accept-encoding`** gets a captcha where the same
 *     request with one gets an interstitial. `undici.request` sends none;
 *     `undici.fetch` does, so the proxy uses `fetch`.
 *   - Lightpanda sends six headers and no `sec-fetch-*`. Without them
 *     grainger.com serves its own error page instead of the real one.
 *
 * ## status
 *
 * This works, but not every time. A verified attempt returns the real page and
 * DataDome rotates the cookie, which is the whole flow:
 *
 *   clearance cookie: datadome=QTlff_rUpD_JXTy6VJjnQ0wA9hB7akP68m1D2t678Gh_…
 *   verifying against the target
 *     <- HTTP 200 (489743 bytes) "Grainger Industrial Supply - MRO Products…"
 *
 * Roughly one attempt in four gets that far; the rest earn a cookie that is
 * refused on first use and come back as a fresh `rt=c t=fe`. The three
 * attempts `run()` makes turn that into a run that succeeds about six times in
 * ten. `grainger-undici.ts` on the same proxy, the same minute, verifies on
 * the first attempt every time — so this is the browser, not the solver and
 * not the IP. The cookie is what DataDome scores it as: a solve computed from
 * a Lightpanda page is evidently borderline, and it falls on either side of
 * the line from one attempt to the next.
 *
 * Retry rather than expect it. Nothing below needs changing to make an
 * attempt work; a failed one costs about seven seconds.
 *
 * Retrying is worth less than that ratio suggests, and on CI it is worth
 * nothing. Two reasons. The proxy string carries no session token, so
 * `pinSession` cannot rotate the exit IP and every attempt in a run leaves
 * from the same address — the attempts are not independent draws. And the
 * GitHub runner downloads the **linux** Lightpanda build where a workstation
 * gets the macos one; on the linux build the cookie has been refused on all
 * 11 attempts observed across two runs, against a success inside five
 * attempts locally on the same commit. Raising `--attempts` there just spends
 * seven seconds a time to be told the same thing, which is why
 * `dev-resources/smoke.js` marks this script advisory instead: it still runs
 * and still reports, but it no longer decides whether master is green.
 *
 * ## what it does
 *
 * Not `solver.ts`. The browser bridge opens a CDP session per page, which
 * crashes on Lightpanda, so this is the **HTTP flow** with the browser doing
 * the parts that need a browser:
 *
 *   1. navigate to the target, and be challenged
 *   2. read `var dd = {...}` and the challenge iframe out of the live DOM
 *   3. POST them to `/dd/solve` from Node — direct, not through the proxy
 *   4. submit from *inside the challenge frame* with `fetch()`, so it carries
 *      the browser's own connection, headers and cookies
 *   5. set the clearance cookie and navigate again
 *
 * Step 4 is the part worth keeping whatever the browser: DataDome binds the
 * cookie to the IP that submitted it, and every request Lightpanda makes goes
 * through the proxy it was started with.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import type { Frame, Page } from 'playwright-core';

import {
  challengeDocumentUrl,
  checkPreparedSubmission,
  type Context,
  log,
  type Outcome,
  pageTitle,
  parseBlockPage,
  type PreparedSubmission,
  readClearanceCookie,
  run,
  solveEndpoint,
  solveRequestBody,
  TIMEOUT_MS,
} from '#src/datadome/http-utils.js';
import { checkRateLimit } from '#src/rate-limit.js';
import { GEO_HOST } from '#src/datadome/profile.js';
import { outerHtml, start } from '#src/lightpanda.js';

const CHALLENGE_FRAME_TIMEOUT_MS = 20_000;
const NAVIGATION_TIMEOUT_MS = 45_000;

/**
 * DataDome's `c.js` injects the challenge in an iframe. Waiting for the frame
 * is cheaper than rebuilding its URL, and it proves the page's script ran.
 */
const waitForChallengeFrame = async (
  page: Page
): Promise<Frame | undefined> => {
  const deadline = Date.now() + CHALLENGE_FRAME_TIMEOUT_MS;
  for (;;) {
    const frame = page
      .frames()
      .find((candidate) => candidate.url().includes(GEO_HOST));
    if (frame) return frame;
    if (Date.now() > deadline) return undefined;
    await sleep(250);
  }
};

const attempt = async ({
  proxy,
  solverApiKey,
  solverUrl,
  targetUrl,
}: Context): Promise<null | Outcome> => {
  // The solver reads the challenge document, and it has to be the bytes
  // DataDome served — not the DOM after Lightpanda has parsed and run it, which
  // is a different (and much larger) document. The MITM proxy sees the
  // original, so take it from there.
  const documents = new Map<string, string>();
  const { context, page, stop } = await start({
    log: (message) => log(message),
    onResponse: ({ body, url }) => {
      if (url.includes(GEO_HOST) && /\/(?:captcha|interstitial)\//.test(url)) {
        documents.set(url, body);
      }
    },
    proxy,
  });
  try {
    // 1. Trip the challenge.
    log(`GET ${targetUrl}`);
    const blocked = await page.goto(targetUrl, {
      timeout: NAVIGATION_TIMEOUT_MS,
      waitUntil: 'commit',
    });
    const blockedHtml = await outerHtml(page.mainFrame());
    log(`  <- HTTP ${blocked?.status()} (${blockedHtml.length} bytes)`);

    const dd = parseBlockPage(blockedHtml);
    if (!dd) {
      log('  no DataDome challenge — the request went straight through');
      return null;
    }
    log(
      `  challenge: ${dd.rt === 'c' ? 'captcha' : 'interstitial'} t=${dd.t ?? '?'} cid=${dd.cid}`
    );
    // `bv` is a banned visitor. There is no solve for it — DataDome has already
    // decided about this client, and the solver will reject the request. Say
    // that here, where the reason is still visible.
    if (dd.t === 'bv') {
      throw new Error(
        'DataDome served t="bv" (banned visitor) — it rejected Lightpanda on ' +
          'sight. The user agent is Lightpanda/1.0 and the TLS fingerprint is ' +
          "Lightpanda's; nothing downstream can recover from that. Compare " +
          'grainger-undici.ts on the same proxy, which gets t="fe".'
      );
    }

    // 2. Take the challenge document from the load the page already did — the
    //    frame for its origin, the proxy for its bytes.
    const frame = await waitForChallengeFrame(page);
    if (!frame) {
      throw new Error(
        `the challenge iframe never loaded — lightpanda ran the block page but not ${GEO_HOST}`
      );
    }
    const documentUrl = frame.url();
    const documentHtml = documents.get(documentUrl);
    if (!documentHtml) {
      throw new Error(
        `the proxy never saw ${documentUrl} — it captured ${documents.size} challenge documents`
      );
    }
    log(`  challenge document: ${documentHtml.length} bytes`);
    // The URL c.js built should match what the HTTP examples reconstruct. A
    // divergence means the protocol moved; worth saying, not worth stopping.
    const expected = new URL(challengeDocumentUrl(dd, targetUrl)).pathname;
    const actual = new URL(documentUrl).pathname;
    if (expected !== actual) {
      log(
        `  note: expected the challenge at ${expected}, frame is at ${actual}`
      );
    }

    // 3. Ask xhr.dev to build the submission — but not to send it.
    log('POST /dd/solve');
    const solve = await fetch(solveEndpoint(solverUrl), {
      body: JSON.stringify(
        solveRequestBody({ dd, documentHtml, documentUrl, proxy, targetUrl })
      ),
      headers: {
        'content-type': 'application/json',
        ...(solverApiKey ? { 'x-api-key': solverApiKey } : {}),
      },
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    checkRateLimit(solve.status, solve.headers);
    if (!solve.ok) {
      throw new Error(
        `solver returned HTTP ${solve.status}: ${(await solve.text()).slice(0, 300)}`
      );
    }
    const prepared = checkPreparedSubmission(
      (await solve.json()) as PreparedSubmission
    );
    log('  <- prepared submission');

    // 4. Submit from inside the challenge frame. Same origin as the endpoint,
    //    so the browser sets origin, referer and sec-fetch-* itself and sends
    //    the cookies it already holds — over the proxied connection this page
    //    is already using, which is the address the cookie will be bound to.
    log(
      `${prepared.body ? 'POST' : 'GET'} submission from the challenge frame`
    );
    const submitted = await frame.evaluate(
      async ({ body, url }: { body?: string; url: string }) => {
        const response = await fetch(url, {
          ...(body === undefined
            ? { method: 'GET' }
            : {
                body,
                headers: {
                  'content-type':
                    'application/x-www-form-urlencoded; charset=UTF-8',
                },
                method: 'POST',
              }),
          credentials: 'include',
        });
        return { body: await response.text(), status: response.status };
      },
      {
        ...(prepared.body === undefined ? {} : { body: prepared.body }),
        url: prepared.url,
      }
    );
    log(`  <- HTTP ${submitted.status}`);
    const cookie = readClearanceCookie(submitted.body);
    log(`clearance cookie: datadome=${cookie}`);

    // 5. Put the cookie in the jar, replacing rather than adding to it. The
    //    block response already left a pre-solve `datadome` cookie there; send
    //    both and the stale one wins, which looks exactly like a failed solve.
    //    `/captcha/check` answers from geo.captcha-delivery.com with
    //    `Domain=.grainger.com`, so the browser drops it as a cross-site
    //    cookie and we have to place it by hand.
    const { hostname } = new URL(targetUrl);
    const before = await context.cookies(targetUrl);
    log(
      `  cookie jar before: ${before.map((c) => `${c.name}@${c.domain}`).join(', ') || 'empty'}`
    );
    await context.clearCookies({ name: 'datadome' });
    await context.addCookies([
      {
        domain: `.${hostname.replace(/^www\./, '')}`,
        name: 'datadome',
        path: '/',
        secure: true,
        value: cookie,
      },
    ]);
    const after = await context.cookies(targetUrl);
    log(
      `  cookie jar after: ${after.map((c) => `${c.name}@${c.domain}`).join(', ') || 'empty'}`
    );

    // 6. Prove it: the navigation that 403'd should now return the real page.
    log('verifying against the target');
    const verified = await page.goto(targetUrl, {
      timeout: NAVIGATION_TIMEOUT_MS,
      waitUntil: 'commit',
    });
    const html = await outerHtml(page.mainFrame());
    const title = pageTitle(html);
    const status = verified?.status() ?? 0;
    log(`  <- HTTP ${status} (${html.length} bytes) "${title ?? ''}"`);
    if (status !== 200) {
      // A second challenge here is not the same failure as the first one. Say
      // what kind it is: a fresh `fe` means the cookie was not honoured, `bv`
      // means the client itself was rejected on this request.
      const again = parseBlockPage(html);
      if (again) log(`  challenged again: rt=${again.rt} t=${again.t ?? '?'}`);
    }

    return { cookie, status, title };
  } finally {
    await stop();
  }
};

await run(attempt);
