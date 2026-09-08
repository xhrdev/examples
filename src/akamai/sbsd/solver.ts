/**
 * This is a Playwright library file, not a script. It exposes an `attach`
 * function you add to Playwright scripts to integrate with the xhr.dev
 * on-prem solver. See src/akamai/sbsd/hilton.ts for a runnable example.
 *
 * Akamai SBSD browser bridge.
 *
 * SBSD is Akamai's second scoring channel. A property that uses it serves a
 * bundle — from `/.well-known/sbsd` on some properties, from a per-property
 * obfuscated path on others — and that bundle POSTs its own bodies back to the
 * same path, separately from and in addition to the `_abck` sensor the
 * `sensor/` examples solve. Either path is discovered rather than assumed; see
 * `src/akamai/sbsd-bundle.ts`. A page can run one lane, the other, or both,
 * and every example in this directory happens to run both.
 *
 * The two lanes work differently, and the difference is the whole design:
 *
 *   SBSD   one request. `POST /akamai/sbsd/generate-session` answers a FIFO
 *          ledger of bodies for the document that is live right now, and the
 *          page's own carrier POSTs are rewritten to use them in order.
 *   _abck  a stateful WebSocket session on `/akamai/session`. Rounds continue
 *          until the cookie is accepted. Identical protocol to `sensor/`.
 *
 * ## Ordering
 *
 * SBSD comes first, and not by preference. The first document a protected
 * property serves is a small Akamai bootstrap that reloads itself once its
 * SBSD carrier has been answered; the real page — and the `_abck` sensor
 * script on it — only exists after that. So `attach()` installs the router
 * before you navigate, the ledger is generated during the bootstrap, and
 * `solveAbck()` is called later, against the document you actually wanted.
 *
 * ## The ledger is bound to one document
 *
 * The bodies the solver returns are computed from a snapshot of the live page:
 * its DOM, its cookies, its tab id. They are not portable. Replaying a ledger
 * against a second document, a second tab or a later load is a mismatch, and
 * the server will not issue one for a snapshot older than five minutes.
 * Generate per document, use in order, discard.
 *
 * ## The request is five fields
 *
 * It used to be a full realm snapshot — heap, connection, history, resource
 * timings, a DOM inventory, voice counts, and `Function.prototype.toString`
 * read through a pristine child realm. None of it is sent any more. The server
 * derives every one of them from the document and the profile in the same
 * request, and derives them from the very document it is about to run, so
 * measuring them here was arriving at the same answer twice.
 *
 * One consequence worth knowing: **these examples run headless now.** The
 * refusal that made them desktop-only was `speechSynthesis.getVoices()`
 * returning `[]` on a runner, and the counts are no longer part of the
 * request. Verified against aa.com headless with `getVoices` stubbed to `[]`,
 * which is a CI runner exactly. `hilton.ts` still needs a headed browser, but
 * for its own reason — that property refuses headless Chrome whatever the
 * payloads look like.
 *
 * Rows are a capacity, not a promise: the response carries `expectedCap` rows
 * and the page emits as many carriers as it emits. Running out is a hard stop,
 * never a fallback to the native body — see `route.abort()` below.
 *
 * ## Reading this file
 *
 *   attach()          the entry point; installs the router, returns a handle
 *   generateLedger()  builds the five-field request and asks for the ledger
 *   readRealm()       the three readings the request cannot be built without
 *   solveAbck()       the WebSocket lane, relayed through the page's own XHR
 */
import type { BrowserContext, Page, Route } from 'playwright-core';
import { WebSocket } from 'undici';

import { isSbsdBundle } from '#src/akamai/sbsd-bundle.js';
import { PROFILE_ID } from '#src/profile.js';
import { checkRateLimit } from '#src/rate-limit.js';
import { solverBaseUrl, solverWsUrl } from '#src/solver-url.js';

/** What `attach` hands back. */
export type AkamaiHandle = {
  /**
   * How many SBSD carrier POSTs have been answered with a ledger row so far.
   *
   * Useful as a settle signal: on a property whose bootstrap reloads itself
   * once its carrier is answered, this going above zero is what says the
   * reload is coming, and `solveAbck()` should wait for it.
   */
  carriersAnswered: () => number;
  /**
   * Resolves when `_abck` is accepted. Call it once the document you actually
   * want is loaded — not during the bootstrap. Rejects if the `_abck` sensor
   * script was never seen, which on a page that only runs SBSD is expected.
   */
  solveAbck: () => Promise<void>;
};

export type AttachOptions = {
  /**
   * Fetch intercepted script requests with this instead of Playwright's
   * `route.fetch`. Only needed for browsers where `route.fetch` is
   * unreliable — `src/mitm.ts` exposes exactly this shape, and
   * `src/akamai/sbsd/aa-lightpanda.ts` and `aircanada-lightpanda.ts` pass it,
   * for the same reason
   * `src/akamai/sensor/comcast-lightpanda.ts` does: Playwright's route.fetch
   * never returns against Lightpanda, because it runs in Playwright's request
   * context, which syncs cookies with the browser, and once that stops
   * answering every later route.fetch waits out its timeout.
   */
  fetchResponse?: (
    // eslint-disable-next-line no-unused-vars -- function-type parameters
    request: {
      body?: string;
      headers: Record<string, string>;
      method: string;
      url: string;
    }
  ) => Promise<Fetched>;
  /**
   * `host=` from .env, in either form `src/solver-url.ts` accepts. Both the
   * ledger POST and the session socket are derived from it, so a TLS solver
   * gets `https://` and `wss://` together.
   */
  host: string;
  /**
   * Origin to instrument, e.g. `https://www.hilton.com`. Only requests to
   * this origin are intercepted; third-party assets are left alone.
   */
  origin: string;
  /**
   * Read the live DOM instead of `page.content()`. Needed on Lightpanda,
   * where `page.content()`/`frame.content()` never resolve at all — use
   * `outerHtml()` from `src/lightpanda.ts` there.
   */
  readHtml?: () => Promise<string>;
  /**
   * Pin the SBSD path instead of discovering it.
   *
   * Discovery is by the bundle's UUID `v=` and covers every property tried so
   * far; this is the escape hatch for one that hides it better. Pathname only,
   * no query — the carrier POSTs to the same path the bundle was served from,
   * but with a different query string or none at all.
   */
  sbsdPath?: string;
  /**
   * Who answers the `_abck` sensor on a property that runs both channels.
   *
   * `'solver'` (the default) captures the sensor script, replaces it with a
   * stub so the page cannot post its own telemetry alongside ours, and waits
   * for `solveAbck()`. `'page'` leaves the sensor script alone and lets it run
   * natively, which is what you want when SBSD is the channel you need
   * answered and the page's own `_abck` is already being accepted — the two
   * are scored separately. `solveAbck()` rejects under `'page'`, because no
   * script was captured to solve.
   */
  sensor?: 'page' | 'solver';
  /**
   * Sent as `x-api-key` on both the ledger POST and the WebSocket upgrade.
   * Required when the solver sits behind an API-key gate — the gate matches
   * the header on the upgrade request like any other, so omitting it fails the
   * handshake with a 401 rather than anything that looks Akamai-related.
   */
  solverApiKey?: string;
};

/** A response, however it was fetched. */
type Fetched = {
  body: string;
  headers: Record<string, string>;
  /** Each `set-cookie` separately; a joined string cannot be parsed back. */
  setCookie?: string[];
  status: number;
};

type LedgerResponse = {
  complete: boolean;
  error?: { code?: string; message?: string };
  expectedCap?: number;
  /** On a refusal, which input the sandbox could not reconcile. */
  receipt?: unknown;
  runNonce?: string;
  submissions?: LedgerRow[];
};

type LedgerRow = { body: string; bytes: number; index: number };

type SolverMessage = {
  accepted?: boolean;
  body?: string;
  headers?: Record<string, string>;
  id?: string;
  message?: string;
  round?: number;
  rval?: number;
  state?: string;
  type: string;
  url?: string;
};

const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

/** What only the live page can answer. The identity is *not* in here. */
type RealmSnapshot = {
  /** `sessionStorage.ak_bm_tab_id`, written by the bundle once it has run. */
  akBmTabId: null | string;
  /** `document.cookie` — the JS-visible jar, not the HTTP header. */
  documentCookie: string;
  /** The live DOM, serialized. Not the served HTML; see `readRealm`. */
  html: string;
};

/**
 * Wait for `ak_bm_tab_id` before snapshotting.
 *
 * The bundle writes it shortly after it loads, and it is the one reading the
 * server cannot default on your behalf: with none supplied it mints a fresh id
 * per request, so a session that generates more than one ledger describes a
 * different tab each time while the real page holds one for its lifetime.
 *
 * Holding the first carrier is usually enough time on its own; usually is not
 * always, and on a fast machine the request can leave ~2s in. The wait is
 * bounded and not fatal — a snapshot without one is still worth sending, and
 * the server's answer names the reason better than a guess made here would.
 */
const waitForTabId = async (page: Page): Promise<void> => {
  try {
    await page.waitForFunction(
      () => {
        /* eslint-disable n/no-unsupported-features/node-builtins */
        /* eslint-disable no-unused-vars -- function-type parameters */
        const session = (
          globalThis as unknown as {
            sessionStorage: { getItem: (key: string) => null | string };
          }
        ).sessionStorage;
        /* eslint-enable no-unused-vars */
        /* eslint-enable n/no-unsupported-features/node-builtins */
        return typeof session.getItem('ak_bm_tab_id') === 'string';
      },
      { polling: 100, timeout: 10_000 }
    );
  } catch {
    // Bounded wait elapsed. Send it and let it be judged on its merits.
  }
};

/**
 * The three readings the ledger request cannot be built without.
 *
 * This used to be a ~90-line `page.evaluate` that measured the whole realm:
 * heap, connection, history, resource timings, a DOM inventory, and
 * `Function.prototype.toString` stringified through a pristine child realm.
 * None of it is sent any more. The server derives every one of those from the
 * document and the profile in the same request, and derives them from the very
 * document it is about to run — so measuring them here was work done twice to
 * arrive at the same answer.
 *
 * ⚠ `page.content()`, NOT the served HTML. With no `domResourceInventory` in
 * the request the server extracts one from `document.html`, so that field has
 * to be the DOM the page is actually running. The bundle injects into the
 * document after it is served; a snapshot of the served bytes would describe a
 * page whose scripts are missing. `page.content()` serializes the live DOM out
 * of the browser and does not re-fetch anything, which matters: `route.fetch()`
 * replays from Playwright's own context, and Akamai answers a replayed
 * *navigation* with a 403 reference-code page.
 *
 * `readHtml` stands in for `page.content()` on browsers where it never
 * resolves — see `AttachOptions.readHtml`.
 */
const readRealm = async (
  page: Page,
  readHtml: () => Promise<string>
): Promise<RealmSnapshot> => {
  const [state, html] = await Promise.all([
    page.evaluate(() => {
      /* eslint-disable n/no-unsupported-features/node-builtins -- these are
         the DOM's globals; this body runs in the page, not in Node. */
      /* eslint-disable no-unused-vars -- function-type parameters */
      const session = (
        globalThis as unknown as {
          sessionStorage: { getItem: (key: string) => null | string };
        }
      ).sessionStorage;
      /* eslint-enable no-unused-vars */
      /* eslint-enable n/no-unsupported-features/node-builtins */
      return {
        akBmTabId: session.getItem('ak_bm_tab_id'),
        documentCookie: document.cookie,
      };
    }),
    readHtml(),
  ]);
  return { ...state, html };
};

export function attach(page: Page, opts: AttachOptions): AkamaiHandle {
  const {
    fetchResponse,
    host,
    origin,
    readHtml = () => page.content(),
    sensor = 'solver',
    solverApiKey,
  } = opts;
  const context: BrowserContext = page.context();
  const ledgerUrl = new URL(
    '/akamai/sbsd/generate-session',
    solverBaseUrl(host)
  ).href;
  const sessionUrl = solverWsUrl(host, '/akamai/session');

  /** The raw `src` attribute, `?v=` included: it seeds the bundle's codec. */
  let sbsdSrc: null | string = null;
  let sbsdBody: null | string = null;
  /**
   * The path the bundle was served from, which is also the path its carriers
   * POST to. Learned from the bundle request unless `opts.sbsdPath` pins it,
   * and there is no race in learning it late: a carrier cannot fire before the
   * bundle that emits it has loaded.
   */
  let sbsdPath: null | string = opts.sbsdPath ?? null;
  /** Kept across the bootstrap's self-reload, so the second load can use it. */
  let bmMain: { body: string; url: string } | null = null;
  /**
   * The in-flight or completed ledger request, memoized as a *promise*.
   *
   * A page emits its carriers concurrently, so two of them can both find a
   * not-yet-populated `rows` and each ask for a ledger. That is not a wasted
   * request, it is a wrong answer: the second ledger replaces the first, the
   * cursor carries on into it, and the page ends up submitting row 0 of one
   * document snapshot followed by rows 1 and 2 of another. Memoizing the
   * promise makes the second carrier await the first request instead.
   */
  let ledger: null | Promise<LedgerRow[]> = null;
  /**
   * Rows are handed out one at a time, in order. `cursor++` across concurrent
   * route handlers is not enough on its own — the awaits between taking a row
   * and continuing the route let a later carrier overtake an earlier one, and
   * SBSD ordering is FIFO by construction.
   */
  let carrierQueue: Promise<unknown> = Promise.resolve();
  let cursor = 0;
  /** Carriers answered with a row, across every document on this page. */
  let answered = 0;
  /** The one sensor body the solver authored; anything else is the native one. */
  let authorizedSensorBody: null | string = null;

  const cookies = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await context.cookies(origin)).map((c) => [c.name, c.value])
    );

  /**
   * A new main-frame document is a new snapshot, so the ledger issued for the
   * last one is retired here rather than carried across the bootstrap's
   * self-reload. The rows are computed from one document's HTML and cookies;
   * feeding leftovers to the carriers of the page that replaced it describes a
   * visitor that was never on either.
   */
  page.on('response', (response) => {
    const request = response.request();
    if (request.resourceType() !== 'document') return;
    if (request.frame() !== page.mainFrame()) return;
    ledger = null;
    cursor = 0;
  });

  /**
   * One POST, `expectedCap` rows, for the document that is live right now.
   *
   * Five fields. Everything else the endpoint accepts — `schema`, `epochMs`,
   * `resourceEntries`, `profile.chromeFullVersion`, `profile.overrides` and
   * every member of `document.runtime` except the tab id — is optional, and
   * the default is computed from this same document and profile. Sending them
   * measured is not more honest, it is the same answer arrived at twice.
   */
  async function generateLedger(): Promise<LedgerRow[]> {
    await waitForTabId(page);
    const realm = await readRealm(page, readHtml);
    const response = await fetch(ledgerUrl, {
      body: JSON.stringify({
        bundle: { scriptSrc: sbsdSrc, source: sbsdBody },
        document: {
          // Historical field name: this is document.cookie, NOT the HTTP
          // header. The distinction matters — the httpOnly cookies in the jar
          // are deliberately not part of what the page can see.
          cookieHeader: realm.documentCookie,
          html: realm.html,
          runtime: { sessionStorage: { akBmTabId: realm.akBmTabId } },
          url: page.url(),
        },
        profile: { id: PROFILE_ID },
      }),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(solverApiKey ? { 'x-api-key': solverApiKey } : {}),
      },
      method: 'POST',
    });
    // Throws RateLimitError on 429. Not retryable — see src/rate-limit.ts.
    checkRateLimit(response.status, response.headers);
    const ledger = (await response.json()) as LedgerResponse;
    if (!ledger.complete) {
      // The refusal itself says little: `error.message` is one generic
      // sentence for every code and `receipt` is null on the common path. So
      // the inputs are reported alongside it — with the payload this small,
      // the four of them are the whole request.
      throw new Error(
        `SBSD ledger refused (${response.status}): ` +
          `${ledger.error?.code ?? 'unknown'} — ` +
          `${ledger.error?.message ?? ''} ` +
          `receipt=${JSON.stringify(ledger.receipt ?? null).slice(0, 400)} ` +
          `akBmTabId=${JSON.stringify(realm.akBmTabId)} ` +
          `profile=${PROFILE_ID} ` +
          `html=${realm.html.length}b cookie=${realm.documentCookie.length}b`
      );
    }
    log(
      `[sbsd] Ledger issued: cap=${ledger.expectedCap} nonce=${ledger.runNonce}`
    );
    return ledger.submissions ?? [];
  }

  /**
   * Put a response's cookies in the browser's jar ourselves.
   *
   * `route.fulfill` takes one header map, so it can carry exactly one
   * `set-cookie` — a script response that sets more than one loses the rest.
   * Playwright applies cookies itself when `route.fetch` did the fetching, so
   * this only runs on the `fetchResponse` path (see `fetchScript` below);
   * mirrors `applyCookies` in `src/akamai/sensor/solver.ts`.
   */
  const applyCookies = async (
    url: string,
    setCookie: string[] | undefined
  ): Promise<void> => {
    if (!setCookie || setCookie.length === 0) return;
    const { hostname } = new URL(url);
    const cookies = setCookie.flatMap((header) => {
      const [pair, ...attributes] = header.split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (!pair || index < 1) return [];
      const attribute = (name: string): string | undefined =>
        attributes
          .map((a) => a.trim())
          .find((a) => a.toLowerCase().startsWith(`${name}=`))
          ?.slice(name.length + 1);
      const expires = attribute('expires');
      const maxAge = attribute('max-age');
      const seconds = maxAge === undefined ? NaN : Number(maxAge);
      const expiresAt = Number.isFinite(seconds)
        ? Date.now() / 1000 + seconds
        : expires
          ? Date.parse(expires) / 1000
          : NaN;
      return [
        {
          domain: attribute('domain') ?? hostname,
          ...(Number.isFinite(expiresAt) ? { expires: expiresAt } : {}),
          httpOnly: attributes.some(
            (a) => a.trim().toLowerCase() === 'httponly'
          ),
          name: pair.slice(0, index).trim(),
          path: attribute('path') ?? '/',
          secure: attributes.some((a) => a.trim().toLowerCase() === 'secure'),
          value: pair.slice(index + 1).trim(),
        },
      ];
    });
    if (cookies.length > 0) await context.addCookies(cookies);
  };

  /**
   * Fetch an intercepted script request with `fetchResponse` when given,
   * falling back to `route.fetch` otherwise — see `AttachOptions.fetchResponse`.
   */
  const fetchScript = async (route: Route): Promise<Fetched> => {
    if (fetchResponse) {
      const req = route.request();
      const postData = req.postData();
      return fetchResponse({
        ...(postData === null ? {} : { body: postData }),
        headers: await req.allHeaders(),
        method: req.method(),
        url: req.url(),
      });
    }
    const resp = await route.fetch();
    return {
      body: await resp.text(),
      headers: resp.headers(),
      status: resp.status(),
    };
  };

  /**
   * Give the page a body we have already decoded.
   *
   * Two headers have to go. `content-encoding` still says `br`, and handing
   * that back with decoded text makes the browser brotli-decode plain UTF-8 —
   * the response dies and the site renders its own error page. `set-cookie`
   * goes because `fulfill` takes ONE header map: a response setting four
   * cookies would keep one and silently lose three, and `route.fetch` has
   * already put them all in the jar itself (the `fetchResponse` path puts
   * them there via `applyCookies` instead, at the call site).
   */
  const handBack = async (
    route: Route,
    response: Fetched,
    body: string
  ): Promise<void> => {
    const headers = { ...response.headers };
    delete headers['content-encoding'];
    delete headers['content-length'];
    delete headers['set-cookie'];
    await route.fulfill({ body, headers, status: response.status });
  };

  void page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const post = request.method() === 'POST';

    // SBSD carrier. The first one is held while the ledger is generated, which
    // is also what makes the snapshot legal: `sessionStorage.ak_bm_tab_id`
    // only exists once the bundle has run.
    if (post && sbsdPath !== null && url.pathname === sbsdPath) {
      const mine = carrierQueue.then(async () => {
        ledger ??= generateLedger();
        const rows = await ledger;
        const row = rows[cursor++];
        // Out of rows: fail closed. Letting the native body through here would
        // hand Akamai a payload from an uninstrumented page alongside ours.
        if (!row) return route.abort();
        log(`[sbsd] Row ${row.index}: ${row.bytes} bytes`);
        answered++;
        return route.continue({ postData: row.body });
      });
      // The queue must not stay rejected, or every later carrier inherits the
      // first failure; the awaited promise still surfaces it to this caller.
      carrierQueue = mine.catch(() => undefined);
      return mine;
    }

    // `_abck` sensor POST. Only the body the solver just authored gets
    // through; anything else is the native sensor talking, and is dropped.
    if (
      post &&
      sensor === 'solver' &&
      bmMain &&
      url.pathname === new URL(bmMain.url).pathname
    ) {
      if (request.postData() === authorizedSensorBody) {
        authorizedSensorBody = null;
        return route.continue();
      }
      log(`[abck] Dropped a native sensor POST to ${url.pathname}`);
      return route.abort();
    }

    if (request.resourceType() === 'script') {
      const response = await fetchScript(route);
      const body = response.body;
      if (fetchResponse) await applyCookies(request.url(), response.setCookie);
      if (isSbsdBundle(url)) {
        sbsdPath = url.pathname;
        sbsdBody = body;
        sbsdSrc = `${url.pathname}${url.search}`;
        log(
          `[sbsd] Bundle captured: ${body.length} bytes from ${url.pathname}`
        );
        // Handed back rather than stubbed, unlike the sensor below. The bundle
        // has to run: it is what emits the carrier POSTs this file rewrites.
        return handBack(route, response, body);
      }
      if (
        sensor === 'solver' &&
        body.length > 50_000 &&
        /\bbmak\b/.test(body)
      ) {
        bmMain = { body, url: request.url() };
        log(
          `[abck] Sensor script captured: ${body.length} bytes ` +
            `from ${url.pathname}`
        );
        // The real sensor must not run, or it posts its own telemetry
        // alongside the solver's.
        return route.fulfill({
          body: '/* solved out of process */',
          contentType: 'application/javascript',
        });
      }
      return handBack(route, response, body);
    }

    return route.continue();
  });

  /**
   * Send one sensor submission from inside the page.
   *
   * Playwright's own request context is not usable here: the submission has to
   * travel on the browser's connection, with its TLS fingerprint and its
   * cookie jar, or it is scored as a different visitor than the one the
   * telemetry describes.
   *
   * A navigation mid-session destroys the execution context this runs in.
   * Retrying cannot help — the session belongs to a document that no longer
   * exists — so the error is passed on as-is, with a line saying what it
   * actually means: `solveAbck()` ran against a document that was still going
   * to reload.
   */
  const sendFromPage = async (args: {
    body: string;
    headers: Record<string, string> | undefined;
    url: string;
  }): Promise<{ body: string; status: number }> => {
    try {
      return await page.evaluate(
        ({ body, headers, url }: typeof args) =>
          new Promise<{ body: string; status: number }>((done) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', url, true);
            xhr.withCredentials = true;
            for (const [name, value] of Object.entries(headers ?? {})) {
              try {
                xhr.setRequestHeader(name, value);
              } catch {
                // Forbidden header names are the browser's to set.
              }
            }
            xhr.onload = () =>
              done({ body: xhr.responseText, status: xhr.status });
            xhr.onerror = () => done({ body: '', status: 0 });
            xhr.send(body);
          }),
        args
      );
    } catch (error) {
      if (/Execution context was destroyed/u.test((error as Error).message)) {
        log(
          '[abck] The page navigated mid-session. On a property that runs ' +
            'SBSD the first document is a bootstrap that reloads itself once ' +
            'its carrier is answered — wait for the document you actually ' +
            'want before calling solveAbck().'
        );
      }
      throw error;
    }
  };

  /** Stateful lane: init, then answer every submission out of the page. */
  async function solveAbck(): Promise<void> {
    if (!bmMain) {
      throw new Error(
        sensor === 'page'
          ? 'attach() was given sensor: "page", so the sensor script was ' +
              'never captured — the page is answering _abck itself'
          : 'no _abck sensor script was captured on this page — ' +
              'if the property only runs SBSD, do not call solveAbck()'
      );
    }
    const captured = bmMain;
    log(
      `[abck] Opening session against ${captured.url} ` +
        `(_abck=${(await cookies())['_abck']?.split('~')[1] ?? 'absent'})`
    );
    const socket = new WebSocket(sessionUrl, {
      ...(solverApiKey ? { headers: { 'x-api-key': solverApiKey } } : {}),
    });
    await new Promise((resolve) =>
      socket.addEventListener('open', resolve, { once: true })
    );
    socket.send(
      JSON.stringify({
        cookies: await cookies(),
        // Scripts stripped: the solver models the document, and the sensor
        // source is sent separately as `script`.
        html: (await page.content()).replace(
          /<script\b[\s\S]*?<\/script>/giu,
          ''
        ),
        mode: 'abck',
        profileId: PROFILE_ID,
        script: captured.body,
        scriptUrl: captured.url,
        type: 'init',
        url: page.url(),
      })
    );

    return new Promise<void>((resolve, reject) => {
      // Let the event type come from undici's WebSocket rather than annotating
      // it: the DOM's MessageEvent is a different, incompatible declaration.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      socket.addEventListener('message', async (event) => {
        const message = JSON.parse(
          (event as { data: string }).data
        ) as SolverMessage;

        if (message.type === 'submission') {
          authorizedSensorBody = message.body ?? '';
          const result = await sendFromPage({
            body: message.body ?? '',
            headers: message.headers,
            url: message.url ?? '',
          });
          log(
            `[abck] Submission ${message.id}: ${result.status} ` +
              `(${result.body.length} bytes) -> ${message.url}`
          );
          socket.send(
            JSON.stringify({
              body: result.body,
              cookies: await cookies(),
              id: message.id,
              status: result.status,
              type: 'submission_response',
            })
          );
        }

        if (message.type === 'cookie_update') {
          log(
            `[abck] Cookie update: round=${message.round} ` +
              `rval=${message.rval} accepted=${message.accepted}`
          );
        }

        if (message.type === 'status' && message.state === 'accepted') {
          socket.close();
          resolve();
        }

        if (message.type === 'error') {
          socket.close();
          reject(new Error(message.message ?? 'solver reported an error'));
        }
      });

      socket.addEventListener('close', ({ code, reason }) => {
        reject(
          new Error(
            `session socket closed before acceptance: ${code} ${reason}`
          )
        );
      });
    });
  }

  return { carriersAnswered: () => answered, solveAbck };
}
