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
 * its HTML, its cookies, its resource timings, its runtime readings. They are
 * not portable. Replaying a ledger against a second document, a second tab or
 * a later load is a mismatch, and the server will not issue one for a snapshot
 * older than five minutes. Generate per document, use in order, discard.
 *
 * Rows are a capacity, not a promise: the response carries `expectedCap` rows
 * and the page emits as many carriers as it emits. Running out is a hard stop,
 * never a fallback to the native body — see `route.abort()` below.
 *
 * ## Reading this file
 *
 *   attach()          the entry point; installs the router, returns a handle
 *   generateLedger()  snapshots the live page and asks for the ledger
 *   readRealm()       the in-page snapshot, run once per document
 *   solveAbck()       the WebSocket lane, relayed through the page's own XHR
 */
import type { APIResponse, BrowserContext, Page, Route } from 'playwright-core';
import { WebSocket } from 'undici';

import { isSbsdBundle } from '#src/akamai/sbsd-bundle.js';
import { PROFILE, PROFILE_ID } from '#src/profile.js';
import { checkRateLimit } from '#src/rate-limit.js';
import { solverBaseUrl, solverWsUrl } from '#src/solver-url.js';

/** The request schema this client speaks. The server rejects anything else. */
const LEDGER_REQUEST_SCHEMA = 'akamai-sbsd-ledger-request/v3';

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

/**
 * The page-side globals `readRealm` reads.
 *
 * Declared rather than taken from the DOM lib for one boring reason: this is a
 * Node project, and ESLint's node-builtins rule flags a bare `navigator` or
 * `sessionStorage` as an experimental Node global. Reading them off one
 * explicitly-typed handle keeps the identifiers out of module scope and makes
 * the list of things the snapshot touches readable in one place.
 */
/* eslint-disable no-unused-vars -- function-type parameters */
type BrowserRealm = {
  crypto: {
    subtle: {
      digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer>;
    };
  };
  document: Document;
  history: { length: number };
  navigator: {
    connection: {
      downlink: number;
      effectiveType: string;
      rtt: number;
      saveData: boolean;
    };
    deviceMemory?: number;
    hardwareConcurrency: number;
    languages: readonly string[];
  };
  performance: {
    memory: {
      jsHeapSizeLimit: number;
      totalJSHeapSize: number;
      usedJSHeapSize: number;
    };
  } & Performance;
  screen: {
    availHeight: number;
    availLeft: number;
    availTop: number;
    availWidth: number;
    colorDepth: number;
    height: number;
    pixelDepth: number;
    width: number;
  };
  sessionStorage: { getItem: (key: string) => null | string };
  speechSynthesis: { getVoices: () => Array<{ localService: boolean }> };
  window: {
    devicePixelRatio: number;
    innerHeight: number;
    innerWidth: number;
    outerHeight: number;
    outerWidth: number;
    screenX: number;
    screenY: number;
  };
};
/* eslint-enable no-unused-vars */

/** What only the live page can answer. The identity is *not* in here. */
type RealmSnapshot = {
  documentCookie: string;
  resourceEntries: unknown[];
  runtime: Record<string, unknown>;
  timeOriginMs: number;
};

/**
 * The identity the ledger request declares as `profile.overrides`.
 *
 * Declared, not measured — and this is the one thing in this file most likely
 * to be "fixed" into a live read. Do not. Playwright's viewport emulation
 * (`Emulation.setDeviceMetricsOverride`, which `src/akamai/identity.ts`
 * installs) leaves `screen.availLeft` and `screen.availTop` at 0 and
 * `availHeight` equal to `height`. On macOS that is impossible — the menu bar
 * is always there — and a payload built from those readings describes a
 * browser that cannot exist. The symptom is not an error: it is `_abck` at
 * `~-1~` for as many rounds as you are willing to give it.
 *
 * So this sends the same declared identity `sensor/solver.ts` sends over the
 * session socket, from the same `src/profile.ts`. The two lanes then agree
 * with each other, which is the property that actually matters.
 */
const TELEMETRY_PROFILE = {
  deviceMemory: PROFILE.deviceMemory,
  hardwareConcurrency: PROFILE.hardwareConcurrency,
  languages: PROFILE.languages,
  screen: PROFILE.screen,
  timezone: PROFILE.timezone,
  timezoneOffsetMinutes: PROFILE.timezoneOffsetMinutes,
};

/**
 * Wait for the bundle to write its tab id before the realm is snapshotted.
 *
 * `sessionStorage.ak_bm_tab_id` only exists once the bundle has run, and the
 * server rejects a snapshot without it — `422 invalid-carrier`, because a
 * document that has not got one is not a document that could have emitted a
 * carrier. Holding the first carrier is *usually* enough on its own: the
 * bundle writes the key before it posts. Usually is not always. On a slower
 * machine the ledger request goes out several seconds after the bundle loads
 * and the key is always there; on a fast CI runner the same request left ~2s
 * in and was refused every time.
 *
 * Bounded, and failure here is deliberately not fatal: if the key really never
 * arrives, the server's refusal names the reason better than a guess made
 * here would.
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
    // Bounded wait elapsed. Let the request go and be refused on its merits.
  }
};

/**
 * Everything the ledger request needs that only the page can answer.
 *
 * Runs as one `page.evaluate` because it has to be one instant: the resource
 * timings, the heap readings and the DOM inventory are compared against each
 * other, and reading them across three round-trips describes a page that never
 * existed.
 */
const readRealm = (page: Page): Promise<RealmSnapshot> =>
  page.evaluate(async () => {
    const realm = globalThis as unknown as BrowserRealm;
    const { crypto, document, history, performance, speechSynthesis } = realm;
    // This body runs in the browser, not in Node, so the node-builtins rule
    // is reading these two as Node's own experimental globals of the same
    // name. They are the DOM's, and they have been there for twenty years.
    /* eslint-disable n/no-unsupported-features/node-builtins */
    const nav = realm.navigator;
    const session = realm.sessionStorage;
    /* eslint-enable n/no-unsupported-features/node-builtins */
    const { memory } = performance;
    const { connection } = nav;
    const descriptor = Object.getOwnPropertyDescriptor(
      Function.prototype,
      'toString'
    ) as { value: () => string } & PropertyDescriptor;
    const toString = descriptor.value;

    // Read Function.prototype.toString's source through a pristine realm, so a
    // wrapper on this page cannot describe itself as native. A child iframe
    // gets its own copy of the intrinsics; asking it to stringify *our*
    // toString is the one reading a patched page cannot forge.
    const probe = document.createElement('iframe');
    probe.setAttribute('sandbox', 'allow-same-origin');
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const source = (
      probe.contentWindow as typeof globalThis & Window
    ).Function.prototype.toString.call(toString);
    probe.remove();

    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(source)
    );
    const voices = speechSynthesis.getVoices();

    return {
      documentCookie: document.cookie,
      resourceEntries: performance.getEntriesByType('resource').map((e) => ({
        duration: e.duration,
        initiatorType: (e as PerformanceResourceTiming).initiatorType,
        name: e.name,
        startTime: e.startTime,
      })),
      runtime: {
        connectionInfo: {
          downlink: connection.downlink,
          effectiveType: connection.effectiveType,
          rtt: connection.rtt,
          saveData: connection.saveData,
        },
        domResourceInventory: {
          capturedAtPerformanceMs: performance.now(),
          imgSrc: [...document.querySelectorAll('img[src]')].map((e) =>
            e.getAttribute('src')
          ),
          linkHref: [...document.querySelectorAll('link[href]')].map((e) =>
            e.getAttribute('href')
          ),
          scriptSrc: [...document.querySelectorAll('script[src]')].map((e) =>
            e.getAttribute('src')
          ),
        },
        functionToString: {
          descriptor: {
            configurable: descriptor.configurable === true,
            enumerable: descriptor.enumerable === true,
            writable: descriptor.writable === true,
          },
          length: toString.length,
          name: toString.name,
          prototypeKind:
            (toString as { prototype?: unknown }).prototype === undefined
              ? 'undefined'
              : 'defined',
          sourceClass: /^function\s+.*\(\)\s*\{\s*\[native code\]\s*\}$/u.test(
            source.replace(/\s+/gu, ' ').trim()
          )
            ? 'native'
            : 'wrapped',
          sourceSha256: [...new Uint8Array(digest)]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
        },
        historyLength: history.length,
        memoryInfo: {
          jsHeapSizeLimit: memory.jsHeapSizeLimit,
          totalJSHeapSize: memory.totalJSHeapSize,
          usedJSHeapSize: memory.usedJSHeapSize,
        },
        sessionStorage: { akBmTabId: session.getItem('ak_bm_tab_id') },
        speechSynthesisVoices: {
          localCount: voices.filter((v) => v.localService).length,
          totalCount: voices.length,
        },
      },
      timeOriginMs: performance.timeOrigin,
    };
  }) as Promise<RealmSnapshot>;

export function attach(page: Page, opts: AttachOptions): AkamaiHandle {
  const { host, origin, sensor = 'solver', solverApiKey } = opts;
  const context: BrowserContext = page.context();
  const ledgerUrl = new URL(
    '/akamai/sbsd/generate-session',
    solverBaseUrl(host)
  ).href;
  const sessionUrl = solverWsUrl(host, '/akamai/session');

  /** The document as served, read off the response — never re-fetched. */
  let servedHtml = '';
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
   * The document is READ, never re-fetched.
   *
   * `route.fetch()` replays a request from Playwright's own context, whose TLS
   * fingerprint is not the browser's. Akamai answers a replayed *navigation*
   * with a 403 "Page Reference Code" page, which carries none of the bundles
   * the rest of this depends on. Scripts survive that replay; navigations do
   * not — so the HTML is taken from the response the browser itself received.
   */
  page.on('response', (response) => {
    const request = response.request();
    if (request.resourceType() !== 'document') return;
    if (request.frame() !== page.mainFrame()) return;
    // A new main-frame document is a new snapshot, so the ledger issued for
    // the last one is retired here rather than carried across the bootstrap's
    // self-reload. The rows are computed from a document's HTML, cookies,
    // timings and runtime readings; feeding leftovers to the carriers of the
    // page that replaced it describes a visitor that was never on either.
    ledger = null;
    cursor = 0;
    void response.text().then(
      (text) => {
        servedHtml = text;
      },
      () => {
        /* a redirect or an aborted navigation has no body to read */
      }
    );
  });

  /** One POST, `expectedCap` rows, for the document that is live right now. */
  async function generateLedger(): Promise<LedgerRow[]> {
    await waitForTabId(page);
    const realm = await readRealm(page);
    const response = await fetch(ledgerUrl, {
      body: JSON.stringify({
        bundle: { scriptSrc: sbsdSrc, source: sbsdBody },
        document: {
          // Historical field name: this is document.cookie, NOT the HTTP
          // header. The distinction matters — the httpOnly cookies in the jar
          // are deliberately not part of what the page can see.
          cookieHeader: realm.documentCookie,
          epochMs: Math.round(realm.timeOriginMs),
          html: servedHtml,
          resourceEntries: realm.resourceEntries,
          runtime: realm.runtime,
          url: page.url(),
        },
        profile: {
          chromeFullVersion: PROFILE.chromeFullVersion,
          id: PROFILE_ID,
          overrides: TELEMETRY_PROFILE,
        },
        schema: LEDGER_REQUEST_SCHEMA,
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
      // The receipt is the useful half of a refusal: `error.message` is the
      // same sentence for every code, while the receipt names the input that
      // could not be reconciled. Without it a CI failure is unactionable.
      throw new Error(
        `SBSD ledger refused (${response.status}): ` +
          `${ledger.error?.code ?? 'unknown'} — ` +
          `${ledger.error?.message ?? ''} ` +
          `receipt=${JSON.stringify(ledger.receipt ?? null).slice(0, 600)}`
      );
    }
    log(
      `[sbsd] Ledger issued: cap=${ledger.expectedCap} nonce=${ledger.runNonce}`
    );
    return ledger.submissions ?? [];
  }

  /**
   * Give the page a body we have already decoded.
   *
   * Two headers have to go. `content-encoding` still says `br`, and handing
   * that back with decoded text makes the browser brotli-decode plain UTF-8 —
   * the response dies and the site renders its own error page. `set-cookie`
   * goes because `fulfill` takes ONE header map: a response setting four
   * cookies would keep one and silently lose three, and `route.fetch` has
   * already put them all in the jar itself.
   */
  const handBack = async (
    route: Route,
    response: APIResponse,
    body: string
  ): Promise<void> => {
    const headers = { ...response.headers() };
    delete headers['content-encoding'];
    delete headers['content-length'];
    delete headers['set-cookie'];
    await route.fulfill({ body, headers, status: response.status() });
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
      const response = await route.fetch();
      const body = await response.text();
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
