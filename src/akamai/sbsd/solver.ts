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
   * The watched hosts seen so far, and what each has.
   *
   * A peer realm only appears once the browser has been there, so this is a
   * running view rather than a fixed list.
   */
  realms: () => Array<{
    answered: number;
    hasSensor: boolean;
    host: string;
  }>;
  /**
   * Resolves when `_abck` is accepted. Call it once the document you actually
   * want is loaded — not during the bootstrap. Rejects if the `_abck` sensor
   * script was never seen, which on a page that only runs SBSD is expected.
   *
   * `host` picks the realm on a property that runs more than one; it defaults
   * to the origin.
   */
  // eslint-disable-next-line no-unused-vars -- function-type parameters
  solveAbck: (opts?: SolveAbckOptions) => Promise<void>;
  /**
   * Solve every host that has a sensor, in turn, and return the ones solved.
   *
   * The multi-realm entry point. A host that cannot be solved is logged rather
   * than thrown, so one unreachable realm does not hide the rest.
   */
  // eslint-disable-next-line no-unused-vars -- function-type parameters
  solveAll: (opts?: SolveAbckOptions) => Promise<string[]>;
};

export type AttachOptions = {
  /**
   * Fetch intercepted script requests with this instead of Playwright's
   * `route.fetch`. Only needed for browsers where `route.fetch` is
   * unreliable — `src/mitm.ts` exposes exactly this shape, and
   * `src/akamai/sbsd/aircanada-lightpanda.ts` passes it, for the same reason
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
   * Every host to treat as protected, when a property runs more than one.
   *
   * A property can serve its pages, its application and its API from separate
   * first-party hosts, each behind the same edge and each with its own
   * `_abck`. ana.co.jp is three: `www`, `aswbe`, `space`. Watching only
   * `origin` leaves the realm the content is actually behind untouched.
   *
   * Defaults to the origin's host, which is the single-realm behaviour.
   */
  protectedHosts?: readonly (RegExp | string)[];
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

/** Per-call options for {@link AkamaiHandle.solveAbck}. */
export type SolveAbckOptions = {
  /** Which realm to solve. Defaults to the origin's host. */
  host?: string;
  /**
   * How long the lane may stay quiet before `waitForAcceptance: false`
   * returns. Default 15000ms.
   *
   * A quiet window rather than a deadline: the gap between two rounds is the
   * solver's think time plus a round trip, and a fixed deadline cuts whichever
   * round straddles it. Measured on a live ladder, consecutive gaps were 1.6s,
   * 2.2s, 0.9s, 5.9s, 4.7s and 9.5s as the bundle backed off.
   */
  idleMs?: number;
  /**
   * Whether to hold until the solver reports `_abck` accepted. Default `true`.
   *
   * `false` returns once a round has been answered and the lane has been quiet
   * for `idleMs` — the cookie is whatever it is, usually still `~-1~`.
   *
   * That is the right mode on a property with no protected request to assert
   * clearance against, where acceptance is not observable from the client and
   * the default never returns. ana.co.jp's `www` is exactly that: it has not
   * reached `~0~` in any session measured, while the booking engine it hands
   * off to accepts in two rounds.
   */
  waitForAcceptance?: boolean;
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
/**
 * A real `document.cookie` getter never repeats a name — the jar it reads
 * from has at most one entry per (name, domain, path), and the browser
 * exposes only the name and value, so two entries that both apply to the
 * current document collapse into whichever is left standing. On Lightpanda,
 * a cookie set once without a `Domain` attribute and again with one (which is
 * exactly what an Akamai bundle clearing then reissuing its own tracking
 * cookie looks like) can end up as two internally, and the getter has been
 * observed to return both: `bm_lso=; bm_lso=<value>`. The ledger endpoint
 * refuses a request with a repeated name outright rather than guess which one
 * is current, so it is resolved here instead, keeping the last occurrence —
 * the one a set-after-clear sequence means to leave in place.
 */
const dedupeCookieHeader = (cookieHeader: string): string => {
  const seen = new Map<string, string>();
  for (const pair of cookieHeader.split(';')) {
    const index = pair.indexOf('=');
    if (index < 1) continue;
    seen.set(pair.slice(0, index).trim(), pair.trim());
  }
  return [...seen.values()].join('; ');
};

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
  return {
    ...state,
    documentCookie: dedupeCookieHeader(state.documentCookie),
    html,
  };
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

  /**
   * Everything that was one-per-attach is now one-per-host.
   *
   * These were nine `let`s scoped to the origin. A peer realm running its own
   * SBSD needs its own bundle, its own ledger and its own cursor: sharing them
   * is what makes a peer's carrier draw a row from a document it was never on,
   * which the server rejects as a snapshot mismatch.
   */
  type HostState = {
    /** Carriers answered with a row, on this host. */
    answered: number;
    /** The one sensor body the solver authored; anything else is native. */
    authorizedSensorBody: null | string;
    /** Kept across the bootstrap's self-reload, so the second load can use it. */
    bmMain: { body: string; url: string } | null;
    /**
     * Rows are handed out one at a time, in order. `cursor++` across concurrent
     * route handlers is not enough on its own — the awaits between taking a row
     * and continuing the route let a later carrier overtake an earlier one, and
     * SBSD ordering is FIFO by construction.
     */
    carrierQueue: Promise<unknown>;
    cursor: number;
    /**
     * The in-flight or completed ledger request, memoized as a *promise*.
     *
     * A page emits its carriers concurrently, so two of them can both find a
     * not-yet-populated `rows` and each ask for a ledger. That is not a wasted
     * request, it is a wrong answer: the second ledger replaces the first, the
     * cursor carries on into it, and the page ends up submitting row 0 of one
     * document snapshot followed by rows 1 and 2 of another.
     */
    ledger: null | Promise<LedgerRow[]>;
    sbsdBody: null | string;
    /**
     * The path the bundle was served from, which is also the path its carriers
     * POST to. Learned from the bundle request, and there is no race in
     * learning it late: a carrier cannot fire before the bundle that emits it
     * has loaded.
     */
    sbsdPath: null | string;
    /** The raw `src` attribute, `?v=` included: it seeds the bundle's codec. */
    sbsdSrc: null | string;
  };

  const originHost = new URL(origin).host;
  const watched: readonly (RegExp | string)[] = opts.protectedHosts ?? [
    originHost,
  ];
  const isProtected = (candidate: string): boolean =>
    watched.some((p) =>
      typeof p === 'string' ? p === candidate : p.test(candidate)
    );

  const sites = new Map<string, HostState>();
  const siteFor = (hostname: string): HostState => {
    let site = sites.get(hostname);
    if (!site) {
      site = {
        answered: 0,
        authorizedSensorBody: null,
        bmMain: null,
        carrierQueue: Promise.resolve(),
        cursor: 0,
        ledger: null,
        sbsdBody: null,
        sbsdPath: opts.sbsdPath ?? null,
        sbsdSrc: null,
      };
      sites.set(hostname, site);
    }
    return site;
  };
  /** The document host's state, which is what the single-realm API acts on. */
  const originSite = siteFor(originHost);

  /**
   * The jar for one host. Scoped, because a session opened for a peer host
   * carrying the document host's cookies describes a visitor that does not
   * exist: the peer's own `_abck` is the cookie being moved.
   */
  const cookies = async (
    hostname: string = originHost
  ): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await context.cookies(`https://${hostname}`)).map((c) => [
        c.name,
        c.value,
      ])
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
    // The host that just committed a document, not every host: a peer realm's
    // ledger is bound to ITS document, and clearing it because a different
    // host navigated throws away rows its carriers are still queued against.
    let documentHost: string;
    try {
      documentHost = new URL(request.url()).host;
    } catch {
      return;
    }
    const site = sites.get(documentHost);
    if (!site) return;
    site.ledger = null;
    site.cursor = 0;
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
  async function generateLedger(site: HostState): Promise<LedgerRow[]> {
    await waitForTabId(page);
    const realm = await readRealm(page, readHtml);
    const response = await fetch(ledgerUrl, {
      body: JSON.stringify({
        bundle: { scriptSrc: site.sbsdSrc, source: site.sbsdBody },
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
    if (cookies.length === 0) return;
    // Clear any existing cookie of the same name first, regardless of its
    // domain/path. `addCookies` only overwrites an exact (name, domain,
    // path) match, and a value set here without the domain Lightpanda's own
    // jar already scoped it under (e.g. a clearing `bm_lso=;` with no
    // `Domain` attribute, replayed against the bare hostname while the live
    // cookie sits under `.aircanada.com`) lands as a second entry instead of
    // replacing the first. `document.cookie` then reports the name twice,
    // and the ledger endpoint refuses the whole request over it rather than
    // guess which one you meant.
    for (const name of new Set(cookies.map((c) => c.name))) {
      await context.clearCookies({ name });
    }
    await context.addCookies(cookies);
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

  /**
   * Headers for a `route.continue()`, with a duplicate `cookie` name
   * resolved. `dedupeCookieHeader` was written for the ledger snapshot, but
   * the same Lightpanda quirk reaches further than that snapshot: a cookie
   * the SBSD bundle's own in-page `document.cookie =` writes (not
   * `applyCookies` — this is JS running in the page, entirely outside this
   * file) lands in Lightpanda's real outgoing `cookie` header too, not just
   * in what `document.cookie` reads back. A carrier or sensor submission
   * that goes out with `bm_lso=; bm_lso=<value>` on the wire has been
   * observed to get "Access Denied" immediately — a malformed cookie header
   * is itself a signal, independent of how good the payload behind it is.
   */
  const dedupedContinueHeaders = async (
    route: Route
  ): Promise<Record<string, string>> => {
    const headers = await route.request().allHeaders();
    if (headers['cookie'])
      headers['cookie'] = dedupeCookieHeader(headers['cookie']);
    return headers;
  };

  /*
   * Every request, filtered by host — not `${origin}/**`.
   *
   * An origin-scoped pattern cannot see a peer realm, because a peer realm
   * is a different origin. Anything outside `protectedHosts` is continued
   * untouched, which is the same third-party behaviour as before.
   */
  void page.route('**/*', async (route) => {
    const request = route.request();
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return route.continue();
    }
    if (!isProtected(url.host)) return route.continue();
    const site = siteFor(url.host);
    const post = request.method() === 'POST';

    // SBSD carrier. The first one is held while the site.ledger is generated, which
    // is also what makes the snapshot legal: `sessionStorage.ak_bm_tab_id`
    // only exists once the bundle has run.
    if (post && site.sbsdPath !== null && url.pathname === site.sbsdPath) {
      const mine = site.carrierQueue.then(async () => {
        site.ledger ??= generateLedger(site);
        const rows = await site.ledger;
        const row = rows[site.cursor++];
        // Out of rows: fail closed. Letting the native body through here would
        // hand Akamai a payload from an uninstrumented page alongside ours.
        if (!row) return route.abort();
        log(`[sbsd] Row ${row.index}: ${row.bytes} bytes`);
        site.answered++;
        return route.continue({
          headers: await dedupedContinueHeaders(route),
          postData: row.body,
        });
      });
      // The queue must not stay rejected, or every later carrier inherits the
      // first failure; the awaited promise still surfaces it to this caller.
      site.carrierQueue = mine.catch(() => undefined);
      return mine;
    }

    // `_abck` sensor POST. Only the body the solver just authored gets
    // through; anything else is the native sensor talking, and is dropped.
    if (
      post &&
      sensor === 'solver' &&
      site.bmMain &&
      url.pathname === new URL(site.bmMain.url).pathname
    ) {
      if (request.postData() === site.authorizedSensorBody) {
        site.authorizedSensorBody = null;
        return route.continue({ headers: await dedupedContinueHeaders(route) });
      }
      log(`[abck] Dropped a native sensor POST to ${url.pathname}`);
      return route.abort();
    }

    if (request.resourceType() === 'script') {
      const response = await fetchScript(route);
      const body = response.body;
      // Cookies go on *after* the route settles, not before. On Lightpanda,
      // `context.addCookies` while this request is still a pending
      // `Fetch.requestPaused` deadlocks silently — the fulfill this same
      // route is waiting to send never goes out, because addCookies is
      // waiting on the browser and the browser is waiting on the fulfill.
      // `src/akamai/sensor/solver.ts` already learned this the same way:
      // fulfill first, apply cookies after.
      const applyResponseCookies = (): Promise<void> =>
        fetchResponse
          ? applyCookies(request.url(), response.setCookie)
          : Promise.resolve();
      if (isSbsdBundle(url)) {
        site.sbsdPath = url.pathname;
        site.sbsdBody = body;
        site.sbsdSrc = `${url.pathname}${url.search}`;
        log(
          `[sbsd] Bundle captured: ${body.length} bytes from ${url.pathname}`
        );
        // Handed back rather than stubbed, unlike the sensor below. The bundle
        // has to run: it is what emits the carrier POSTs this file rewrites.
        await handBack(route, response, body);
        return applyResponseCookies();
      }
      if (
        sensor === 'solver' &&
        body.length > 50_000 &&
        /\bbmak\b/.test(body)
      ) {
        site.bmMain = { body, url: request.url() };
        log(
          `[abck] Sensor script captured: ${body.length} bytes ` +
            `from ${url.pathname}`
        );
        // The real sensor must not run, or it posts its own telemetry
        // alongside the solver's.
        await route.fulfill({
          body: '/* solved out of process */',
          contentType: 'application/javascript',
        });
        return applyResponseCookies();
      }
      await handBack(route, response, body);
      return applyResponseCookies();
    }

    return route.continue({ headers: await dedupedContinueHeaders(route) });
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

  /**
   * Stateful lane: init, then answer every submission out of the page.
   *
   * `host` picks the realm. It defaults to the origin, which is the
   * single-realm behaviour; `solveAll()` passes each host it found a sensor on.
   */
  async function solveAbck(solveOpts?: SolveAbckOptions): Promise<void> {
    const site = siteFor(solveOpts?.host ?? originHost);
    if (!site.bmMain) {
      throw new Error(
        sensor === 'page'
          ? 'attach() was given sensor: "page", so the sensor script was ' +
              'never captured — the page is answering _abck itself'
          : 'no _abck sensor script was captured on this page — ' +
              'if the property only runs SBSD, do not call solveAbck()'
      );
    }
    const captured = site.bmMain;
    log(
      `[abck] Opening session against ${captured.url} ` +
        `(_abck=${(await cookies(site === originSite ? originHost : new URL(captured.url).host))['_abck']?.split('~')[1] ?? 'absent'})`
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

    const waitForAcceptance = solveOpts?.waitForAcceptance ?? true;
    const idleMs = solveOpts?.idleMs ?? 15_000;
    return new Promise<void>((resolve, reject) => {
      let rounds = 0;
      let settled = false;
      let idleTimer: null | ReturnType<typeof setTimeout> = null;
      /**
       * The `waitForAcceptance: false` exit.
       *
       * Armed only once a round has been answered, so a lane where nothing ever
       * happened still hangs rather than reporting success — that failure stays
       * as loud as it was. The timer resets on every round, which makes this a
       * quiet window and not a deadline.
       */
      const armIdle = (): void => {
        if (waitForAcceptance || settled || rounds === 0) return;
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          log(`[abck] Lane ended on the idle timer after ${rounds} round(s)`);
          socket.close();
          resolve();
        }, idleMs);
        idleTimer.unref?.();
      };
      // Let the event type come from undici's WebSocket rather than annotating
      // it: the DOM's MessageEvent is a different, incompatible declaration.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      socket.addEventListener('message', async (event) => {
        const message = JSON.parse(
          (event as { data: string }).data
        ) as SolverMessage;

        if (message.type === 'submission') {
          site.authorizedSensorBody = message.body ?? '';
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
          rounds += 1;
          armIdle();
          log(
            `[abck] Cookie update: round=${message.round} ` +
              `rval=${message.rval} accepted=${message.accepted}`
          );
        }

        if (message.type === 'status' && message.state === 'accepted') {
          if (settled) return;
          settled = true;
          socket.close();
          resolve();
        }

        if (message.type === 'error') {
          if (settled) return;
          settled = true;
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

  return {
    carriersAnswered: () =>
      [...sites.values()].reduce((total, site) => total + site.answered, 0),
    /** What each watched host has, so a caller can see which realms exist. */
    realms: () =>
      [...sites.entries()].map(([hostname, site]) => ({
        answered: site.answered,
        hasSensor: site.bmMain !== null,
        host: hostname,
      })),
    solveAbck,
    /**
     * Solve every host that has a sensor, in turn.
     *
     * A peer's sensor only appears once the browser has been there, so this is
     * called again wherever the flow reaches somewhere new. Returns the hosts
     * it solved; one unreachable realm is logged rather than thrown, so it does
     * not hide the rest.
     */
    solveAll: async (solveOpts?: SolveAbckOptions) => {
      const solved: string[] = [];
      for (const [hostname, site] of sites) {
        if (site.bmMain === null) continue;
        try {
          await solveAbck({ ...solveOpts, host: hostname });
          solved.push(hostname);
        } catch (error) {
          log(`[abck] ${hostname}: ${(error as Error).message}`);
        }
      }
      return solved;
    },
  };
}
