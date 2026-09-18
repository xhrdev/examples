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
import type {
  APIResponse,
  BrowserContext,
  CDPSession,
  Frame,
  Page,
  Route,
  WebSocketRoute,
} from 'playwright-core';
import { WebSocket } from 'undici';

import { isSbsdBundle } from '#src/akamai/sbsd-bundle.js';
import { PROFILE_ID } from '#src/profile.js';
import { checkRateLimit } from '#src/rate-limit.js';
import { solverBaseUrl, solverWsUrl } from '#src/solver-url.js';

/**
 * Akamai's own URL convention for its third channel.
 *
 * `/akam/<n>/<hex>` serves a 26 KB script that POSTs a 23-field device
 * signature — a canvas hash, the window geometry, the timezone, a
 * `navigator` dump including `webdriver`, and an automation-scanner verdict —
 * to `/akam/<n>/pixel_<hex>`. It is under the sensor's size floor and carries
 * no `bmak`, so no content test finds it. This is a product convention rather
 * than a per-build stem: the hex rotates per session, `/akam/<n>/` does not.
 */
const AKAMAI_PIXEL_PREFIX = /^\/akam\/\d+\//u;

/**
 * A script URL that could be a challenge script, judged without fetching it.
 *
 * Same move as {@link isSbsdBundle}, which decides from `?v=<uuid>` alone: the
 * point is to classify before the body exists, because fetching IS the cost.
 * `serveScript` replays through `route.fetch()` on Playwright's Node stack,
 * whose TLS fingerprint is not the browser's, so every script it touches is a
 * request carrying the session's cookies with the wrong handshake. That was
 * tolerable when the gate was the document host; with a whole domain in scope
 * it is every script on every host.
 *
 * The discriminator is the file extension, and it holds on every sample we
 * have. Akamai's stems are extensionless:
 *
 *   /IhxlY0/ud4A/5FPVs/fr05i3/PtK/iaiwkLESENEXtSaiOV/CzlpAQ/PjENfXpO/MnoB
 *   /hnVkm3MUWSGqH3t-j5Fb/VE1bDhNE1aumGk9iY7/SWMRIi4B/W2V4PR/9KZw4
 *   /M49sGaoxWgAbHauqkLh142hkfX0/2zXELhmu7bi3/P11bVy8/Gl5qNh/5-b1UM
 *   /akam/13/4ae44475
 *
 * and application scripts are not: `asw-main.bundle.js`, `main.min.js`,
 * `jquery-3.4.1.min.js`, `config-ja.js`.
 *
 * The cost of being wrong is bounded and loud rather than silent. A build that
 * served its sensor at a path ending `.js` would not be adopted by content —
 * but an already-marked path, a bundle nonce and a known sensor path are all
 * still served regardless of extension, and `ready` rejects when the window
 * closes with a channel undiscovered. A miss is a hard stop, not a leak.
 */
const SCRIPT_FILE_EXTENSION = /\.[a-z0-9]{1,8}$/iu;
const mayBeChallengeScript = (url: URL): boolean =>
  !SCRIPT_FILE_EXTENSION.test(url.pathname);

/** Methods that carry a request body. */
const BODY_METHODS = new Set(['PATCH', 'POST', 'PUT']);

/**
 * Cookie names only Akamai sets. A response from a third-party host carrying
 * one names that host as part of a challenge channel — an effect, not a name
 * or a stem, so it survives a build rotation.
 *
 * Deliberately not applied to `origin`: Akamai's edge sets `_abck` and
 * `bm_sz` on the property's ordinary pages, so on the document host this
 * matches everything and would have the router deny the application's own
 * traffic.
 */
const AKAMAI_COOKIE =
  /^(?:_abck|ak_bmsc|bm_lso|bm_mi|bm_s|bm_so|bm_sv|bm_sz|sbsd|sbsd_o)$/u;

/** What a captured sensor script is replaced with, so it cannot run. */
const SENSOR_STUB = '/* solved out of process */';

/**
 * How many bytes of script the router will hold.
 *
 * It keeps every script it fetches from the property so a second request for
 * the same path can be answered without putting that request's query string
 * on the wire. A property whose scripts exceed this simply refetches the
 * overflow; nothing breaks, the cache just stops growing.
 */
const SCRIPT_CACHE_BYTES = 32 * 1024 * 1024;

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
   * Retire the router. The routes live on the BrowserContext, not on the
   * Page, so `page.unrouteAll()` does not remove them and Playwright prints
   * the intercepted response back as an unhandled route-callback error when
   * the browser goes. Call this before closing.
   */
  dispose: () => Promise<void>;
  /**
   * Resolves once the router is mounted. **Await this before the first
   * navigation.**
   *
   * `attach()` is synchronous and route installation is not. The HTTP route
   * survives the gap, but `routeWebSocket` injects a page-side interceptor at
   * document start: a main frame that began navigating before it landed opens
   * its sockets unrouted, which is measurable as exactly one realm — the one
   * that matters most — escaping WebSocket interception.
   */
  installed: Promise<void>;
  /**
   * Resolves once every channel this property runs has been discovered, and
   * **rejects** when the discovery window closes without them.
   *
   * This is the fail-closed half. Discovery is a content test on somebody
   * else's build, and the failure mode it used to have was silence: a bundle
   * with a different cache-buster, or a sensor that spells its global some
   * other way, left `attach()` a transparent proxy that emitted byte-identical
   * traffic to having no solver at all. Nothing said so. Now something does.
   *
   * It also rejects if conservation breaks — see `stats()`.
   */
  ready: Promise<void>;
  /** Every host discovery has found a challenge channel on. */
  realms: () => Array<{
    accepted: boolean;
    hasAbck: boolean;
    hasSbsd: boolean;
    host: string;
    /** `_abck` submissions answered, which is how a fair chance is measured. */
    rounds: number;
  }>;
  /**
   * Walk the `_abck` rounds. Call it once the document you actually want is
   * loaded — not during the bootstrap. Rejects if the `_abck` sensor script
   * was never seen, which on a page that only runs SBSD is expected.
   *
   * By default it resolves only when the solver reports the cookie accepted.
   * Pass `{ waitForAcceptance: false }` to return as soon as the lane goes
   * quiet instead — see `SolveAbckOptions`.
   */
  // eslint-disable-next-line no-unused-vars -- name documents a function type
  solveAbck: (opts?: SolveAbckOptions) => Promise<void>;
  /**
   * Solve every host that has a sensor and has not been solved yet, in turn.
   *
   * This is the multi-realm entry point. A peer host's sensor only appears
   * once the browser has been there — ANA's booking engine serves its own
   * after the search click, long after the origin's lane has returned — so
   * this is called again at each point the flow reaches somewhere new.
   *
   * Returns the hosts it solved. A host it could not solve is logged, not
   * thrown, so one unreachable realm does not hide the rest.
   */
  // eslint-disable-next-line no-unused-vars -- name documents a function type
  solveAll: (opts?: SolveAbckOptions) => Promise<string[]>;
  /** Live egress counters. See `EgressStats`. */
  stats: () => EgressStats;
};

export type AttachOptions = {
  /**
   * How long discovery gets before `ready` rejects, from the first request to
   * `origin` rather than from `attach()`, so installing the router early is
   * free. Default 45s, comfortably past the bootstrap's self-reload.
   */
  discoveryTimeoutMs?: number;
  /**
   * `host=` from .env, in either form `src/solver-url.ts` accepts. Both the
   * ledger POST and the session socket are derived from it, so a TLS solver
   * gets `https://` and `wss://` together.
   */
  host: string;
  /**
   * The property to solve, e.g. `https://www.hilton.com`. Challenge-endpoint
   * discovery is scoped to this host; `akamaiHosts` extends it.
   */
  origin: string;
  /**
   * Extra hosts to bring into discovery scope, by name or by pattern.
   *
   * A *protected* host is not the same thing as an `akamaiHosts` entry, and
   * the difference is the whole point. `akamaiHosts` says "everything here is
   * a challenge"; this says "watch this host the way the origin is watched" —
   * adopt and stub its sensor, adopt its bundle, replace its carrier bodies,
   * and deny a POST to an endpoint discovery has actually named. Its own
   * application traffic keeps working.
   *
   * A string matches the host itself and any subdomain of it, so
   * `['ana.co.jp']` covers `www.ana.co.jp` and `aswbe.ana.co.jp` together.
   * The origin's host is always in scope, and a host that sets an Akamai
   * cookie is added at runtime, so this is for a host that serves a challenge
   * script before it sets anything.
   */
  protectedHosts?: readonly (RegExp | string)[];
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

/**
 * What the router counted. Every field is a count of requests, so the pair
 * that matters — `postsAllowed` against `solverBodiesIssued` — is an
 * *effect* assertion: it does not depend on recognising a host, a path or a
 * build, and a mismatch means a POST the solver did not write reached a
 * challenge endpoint.
 */
export type EgressStats = {
  /** Requests the worker-realm guard refused; no route API can see these. */
  blockedInWorkerRealm: number;
  /**
   * The same counters split by host, for the hosts that had any traffic.
   *
   * The totals above are an aggregate and an aggregate cannot be audited: two
   * realms pooled into one conservation pair cancel, so a realm that leaked a
   * POST and a realm that authored a body it never sent sum to a balanced
   * total. The check runs per host; this is what it saw.
   */
  byHost: Record<
    string,
    {
      carriersAnswered: number;
      postsAllowed: number;
      solverBodiesIssued: number;
    }
  >;
  /** Carrier POSTs answered with a ledger row. */
  carriersAnswered: number;
  /**
   * Bodyless requests to a challenge endpoint whose URL never reached it.
   *
   * Either aborted outright — an image beacon, a `<link>`, a CSS `url()`, an
   * `EventSource` — or, when the path is a script the router already holds,
   * answered from that cache so the query string the page chose stays off the
   * wire. Both are the same event: bytes the browser put in a URL, denied.
   */
  deniedBeacons: number;
  /** POSTs to a challenge endpoint whose body the solver did not author. */
  deniedPosts: number;
  /** WebSockets to a challenge endpoint that were never dialled upstream. */
  deniedSockets: number;
  /**
   * Navigations carrying a body that were let through — a form submission,
   * essentially.
   *
   * Counted separately from `postsAllowed` and deliberately NOT part of the
   * conservation pair: this is the application's own body on a frame the
   * browser is committing to, not challenge telemetry, so the solver never
   * authors one and an excess here is not a leak. It is counted at all
   * because it is still a browser-written body crossing the boundary, and a
   * count that rises on a property whose flow should be pure GET is worth
   * seeing.
   */
  navigationPostsAllowed: number;
  /** POSTs to a challenge endpoint that were allowed to leave. */
  postsAllowed: number;
  /** Bodies the solver authored and handed to a route. */
  solverBodiesIssued: number;
  /**
   * POSTs to the protected origin on a path no rule calls a challenge
   * endpoint. Reported, never blocked: on a real property most of these are
   * the application's own traffic, and blocking them would break the page
   * this is here to reach. A rising count on a property that should be quiet
   * is how an unmodelled fourth channel announces itself.
   */
  unmodelledOriginPosts: number;
};

/** Per-call options for {@link AkamaiHandle.solveAbck}. */
export type SolveAbckOptions = {
  /**
   * Which host's `_abck` to solve. Defaults to the origin's.
   *
   * A property is not obliged to keep its whole flow on the document host.
   * ANA's booking engine is a second first-party host running its own full Bot
   * Manager instance, with its own sensor, its own bundle and its own `_abck`;
   * the rounds for it have to be answered from a document on THAT host, with
   * THAT host's jar.
   */
  host?: string;
  /**
   * How long the lane may stay quiet before `waitForAcceptance: false`
   * returns. Default 15000ms.
   *
   * It is a quiet window and not a deadline on purpose: the gap between two
   * sensor rounds is the solver's own think time plus a network round trip,
   * and a fixed deadline cuts whichever round straddles it.
   *
   * The default was 4000ms and that was too close to the cadence to be safe.
   * Measured on a live ANA run, the gaps between consecutive submissions were
   * 3247, 1975, 3758 and 3767ms — the last two within ~240ms of the cutoff —
   * and the lane then ended on the timer at 4003ms rather than on anything the
   * solver said. Five rounds was luck; a sixth arriving 100ms later would have
   * been cut, and every realm was hanging up mid-ladder.
   */
  idleMs?: number;
  /**
   * Rounds below which a quiet window is treated as suspicious, not final.
   * Default 3.
   *
   * It cannot make the solver send more — nothing here can — so what it buys
   * is patience: under the floor the lane waits three times as long before
   * concluding the ladder is over, and says so if it ends there anyway. That
   * separates "the solver stopped" from "we hung up", which the old exit did
   * not.
   */
  minRounds?: number;
  /**
   * Whether to hold until the solver reports `_abck` accepted. Default `true`.
   *
   * `false` returns once at least one submission has been answered and the
   * lane has been quiet for `idleMs` — the cookie is whatever it is, usually
   * still `~-1~`. That is the right mode when the point of the run is to reach
   * the site rather than to prove clearance: on a property with no protected
   * request to test against, acceptance is not observable from the client
   * anyway, and waiting for it simply burns the discovery window. It is the
   * wrong mode for a regression gate, which should assert `~0~`.
   */
  waitForAcceptance?: boolean;
};

/**
 * One host's challenge state.
 *
 * This was twelve `let`s in `attach`'s scope — the same thing said once for
 * the whole page — and it was only ever right because exactly one host ran a
 * challenge at a time. aa.com is that property: `aa.ts` touches one host, and
 * its off-origin Akamai names are pure telemetry CDNs. ANA is not. Measured in
 * a live run, `aswbe.ana.co.jp` served its own 510KB SBSD bundle and its own
 * 624KB sensor, and adopting them overwrote the document host's: the second
 * `Sensor script captured` line replaced the first, and the ledger issued
 * afterwards carried on into the first host's cursor.
 *
 * Nothing in here is shared between hosts. The classification sets are keyed
 * by host for the same reason, and the two are looked up the same way.
 */
type HostState = {
  /**
   * Whether this host's `_abck` reached `~0~`.
   *
   * Distinct from "a lane ran", which is what the handle used to report as
   * `solved` — that answered `true` for a realm whose five rounds all came
   * back `rval=-1`. Acceptance is the fact worth keeping: it is what stops the
   * realm being re-solved, and re-solving an accepted realm risks spending a
   * bad payload against a cookie that was already good.
   */
  accepted: boolean;
  /** Carriers answered with a row, across every document on this host. */
  answered: number;
  /** The one sensor body the solver authored; anything else is native. */
  authorizedSensorBody: null | string;
  /** The URL the solver chose for that body, so the page cannot change it. */
  authorizedSensorUrl: null | string;
  /** The `_abck` sensor, kept across the bootstrap's self-reload. */
  bmMain: { body: string; url: string } | null;
  /**
   * Rows are handed out one at a time, in order. `cursor++` across concurrent
   * route handlers is not enough on its own — the awaits between taking a row
   * and continuing the route let a later carrier overtake an earlier one, and
   * SBSD ordering is FIFO by construction.
   */
  carrierQueue: Promise<unknown>;
  cursor: number;
  host: string;
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
  ledger: null | Promise<LedgerRow[]>;
  /** POSTs to one of this host's challenge endpoints that were allowed out. */
  postsAllowed: number;
  /**
   * `_abck` sensor submissions answered for this host, across every lane.
   *
   * The denominator a run is judged against. Akamai bans some sessions on the
   * first navigation, before any sensor has been asked for; counting those as
   * solve failures measures the exit IP, not the solver.
   */
  rounds: number;
  /** The bundle source, and the path its carriers POST to. */
  sbsdBody: null | string;
  sbsdPath: null | string;
  /** The raw `src` attribute, `?v=` included: it seeds the bundle's codec. */
  sbsdSrc: null | string;
  /** The document as served on this host, read off the response. */
  servedHtml: string;
  /** Bodies the solver authored for this host. */
  solverBodiesIssued: number;
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
 * Wait for the realm's asynchronous readings before snapshotting.
 *
 * Two of them are not there the instant the document is:
 *
 *   ak_bm_tab_id  the bundle writes it shortly after it loads, and the server
 *                 refuses a snapshot without one — a document that has not got
 *                 one could not have emitted a carrier. Holding the first
 *                 carrier is usually enough time on its own; usually is not
 *                 always, and on a fast machine the request can leave ~2s in.
 *   voices        `speechSynthesis.getVoices()` is empty for the first few
 *                 hundred milliseconds of any page, on every platform. A macOS
 *                 Chrome reports 180 local voices half a second after load and
 *                 none at all before that, and a snapshot claiming a macOS
 *                 Chrome with no voices describes a browser that cannot exist
 *                 — the same class of mismatch as the screen metrics.
 *
 * Both waits are bounded and neither is fatal: the server's refusal names the
 * reason better than a guess made here would. Note what this deliberately does
 * not do — a machine with no speech engine installed genuinely has no voices,
 * and no amount of waiting invents them. The answer there is to install one,
 * not to send a number the page cannot back up.
 */
const waitForRealmReadings = async (page: Frame | Page): Promise<void> => {
  const settle = async (
    predicate: () => boolean,
    timeout: number
  ): Promise<void> => {
    try {
      await page.waitForFunction(predicate, { polling: 100, timeout });
    } catch {
      // Bounded wait elapsed. Send it and let it be judged on its merits.
    }
  };

  await settle(() => {
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
  }, 10_000);

  await settle(
    () =>
      (
        globalThis as unknown as {
          speechSynthesis: { getVoices: () => unknown[] };
        }
      ).speechSynthesis.getVoices().length > 0,
    // Ten seconds, not three: on a machine where a speech daemon has to be
    // spawned on first use the list can take several seconds to arrive, and
    // the cost of waiting is paid once per document.
    10_000
  );
};

/**
 * Everything the ledger request needs that only the page can answer.
 *
 * Runs as one `page.evaluate` because it has to be one instant: the resource
 * timings, the heap readings and the DOM inventory are compared against each
 * other, and reading them across three round-trips describes a page that never
 * existed.
 */
const readRealm = (page: Frame | Page): Promise<RealmSnapshot> =>
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

  /**
   * Challenge state, per host. The origin's exists from the start so that
   * the discovered SBSD path has somewhere to live.
   */
  const sites = new Map<string, HostState>();
  const siteFor = (siteHost: string): HostState => {
    const existing = sites.get(siteHost);
    if (existing) return existing;
    const created: HostState = {
      accepted: false,
      answered: 0,
      authorizedSensorBody: null,
      authorizedSensorUrl: null,
      bmMain: null,
      carrierQueue: Promise.resolve(),
      cursor: 0,
      host: siteHost,
      ledger: null,
      postsAllowed: 0,
      rounds: 0,
      sbsdBody: null,
      sbsdPath: null,
      sbsdSrc: null,
      servedHtml: '',
      solverBodiesIssued: 0,
    };
    sites.set(siteHost, created);
    return created;
  };

  /* ------------------------------------------------------------------ *
   * Which endpoints are Akamai's
   *
   * Everything below is a runtime discovery, never a constant: Akamai rotates
   * the stems of both bundles roughly every twenty minutes and the carrier
   * path's last two segments change with them. What does not rotate is the
   * SHAPE of the relationship — a challenge script POSTs to the path it was
   * served from, and a challenge endpoint lives in the same directory as the
   * script that talks to it — so that is what is matched.
   * ------------------------------------------------------------------ */

  const originHost = new URL(origin).host;
  /** The document host's state. */
  const originSite = siteFor(originHost);
  /**
   * The frame a host's challenge runs in.
   *
   * `page.evaluate`, `page.content()` and `page.url()` all mean the MAIN
   * frame, and a submission sent from the wrong document is a cross-origin
   * XHR carrying the wrong jar. `null` rather than a fallback: a host with no
   * live frame cannot be solved, and saying so beats solving the wrong one.
   */
  const frameFor = (siteHost: string): Frame | null => {
    const hostOf = (frame: { url: () => string }): null | string => {
      try {
        return new URL(frame.url()).host;
      } catch {
        return null;
      }
    };
    const main = page.mainFrame();
    if (hostOf(main) === siteHost) return main;
    return page.frames().find((frame) => hostOf(frame) === siteHost) ?? null;
  };
  /**
   * Hosts inside discovery scope — watched, not condemned.
   *
   * The middle state the classifier did not have. Off-origin there used to be
   * exactly two settings, "nothing here is a challenge" and "everything here
   * is", because `isAkamai` returned before it ever consulted the path sets.
   * That is why one cookie had to buy the whole host: it was the only lever
   * that reached a third-party sensor at all.
   */
  const protectedHosts = new Set<string>([originHost]);
  /** Names and patterns that admit a host to the set above on sight. */
  const protectedHostRules: readonly (RegExp | string)[] =
    opts.protectedHosts ?? [];
  /** Exact challenge pathnames, per host. */
  const akamaiPaths = new Map<string, Set<string>>();
  /** Challenge directory prefixes, per host. */
  const akamaiPrefixes = new Map<string, Set<string>>();
  /**
   * Paths served as ordinary application content, as `host + pathname`.
   *
   * The guard rail under prefix marking. A challenge script's directory is
   * the useful unit — a bundle and the carrier beside it rotate together —
   * but a directory is also the widest thing this file can assert, and
   * asserting one that contains the application is how the deny set swallowed
   * a booking flow. A directory that is an ancestor of anything already
   * served as ordinary content is refused.
   */
  const benignPaths = new Set<string>();
  /** Pathnames whose script is the `_abck` sensor, as `host + pathname`. */
  const sensorPaths = new Set<string>();
  /**
   * Every script the router has fetched, keyed `host + pathname`.
   *
   * Host-qualified because the cache is consulted by path to decide whether a
   * POST target was served as a script, and two hosts in scope can serve
   * different scripts at the same pathname.
   */
  const scripts = new Map<string, { body: string; url: string }>();
  /** The cache and the two path maps are all keyed this way. */
  const pathKey = (url: URL): string => `${url.host}${url.pathname}`;
  const setFor = (map: Map<string, Set<string>>, host: string): Set<string> => {
    const existing = map.get(host);
    if (existing) return existing;
    const created = new Set<string>();
    map.set(host, created);
    return created;
  };
  /** Re-sends the worker-realm URL blocklist when discovery widens it. */
  let refreshBlocksHook: (() => void) | null = null;
  /** Budget for the above. A body it will not hold is a body it will refetch. */
  let scriptBytes = 0;

  const stats: EgressStats = {
    blockedInWorkerRealm: 0,
    byHost: {},
    carriersAnswered: 0,
    deniedBeacons: 0,
    deniedPosts: 0,
    deniedSockets: 0,
    navigationPostsAllowed: 0,
    postsAllowed: 0,
    solverBodiesIssued: 0,
    unmodelledOriginPosts: 0,
  };

  /**
   * Record an endpoint as Akamai's, and with it the directory it sits in.
   *
   * The directory is the load-bearing half. `/akam/13/<hex>` and the
   * `/akam/13/pixel_<hex>` it POSTs to are different paths that rotate
   * together; so are a bundle and the carrier beside it. One `Set` of
   * prefixes covers both without knowing either name.
   */
  /** Bring a host into discovery scope. Watching is not condemning. */
  const markProtected = (host: string): void => {
    if (protectedHosts.has(host)) return;
    protectedHosts.add(host);
    log(`[egress] Protected host in scope: ${host}`);
    refreshBlocksHook?.();
  };

  /** Admit a host the caller named or matched by pattern. */
  const admitHost = (host: string): void => {
    if (protectedHosts.has(host)) return;
    const matched = protectedHostRules.some((rule) =>
      typeof rule === 'string'
        ? host === rule || host.endsWith(`.${rule}`)
        : rule.test(host)
    );
    if (matched) markProtected(host);
  };

  /**
   * Whether a directory may stand for its whole subtree.
   *
   * Two conditions. It must be at least two segments deep, because a
   * one-segment directory on a real property is an application section rather
   * than a rotating challenge stem — ANA's `/fs/dom/jp/` search entry sits
   * under `/fs/`, and a sensor that rotated to `/fs/<nonce>` would otherwise
   * take the booking flow with it. And it must not be an ancestor of anything
   * already served as ordinary content.
   *
   * Refusing a prefix is not a hole. The endpoint's own path is still marked,
   * and the effect test in `learnFromPost` still denies a sibling endpoint on
   * its FIRST POST — it runs before the request is classified, so the mark
   * lands in time to deny the very request that revealed it. What is lost is
   * only pre-emptive cover for siblings that have not spoken yet.
   */
  const safePrefix = (host: string, directory: string): boolean => {
    if (directory.split('/').filter(Boolean).length < 2) return false;
    const stem = `${host}${directory}`;
    for (const benign of benignPaths) if (benign.startsWith(stem)) return false;
    return true;
  };

  const markAkamai = (url: URL): void => {
    markProtected(url.host);
    const paths = setFor(akamaiPaths, url.host);
    if (paths.has(url.pathname)) return;
    paths.add(url.pathname);
    const directory = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
    const widen = safePrefix(url.host, directory);
    if (widen) setFor(akamaiPrefixes, url.host).add(directory);
    // The prefix is logged, not just the path that caused it: the prefix is
    // what the default-deny arms actually test, and a mark that widens further
    // than intended is otherwise invisible until something unrelated stops
    // loading. A refusal is logged for the same reason, from the other side.
    log(
      `[egress] Challenge endpoint: ${url.host}${url.pathname}` +
        (widen
          ? ` (deny prefix ${directory}*)`
          : ` (this path only — ${directory} is too broad to deny)`)
    );
    refreshBlocksHook?.();
  };

  /**
   * Pure. Scope admission happens in the router, so classifying a URL never
   * changes what the classifier will say next.
   */
  const isAkamai = (url: URL): boolean => {
    if (!protectedHosts.has(url.host)) return false;
    if (AKAMAI_PIXEL_PREFIX.test(url.pathname)) return true;
    if (akamaiPaths.get(url.host)?.has(url.pathname)) return true;
    for (const prefix of akamaiPrefixes.get(url.host) ?? [])
      if (url.pathname.startsWith(prefix)) return true;
    return false;
  };

  /* ------------------------------------------------------------------ *
   * Fail closed, not quiet
   * ------------------------------------------------------------------ */

  let settleReady: (() => void) | null = null;
  // eslint-disable-next-line no-unused-vars -- name documents a function type
  let breakReady: ((reason: Error) => void) | null = null;
  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    settleReady = resolve;
    breakReady = reject;
  });
  // Nobody is obliged to await it, and an unobserved rejection must not take
  // the process down. The handle still carries the same promise.
  ready.catch(() => undefined);

  /** Every property in this directory runs SBSD; `_abck` rides along. */
  const missingChannels = (): string[] =>
    originSite.sbsdPath === null ? ['sbsd'] : [];

  const failReady = (reason: string): void => {
    // Said out loud either way. `ready` can only be broken once, and a breach
    // that arrives after it has already resolved — which conservation's does,
    // because a solve has to be under way for there to be a body to conserve
    // — would otherwise be swallowed by the very guard that exists to make
    // this class of failure audible.
    log(`[egress] NOT READY — ${reason}`);
    if (readySettled) return;
    readySettled = true;
    breakReady?.(new Error(reason));
  };

  const checkReady = (): void => {
    if (readySettled || missingChannels().length > 0) return;
    readySettled = true;
    settleReady?.();
  };

  /**
   * Conservation: POSTs that reached a challenge endpoint against bodies the
   * solver wrote. `solverBodiesIssued` is counted at the point of authorship —
   * where a ledger row is taken and where a submission body arrives from the
   * session — so it does not depend on recognising the request that carries
   * it, and a new allow arm added to the router without a matching body is
   * caught by arithmetic rather than by review.
   *
   * The test is one-sided, and deliberately. Authorship happens strictly
   * before egress: between `solveAbck()` handing over a submission and the
   * page's XHR arriving at the router, `solverBodiesIssued` legitimately leads
   * by one, and a body that is authored but never sent leaves it leading
   * forever. Neither is a leak. `postsAllowed` **exceeding** it is, because
   * the only two arms that increment it are the two that also authored — so
   * an excess is a POST reaching a challenge endpoint that the solver did not
   * write.
   *
   * What it does not do is see a realm nothing routes. A SharedWorker POST
   * increments neither counter; that hole is closed by the CDP guard below,
   * which blocks the send, not by this assertion.
   */
  const conservationReported = new Set<string>();
  /**
   * Per host, and that is the correction rather than a detail. Two hosts
   * pooled into one pair cancel: a realm that leaked one POST and a realm that
   * authored a body it never sent sum to a balanced total, and the alarm that
   * exists to catch the first is silenced by the second.
   */
  const checkConserved = (site: HostState): void => {
    if (site.postsAllowed <= site.solverBodiesIssued) return;
    if (conservationReported.has(site.host)) return;
    conservationReported.add(site.host);
    failReady(
      `conservation broken on ${site.host}: ${site.postsAllowed} POST(s) ` +
        `reached a challenge endpoint but the solver authored ` +
        `${site.solverBodiesIssued} body(ies)`
    );
  };
  /** Carriers answered across every host, for the public counter. */
  const totalAnswered = (): number =>
    [...sites.values()].reduce((sum, site) => sum + site.answered, 0);

  let discoveryTimer: null | ReturnType<typeof setTimeout> = null;
  const startDiscoveryClock = (): void => {
    if (discoveryTimer !== null || readySettled) return;
    discoveryTimer = setTimeout(() => {
      const missing = missingChannels();
      if (missing.length === 0) return checkReady();
      failReady(
        `no ${missing.join(' or ')} channel was discovered on ${origin} within ` +
          `${opts.discoveryTimeoutMs ?? 45_000}ms. The router is installed and ` +
          `is denying every unrecognised POST to a challenge endpoint, so ` +
          `nothing has leaked — but nothing is being solved either. Either the ` +
          `build changed shape (a non-UUID bundle cache-buster, a renamed ` +
          `sensor global) or this property does not run that channel. There is ` +
          `no override to pin it with: the path is per-host and discovered, so ` +
          `read the denied endpoints in the log above and widen discovery.`
      );
    }, opts.discoveryTimeoutMs ?? 45_000);
    discoveryTimer.unref?.();
  };

  /**
   * The jar for one host. Scoped, because a session opened for a peer host
   * with the document host's cookies describes a visitor that does not exist:
   * the peer's own `_abck` is the cookie the solver is trying to move.
   */
  const cookies = async (
    siteHost: string = originHost
  ): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await context.cookies(`https://${siteHost}`)).map((c) => [
        c.name,
        c.value,
      ])
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
    let documentHost: string;
    try {
      documentHost = new URL(response.url()).host;
    } catch {
      return;
    }
    // Any frame, not just the main one, and keyed by the document's own host
    // rather than the page's. A peer realm's challenge runs in whichever frame
    // the property put it in, and its ledger is bound to THAT document.
    const site = siteFor(documentHost);
    // A new document on this host is a new snapshot, so the ledger issued for
    // the last one is retired here rather than carried across the bootstrap's
    // self-reload. The rows are computed from a document's HTML, cookies,
    // timings and runtime readings; feeding leftovers to the carriers of the
    // page that replaced it describes a visitor that was never on either.
    site.ledger = null;
    site.cursor = 0;
    // A new document is a new sensor ladder, so a host solved against the
    // previous one becomes solvable again. Without this a host was solved at
    // most once per process, which collides with the two navigations that
    // matter most: the Akamai bootstrap reloading itself once its carrier is
    // answered, and the flight-search navigation landing a fresh document on a
    // host already marked done. A lane still running is left alone — clearing
    // it would let a second lane open against the same jar.
    if (!lanesRunning.has(documentHost) && !site.accepted)
      lanes.delete(documentHost);
    void response.text().then(
      (text) => {
        site.servedHtml = text;
      },
      () => {
        /* a redirect or an aborted navigation has no body to read */
      }
    );
  });

  /**
   * One POST, `expectedCap` rows, for the document that is live right now —
   * on `site.host`, in that host's own frame.
   *
   * The frame matters as much as the host does. A ledger is bound to one
   * document, and `page.evaluate`/`page.content()` mean the MAIN frame
   * whatever host the carrier came from.
   */
  async function generateLedger(site: HostState): Promise<LedgerRow[]> {
    const frame = frameFor(site.host);
    if (!frame)
      throw new Error(
        `no live frame on ${site.host} to snapshot for its SBSD ledger — a ` +
          `ledger is bound to one document and there is no document here`
      );
    await waitForRealmReadings(frame);
    const realm = await readRealm(frame);
    const liveHtml = await frame.content();
    /* PROBE: is the sensor's own <script src> in the bytes the server sent, or
     * did the bootstrap inject it? That decides whether a caller holding only
     * the response document can satisfy `document.currentScript` at all. */
    const response = await fetch(ledgerUrl, {
      body: JSON.stringify({
        /* THE REDUCED SHAPE. Everything omitted here the server now derives,
         * and the omissions are the point rather than an economy: no
         * `domResourceInventory` is what stops the sandbox parsing this
         * document a second time and diffing it against itself, and `html` is
         * the LIVE DOM, so the injected third-party tags are present because
         * they are in the document rather than because we described them.
         *
         * What is still sent is what no server can derive: the jar (`bm_so`/
         * `bm_lso` carry the SBSD session identity), the tab id the page has
         * held since it loaded, and which browser this body is from. */
        bundle: { scriptSrc: site.sbsdSrc, source: site.sbsdBody },
        document: {
          cookieHeader: realm.documentCookie,
          /* LIVE DOM, not the served bytes. `runtime.domResourceInventory` is
           * read off this same live DOM, so reconciliation compares a document
           * against its own inventory and resolves to the identity case its
           * own doc comment describes -- no LCS, nothing moved. The served
           * response is no longer what reaches the sandbox either way:
           * reconciliation ends in `dom.serialize()`, so byte fidelity to the
           * response was already gone. */
          html: liveHtml,
          /* ⚠ THE ONE READING A DEFAULT CANNOT STAND IN FOR. The server mints a
           * fresh `akBmTabId` per request, so a session's carriers would each
           * describe a different tab -- measured, 17 ledgers with 17 ids. The
           * page holds one for its lifetime. */
          runtime: { sessionStorage: realm.runtime['sessionStorage'] },
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
      // The refusal itself says almost nothing: `error.message` is one generic
      // sentence for every code and `receipt` is null on this path. So the
      // readings most likely to be at fault are reported from here instead —
      // they are the ones that differ between a desktop and a CI runner, and
      // without them a refusal in CI is unactionable.
      const voices = realm.runtime['speechSynthesisVoices'];
      const session = realm.runtime['sessionStorage'];
      // The receipt is the useful half of a refusal: `error.message` is the
      // same sentence for every code, while the receipt names the input that
      // could not be reconciled. Without it a CI failure is unactionable.
      throw new Error(
        `SBSD ledger refused (${response.status}): ` +
          `${ledger.error?.code ?? 'unknown'} — ` +
          `${ledger.error?.message ?? ''} ` +
          `receipt=${JSON.stringify(ledger.receipt ?? null).slice(0, 400)} ` +
          `voices=${JSON.stringify(voices)} ` +
          `session=${JSON.stringify(session)} ` +
          `resourceEntries=${realm.resourceEntries.length} ` +
          // The refusal names the field but never the value, and on a page
          // that wraps Function.prototype.toString this is the field that
          // fails. Without it the 400 is unactionable.
          `functionToString=${JSON.stringify(realm.runtime['functionToString'])} ` +
          `html=${site.servedHtml.length}b cookie=${realm.documentCookie.length}b`
      );
    }
    log(
      `[sbsd] Ledger issued (LIVE-DOM html): ` +
        `cap=${ledger.expectedCap} nonce=${ledger.runNonce}`
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
    body: string,
    response?: APIResponse
  ): Promise<void> => {
    const headers: Record<string, string> = response
      ? { ...response.headers() }
      : { 'content-type': 'application/javascript' };
    delete headers['content-encoding'];
    delete headers['content-length'];
    delete headers['set-cookie'];
    await route.fulfill({ body, headers, status: response?.status() ?? 200 });
  };

  /**
   * Every challenge endpoint, as `Network.setBlockedURLs` globs.
   *
   * No carve-out for the carrier, and that is a decision rather than an
   * oversight. `setBlockedURLs` has no exception form, so sparing the carrier
   * means dropping the directory prefix it sits under — and the prefix is the
   * pattern that does the work, because it covers the endpoints discovery has
   * not named yet. Measured: with the carrier spared, the prefix went with it
   * and the realm's whole challenge surface reopened.
   *
   * The cost is named: on a build that emitted the carrier from one of these
   * realms the solver would deny it rather than answer it with a ledger row.
   * That is a hard stop, not a leak, and it is the correct default here — on
   * every archived build of both properties the carrier POSTs from a document
   * realm.
   */
  const blockPatterns = (): string[] => [
    ...[...akamaiPrefixes].flatMap(([host, set]) =>
      [...set].map((prefix) => `*${host}${prefix}*`)
    ),
    ...[...akamaiPaths].flatMap(([host, set]) =>
      [...set].map((path) => `*${host}${path}*`)
    ),
  ];

  /**
   * The same policy, in the realm's own scope, for the one primitive CDP does
   * not cover.
   *
   * Measured on the rig: `Network.setBlockedURLs` stops a worker realm's HTTP
   * — xhr, fetch, `importScripts`, `EventSource` all went from leaking to
   * blocked — and does **not** stop its WebSocket, which went out under the
   * identical blocklist. `Fetch` has no WebSocket domain either. So the
   * constructor is replaced instead, evaluated while the realm is still
   * paused at start so nothing of the worker's own has run yet.
   *
   * This is a tell inside the worker realm — `WebSocket` is no longer native
   * there — and it is taken knowingly: the alternative on the same measurement
   * is a socket to a challenge endpoint that nothing observes.
   *
   * **It reaches the two realms the CDP guard attaches to, and no further.**
   * A dedicated Worker and a blob Worker are attached from the *page* target,
   * not the browser one, so a browser-scope session never sees them, and
   * there is no route-time discriminator to hand their source a guard with:
   * measured, an intercepted request exposes only provisional headers, so
   * `Sec-Fetch-Dest` — which is what tells a worker's top-level script from a
   * page's — is absent from both `headers()` and `allHeaders()`. A socket
   * opened from either realm to a challenge endpoint is still unobserved. The
   * one remedy left is patching `Worker`/`SharedWorker` in the parent realm,
   * which buys it at the price of a non-native constructor in the realm the
   * bundle fingerprints hardest. Not taken here; named instead.
   */
  const socketPrelude = (): string =>
    `(() => {
      const deny = ${JSON.stringify(blockPatterns().map((p) => p.replaceAll('*', '')))};
      const blocked = (u) => { try { return deny.some((d) => String(new URL(u, self.location.href)).includes(d)); } catch { return false; } };
      const Native = self.WebSocket;
      if (!Native || Native.__guarded) return;
      const Guarded = function (url, protocols) {
        if (blocked(url)) throw new DOMException('Refused to connect', 'SecurityError');
        return protocols === undefined ? new Native(url) : new Native(url, protocols);
      };
      Guarded.prototype = Native.prototype;
      Object.defineProperties(Guarded, { __guarded: { value: true }, name: { value: 'WebSocket' } });
      for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Guarded[k] = Native[k];
      self.WebSocket = Guarded;
    })()`;

  /** Keep a script's bytes so the same path never has to be refetched. */
  const remember = (url: URL, body: string): void => {
    const key = pathKey(url);
    const previous = scripts.get(key);
    if (previous) scriptBytes -= previous.body.length;
    if (scriptBytes + body.length > SCRIPT_CACHE_BYTES) {
      if (previous) scripts.delete(key);
      return;
    }
    scriptBytes += body.length;
    scripts.set(key, { body, url: url.href });
  };

  /** This script is the `_abck` sensor. Remember it across documents. */
  const adoptSensor = (url: URL, body: string): void => {
    siteFor(url.host).bmMain = { body, url: url.href };
    sensorPaths.add(pathKey(url));
    markAkamai(url);
    log(
      `[abck] Sensor script captured: ${body.length} bytes from ${url.pathname}`
    );
    checkReady();
  };

  /** This script is the SBSD bundle. */
  const adoptBundle = (url: URL, body: string): void => {
    const site = siteFor(url.host);
    site.sbsdPath = url.pathname;
    site.sbsdBody = body;
    site.sbsdSrc = `${url.pathname}${url.search}`;
    markAkamai(url);
    log(`[sbsd] Bundle captured: ${body.length} bytes from ${url.pathname}`);
    checkReady();
  };

  /**
   * What a POST says about the script that sent it.
   *
   * This is the discriminator the URL cannot give you. A challenge script is
   * *the script that POSTs to the path it was served from* — the SBSD bundle
   * and the `_abck` sensor both do it, and nothing else on a page does. The
   * signal arrives one request too late to stop that first POST, which is
   * exactly why the first POST is denied rather than forwarded: the endpoint
   * is recorded, the body never leaves, and the next document gets a stub.
   */
  const learnFromPost = (url: URL): void => {
    const served = scripts.get(pathKey(url));
    if (!served || !protectedHosts.has(url.host)) return;
    if (!isAkamai(url)) markAkamai(url);
    const site = siteFor(url.host);
    const servedUrl = new URL(served.url);
    if (site.sbsdPath === null && isSbsdBundle(servedUrl))
      adoptBundle(servedUrl, served.body);
    else if (
      site.bmMain === null &&
      sensor === 'solver' &&
      url.pathname !== site.sbsdPath &&
      !isSbsdBundle(servedUrl)
    )
      adoptSensor(servedUrl, served.body);
  };

  /**
   * Serve a script. From memory when we already hold that path's bytes.
   *
   * Serving from memory is not an optimisation, it is the policy: a
   * `<script src>`, a `<link>`, an `importScripts` or a CSS `url()` aimed at a
   * challenge endpoint carries its payload in the query string, and
   * `route.fetch()` would faithfully replay that query — from Playwright's own
   * Node process, on a connection that is not even the browser's. Answering
   * out of the cache puts nothing on the wire.
   */
  const serveScript = async (route: Route, url: URL): Promise<void> => {
    const key = pathKey(url);
    const cached = scripts.get(key);
    if (cached && isAkamai(url)) {
      if (url.href !== cached.url) {
        stats.deniedBeacons++;
        log(
          `[egress] Answered from cache, not refetched: ${url.pathname}${url.search}`
        );
      }
      // The bundle seeds its codec from its own `src`, so the live one wins —
      // but only when it still looks like a bundle nonce, or a crafted `src`
      // could rewrite it.
      if (isSbsdBundle(url))
        siteFor(url.host).sbsdSrc = `${url.pathname}${url.search}`;
      return sensor === 'solver' && sensorPaths.has(key)
        ? route.fulfill({
            body: SENSOR_STUB,
            contentType: 'application/javascript',
          })
        : handBack(route, cached.body);
    }

    const response = await route.fetch();
    const body = await response.text();
    remember(url, body);

    if (isSbsdBundle(url)) {
      adoptBundle(url, body);
      // Handed back rather than stubbed, unlike the sensor below. The bundle
      // has to run: it is what emits the carrier POSTs this file rewrites.
      return handBack(route, body, response);
    }
    if (
      sensor === 'solver' &&
      (sensorPaths.has(key) || (body.length > 50_000 && /\bbmak\b/u.test(body)))
    ) {
      adoptSensor(url, body);
      // The real sensor must not run, or it posts its own telemetry
      // alongside the solver's.
      return route.fulfill({
        body: SENSOR_STUB,
        contentType: 'application/javascript',
      });
    }
    // Ordinary application content. Recorded so no future mark can claim a
    // directory that contains it.
    benignPaths.add(key);
    return handBack(route, body, response);
  };

  /**
   * The router. Mounted on the BrowserContext with no URL filter.
   *
   * Context, not Page, because `page.route` is blind to popups and to
   * ServiceWorkers — and a popup is where a native sensor POST was measured
   * escaping. No URL filter because a property is not obliged to keep its
   * challenge endpoints on the document host, and a filter decides what can be
   * *seen* before any rule has decided what matters.
   *
   * The policy is default-DENY on a challenge endpoint. The shape it replaced
   * was an allow-list of two drops with `continue()` as the default arm, and
   * the default arm running is what 42 of 65 measured leaks were.
   */
  const router = async (route: Route): Promise<void> => {
    const request = route.request();
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return route.continue();
    }
    admitHost(url.host);
    if (protectedHosts.has(url.host)) startDiscoveryClock();

    const resourceType = request.resourceType();
    const carriesBody = BODY_METHODS.has(request.method());

    /**
     * A navigation is the site, not a beacon — and this has to be tested
     * before the body arm, which is the whole point of it sitting here.
     *
     * A form submission is a document request that CARRIES A BODY, so the
     * default-deny POST arm below reached it first and aborted it. Measured on
     * ANA: clicking the flight-search button POSTs to
     * `aswbe.ana.co.jp/webapps/reservation/flight-search`, the host had already
     * been marked a challenge surface, and the abort surfaced as
     * `net::ERR_FAILED` — Chrome's "This site can't be reached". The exemption
     * meant to prevent exactly that was the last arm in the function and was
     * unreachable for every request that needed it.
     *
     * Nothing solver-relevant escapes here. Every challenge body this file
     * models — the SBSD carrier, the `_abck` sensor submission — is sent by
     * script as `xhr` or `fetch`; no challenge script submits a form, and
     * `isNavigationRequest()` is what separates the two. If a build ever did
     * carry a sensor on a navigation, `navigationPostsAllowed` is where it
     * would show up, and it is reported for that reason.
     *
     * `learnFromPost` is skipped on this path as well, and for a related
     * reason: a navigation target is not an endpoint a challenge script posts
     * to, so recording one would widen the deny set onto the application's own
     * pages — which is how this failure began.
     */
    if (request.isNavigationRequest() && resourceType === 'document') {
      // A page the browser committed a frame to is application content by
      // definition, and no later mark may claim a directory containing it.
      benignPaths.add(pathKey(url));
      if (carriesBody) {
        stats.navigationPostsAllowed++;
        log(
          `[egress] Navigation allowed: ${request.method()} ` +
            `${url.host}${url.pathname}`
        );
      }
      return route.continue();
    }

    if (carriesBody) learnFromPost(url);
    const challenge = isAkamai(url);

    if (carriesBody) {
      if (!challenge) {
        if (protectedHosts.has(url.host)) {
          stats.unmodelledOriginPosts++;
          log(`[egress] Unmodelled POST: ${url.host}${url.pathname}`);
        }
        return route.continue();
      }

      // SBSD carrier. The first one is held while the ledger is generated,
      // which is also what makes the snapshot legal:
      // `sessionStorage.ak_bm_tab_id` only exists once the bundle has run.
      //
      // `site` is this host's state, not the page's. Two hosts running SBSD
      // concurrently each get their own ledger, cursor and FIFO queue; sharing
      // them is what made a peer realm's carrier draw a row from a document it
      // was never on.
      const site = siteFor(url.host);
      if (site.sbsdPath !== null && url.pathname === site.sbsdPath) {
        const mine = site.carrierQueue.then(async () => {
          let rows: LedgerRow[];
          try {
            site.ledger ??= generateLedger(site);
            rows = await site.ledger;
          } catch (error) {
            // Fail closed, and stay a route. Letting this reject leaves the
            // request owned by a handler that never answered it, which hangs
            // the page and then `browser.close()`; aborting is the same denial
            // the out-of-rows arm below makes, and it is audible in the log.
            site.ledger = null;
            stats.deniedPosts++;
            log(
              `[sbsd] No ledger for ${site.host}: ${(error as Error).message}`
            );
            return route.abort();
          }
          const row = rows[site.cursor++];
          // Out of rows: fail closed. Letting the native body through here
          // would hand Akamai a payload from an uninstrumented page alongside
          // ours.
          if (!row) {
            stats.deniedPosts++;
            return route.abort();
          }
          log(`[sbsd] ${site.host} row ${row.index}: ${row.bytes} bytes`);
          site.answered++;
          site.solverBodiesIssued++;
          site.postsAllowed++;
          stats.carriersAnswered = totalAnswered();
          stats.solverBodiesIssued++;
          stats.postsAllowed++;
          checkConserved(site);
          // `url`, not just `postData`: `continue({ postData })` replaces the
          // body and NOTHING else, so the query string the page chose rides
          // along on a request whose body the solver wrote. The carrier POSTs
          // to a bare path in every capture; this makes that an invariant.
          return route.continue({
            postData: row.body,
            url: `${url.origin}${url.pathname}`,
          });
        });
        // The queue must not stay rejected, or every later carrier inherits
        // the first failure; the awaited promise still surfaces it here.
        site.carrierQueue = mine.catch(() => undefined);
        return mine;
      }

      // The one sensor body the solver authored, on the URL the solver chose.
      if (
        sensor === 'solver' &&
        site.authorizedSensorBody !== null &&
        request.postData() === site.authorizedSensorBody
      ) {
        const target = site.authorizedSensorUrl ?? url.href;
        site.authorizedSensorBody = null;
        site.authorizedSensorUrl = null;
        site.postsAllowed++;
        stats.postsAllowed++;
        checkConserved(site);
        return route.continue({ url: target });
      }

      stats.deniedPosts++;
      log(
        `[egress] DENIED POST to ${url.host}${url.pathname} — not a solver body`
      );
      return route.abort();
    }

    if (resourceType === 'script') {
      const mine =
        challenge ||
        isSbsdBundle(url) ||
        sensorPaths.has(pathKey(url)) ||
        (protectedHosts.has(url.host) && mayBeChallengeScript(url));
      if (mine) return serveScript(route, url);
      // Ordinary application content, forwarded on the browser's own
      // connection. Recorded so no later mark can claim a directory that holds
      // it — `serveScript` used to be the only place that happened, and the
      // prefix guard would have lost this evidence when the fetch went away.
      if (protectedHosts.has(url.host)) benignPaths.add(pathKey(url));
      return route.continue();
    }
    if (!challenge) return route.continue();
    // The residual document case: `document`-typed but not a navigation the
    // browser is committing a frame to. Kept rather than folded into the arm
    // above, because a request that claims to be a document and is not a
    // navigation is not a shape this file has measured, and denying it would
    // be a new behaviour hidden inside a reordering.
    if (resourceType === 'document') return route.continue();

    stats.deniedBeacons++;
    log(
      `[egress] DENIED ${resourceType} ${url.host}${url.pathname}${url.search} ` +
        `— bodyless request to a challenge endpoint`
    );
    return route.abort();
  };

  /**
   * WebSockets. Neither `page.route` nor `context.route` sees one — that is a
   * separate API, and until it is mounted a socket to a challenge endpoint is
   * simply outside every measurement.
   *
   * It only reaches document realms. A socket opened from a Worker,
   * SharedWorker or ServiceWorker is not covered here at any mount point; the
   * CDP guard below carries those.
   */
  const socketRouter = (ws: WebSocketRoute): void => {
    let url: null | URL;
    try {
      url = new URL(ws.url());
    } catch {
      url = null;
    }
    if (url && isAkamai(url)) {
      stats.deniedSockets++;
      log(`[egress] DENIED WebSocket to ${url.host}${url.pathname}`);
      // Never dialled upstream: the handler simply does not connect.
      return;
    }
    ws.connectToServer();
  };

  /**
   * Route installation is asynchronous and `attach()` is not.
   *
   * `context.routeWebSocket` works by injecting a page-side interceptor at
   * document start, so a document that began navigating before it landed is
   * not covered — measured: with `attach()` immediately followed by `goto`,
   * every child realm's socket was intercepted and the MAIN frame's was not.
   * Callers must await `installed` before the first navigation.
   */
  const installed = Promise.all([
    context.route(() => true, router),
    context.routeWebSocket(() => true, socketRouter),
  ]).then(() => undefined);
  installed.catch(() => undefined);

  /**
   * The worker frames, where the route APIs run out.
   */
  let workerGuard: CDPSession | null = null;
  /** Frames this guard attaches to at all. */
  const GUARDED_TARGETS = new Set(['service_worker', 'shared_worker']);
  /** Frames that need `Fetch` because no route API covers their HTTP. */
  const FETCH_GUARDED = new Set(['shared_worker']);
  const installWorkerGuard = async (): Promise<void> => {
    const browser = context.browser();
    if (!browser) return;
    const session = await browser.newBrowserCDPSession();
    workerGuard = session;
    /** Worker sessions we drive, by session id. */
    const guarded = new Map<string, { script: string }>();
    let nextId = 1;
    const toWorker = async (
      sessionId: string,
      method: string,
      params: unknown
    ): Promise<void> => {
      await session.send('Target.sendMessageToTarget', {
        message: JSON.stringify({ id: nextId++, method, params }),
        sessionId,
      });
    };
    const refreshBlocks = (): void => {
      for (const sessionId of guarded.keys()) {
        void toWorker(sessionId, 'Network.setBlockedURLs', {
          urls: blockPatterns(),
        }).catch(() => undefined);
        void toWorker(sessionId, 'Runtime.evaluate', {
          expression: socketPrelude(),
        }).catch(() => undefined);
      }
    };

    session.on('Target.receivedMessageFromTarget', ({ message, sessionId }) => {
      let event: {
        method?: string;
        params?: { request?: { url?: string }; requestId?: string };
      };
      try {
        event = JSON.parse(message) as typeof event;
      } catch {
        return;
      }
      if (event.method !== 'Fetch.requestPaused') return;
      const requestId = event.params?.requestId ?? '';
      const raw = event.params?.request?.url ?? '';
      let blocked: boolean;
      try {
        const url = new URL(raw);
        blocked = isAkamai(url) && raw !== guarded.get(sessionId ?? '')?.script;
      } catch {
        blocked = false;
      }
      if (blocked) {
        stats.blockedInWorkerRealm++;
        log(`[egress] DENIED in worker realm: ${raw}`);
      }
      void toWorker(
        sessionId ?? '',
        blocked ? 'Fetch.failRequest' : 'Fetch.continueRequest',
        blocked ? { errorReason: 'BlockedByClient', requestId } : { requestId }
      ).catch(() => undefined);
    });

    const seen = new Set<string>();
    session.on('Target.attachedToTarget', ({ targetInfo }) => {
      if (!GUARDED_TARGETS.has(targetInfo.type)) return;
      // `Target.attachToTarget` below emits another `attachedToTarget` for the
      // same target, which without this re-enters and attaches forever.
      if (seen.has(targetInfo.targetId)) return;
      seen.add(targetInfo.targetId);
      const needsFetch = FETCH_GUARDED.has(targetInfo.type);
      let attached: null | string = null;
      void (async () => {
        try {
          const { sessionId } = await session.send('Target.attachToTarget', {
            flatten: false,
            targetId: targetInfo.targetId,
          });
          attached = sessionId;
          guarded.set(sessionId, { script: targetInfo.url });
          if (needsFetch)
            await toWorker(sessionId, 'Fetch.enable', {
              patterns: [{ urlPattern: '*' }],
            });
          await toWorker(sessionId, 'Network.enable', {});
          await toWorker(sessionId, 'Network.setBlockedURLs', {
            urls: blockPatterns(),
          });
          // Lands while the realm is still paused, so it is in place before
          // any of the worker's own code runs.
          await toWorker(sessionId, 'Runtime.evaluate', {
            expression: socketPrelude(),
          });
          log(
            `[egress] Worker guard armed on ${targetInfo.type} ` +
              `${targetInfo.url}${needsFetch ? ' (fetch)' : ' (blocklist)'}`
          );
        } catch (error) {
          log(`[egress] Worker guard failed: ${(error as Error).message}`);
        } finally {
          // Whatever happened, this target must not stay paused: every realm
          // here is one the page is waiting on, and a dedicated worker left
          // at `waitForDebuggerOnStart` hangs whatever asked for it.
          if (attached !== null)
            void toWorker(
              attached,
              'Runtime.runIfWaitingForDebugger',
              {}
            ).catch(() => undefined);
          else
            log(
              `[egress] Worker guard could not resume ${targetInfo.type} ` +
                `${targetInfo.url} — never attached`
            );
        }
      })();
    });

    await session.send('Target.setAutoAttach', {
      autoAttach: true,
      filter: [...GUARDED_TARGETS].map((type) => ({ exclude: false, type })),
      flatten: true,
      // The blocklist has to be in place before the realm runs, which means
      // catching it paused. Every path out of the arming block resumes it.
      waitForDebuggerOnStart: true,
    });
    refreshBlocksHook = refreshBlocks;
  };
  void installWorkerGuard().catch((error: Error) => {
    // Chromium-only, and a context handed over CDP may not expose a Browser.
    // Not fatal — but it must not be silent either, because the realm it
    // covers is the one nothing else can see.
    log(`[egress] Worker guard unavailable: ${error.message}`);
  });

  /**
   * A host that sets an Akamai cookie is a host behind Akamai — and that is
   * all it is.
   *
   * It used to call `markAkamai`, which condemned the host and the URL's
   * directory together. The test cannot carry that weight, and its own
   * comment said so: the edge sets `_abck` and `bm_sz` on every protected
   * page, so on a protected host this matches everything. On a pure challenge
   * CDN that is harmless; on a first-party application host behind the same
   * edge it denies the application. ANA's booking engine answered once on
   * `/webapps/reservation/flight-search`, the host was condemned, and the
   * search POST was aborted as a beacon.
   *
   * So it admits the host to discovery scope and marks nothing. The sensor
   * and the bundle on that host are still adopted, stubbed and replaced —
   * that is what scope buys — and its challenge endpoints are named one at a
   * time, by the effect test, the way the origin's always were.
   */
  context.on('response', (response) => {
    const url = new URL(response.url());
    if (protectedHosts.has(url.host)) return;
    void response
      .headersArray()
      .then((headers) => {
        for (const header of headers) {
          if (header.name.toLowerCase() !== 'set-cookie') continue;
          const name = header.value.split('=')[0]?.trim() ?? '';
          if (!AKAMAI_COOKIE.test(name)) continue;
          markProtected(url.host);
          return;
        }
      })
      .catch(() => undefined);
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
  const sendFromPage = async (
    frame: Frame,
    args: {
      body: string;
      headers: Record<string, string> | undefined;
      url: string;
    }
  ): Promise<{ body: string; status: number }> => {
    try {
      return await frame.evaluate(
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
   * In-flight and completed `_abck` lanes, by host.
   *
   * A second call for a host already being solved joins the first rather than
   * opening a second session against the same document: two sessions racing
   * one jar is how a round lands against the wrong `_abck`.
   */
  const lanes = new Map<string, Promise<void>>();
  /** Hosts with a lane actually running, as opposed to one already finished. */
  const lanesRunning = new Set<string>();

  /** Stateful lane: init, then answer every submission out of that frame. */
  async function solveAbck(runOpts: SolveAbckOptions = {}): Promise<void> {
    const siteHost = runOpts.host ?? originHost;
    const running = lanes.get(siteHost);
    if (running) return running;
    lanesRunning.add(siteHost);
    const started = solveAbckFor(siteFor(siteHost), runOpts).finally(() => {
      lanesRunning.delete(siteHost);
    });
    lanes.set(siteHost, started);
    return started;
  }

  /**
   * Solve every host that has a sensor and has not been solved yet.
   *
   * Sequential, not parallel. There is one browser and one jar behind these:
   * two lanes in flight would interleave sensor submissions from different
   * documents, and Akamai scores them against the cookie state at the moment
   * each arrives.
   *
   * Errors are collected rather than thrown one at a time, so one peer realm
   * that cannot be solved does not hide the result for the rest.
   */
  async function solveAll(runOpts: SolveAbckOptions = {}): Promise<string[]> {
    const solved: string[] = [];
    const failures: string[] = [];
    for (const site of [...sites.values()]) {
      if (!site.bmMain || site.accepted || lanes.has(site.host)) continue;
      try {
        await solveAbck({ ...runOpts, host: site.host });
        solved.push(site.host);
      } catch (error) {
        failures.push(`${site.host}: ${(error as Error).message}`);
      }
    }
    if (failures.length > 0)
      log(`[abck] Unsolved realm(s) — ${failures.join('; ')}`);
    return solved;
  }

  async function solveAbckFor(
    site: HostState,
    runOpts: SolveAbckOptions
  ): Promise<void> {
    const waitForAcceptance = runOpts.waitForAcceptance ?? true;
    const idleMs = runOpts.idleMs ?? 15_000;
    const minRounds = runOpts.minRounds ?? 3;
    // Fail closed first. Without this, a build that defeated discovery threw
    // `no _abck sensor script was captured` — a sentence that reads as a
    // correct diagnosis of a different property, from a run in which nothing
    // was intercepted at all.
    //
    // `ready` is the ORIGIN's gate and is awaited only for the origin: a peer
    // realm discovered mid-run has its own sensor or it has nothing, and
    // holding it behind the document host's channel check would make a second
    // property's solve depend on the first property's shape.
    if (site.host === originHost) await ready;
    if (!site.bmMain) {
      throw new Error(
        sensor === 'page'
          ? 'attach() was given sensor: "page", so the sensor script was ' +
              'never captured — the page is answering _abck itself'
          : `no _abck sensor script was captured on ${site.host} — ` +
              'if the property only runs SBSD, do not call solveAbck()'
      );
    }
    const frame = frameFor(site.host);
    if (!frame)
      throw new Error(
        `no live frame on ${site.host} to answer its _abck rounds from. The ` +
          "submission has to travel on the browser's connection from a " +
          'document on that host, or it carries the wrong origin and the ' +
          'wrong jar — navigate there before solving it.'
      );
    /**
     * The document, read once the frame has stopped moving.
     *
     * `frame.content()` throws "Unable to retrieve content because the page is
     * navigating" when a document commits mid-read — measured on aa.com, 750ms
     * after `settle()` returned. The settle is a heuristic about the bootstrap;
     * this is the same instant expressed as a fact, so it is worth waiting for
     * here rather than widening the heuristic. One retry, then the navigation
     * message that says what to do about it.
     */
    const readDocument = async (): Promise<string> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await frame.content();
        } catch {
          await frame
            .waitForLoadState('domcontentloaded')
            .catch(() => undefined);
        }
      }
      throw new Error(
        `could not read ${site.host}'s document: it navigated while the lane ` +
          `was opening. On a property that runs SBSD the first document is a ` +
          `bootstrap that reloads itself once its carrier is answered — wait ` +
          `for the document you actually want before solving.`
      );
    };

    const captured = site.bmMain;
    log(
      `[abck] Opening session against ${captured.url} ` +
        `(_abck=${(await cookies(site.host))['_abck']?.split('~')[1] ?? 'absent'})`
    );
    const socket = new WebSocket(sessionUrl, {
      ...(solverApiKey ? { headers: { 'x-api-key': solverApiKey } } : {}),
    });
    await new Promise((resolve) =>
      socket.addEventListener('open', resolve, { once: true })
    );
    socket.send(
      JSON.stringify({
        cookies: await cookies(site.host),
        // Scripts stripped: the solver models the document, and the sensor
        // source is sent separately as `script`.
        html: (await readDocument()).replace(
          /<script\b[\s\S]*?<\/script>/giu,
          ''
        ),
        mode: 'abck',
        profileId: PROFILE_ID,
        script: captured.body,
        scriptUrl: captured.url,
        type: 'init',
        url: frame.url(),
      })
    );

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let answeredSubmissions = 0;
      let idleTimer: null | ReturnType<typeof setTimeout> = null;
      const stopIdle = (): void => {
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = null;
      };
      // Both exits close the socket. Leaving it open holds the event loop and
      // the solver-side session together, and the caller is done either way.
      const finish = (): void => {
        if (settled) return;
        settled = true;
        stopIdle();
        socket.close();
        resolve();
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        stopIdle();
        socket.close();
        reject(error);
      };
      /**
       * The `waitForAcceptance: false` exit.
       *
       * Armed only once a submission has been answered, so a solver that
       * never sends one still hangs rather than returning a session in which
       * nothing happened
       */
      const armIdle = (): void => {
        if (waitForAcceptance || settled || answeredSubmissions === 0) return;
        stopIdle();
        // Under the floor, wait longer before believing the ladder is over.
        const patient = answeredSubmissions < minRounds;
        idleTimer = setTimeout(
          () => {
            void (async () => {
              const rval =
                (await cookies(site.host))['_abck']?.split('~')[1] ?? 'absent';
              log(
                `[abck] ${site.host} lane ended on the idle timer after ` +
                  `${answeredSubmissions} round(s), _abck=~${rval}~` +
                  (answeredSubmissions < minRounds
                    ? ` — BELOW the ${minRounds}-round floor, so the solver ` +
                      `stopped early rather than this hanging up`
                    : '')
              );
              finish();
            })();
          },
          patient ? idleMs * 3 : idleMs
        );
        idleTimer.unref?.();
      };

      // Let the event type come from undici's WebSocket rather than annotating
      // it: the DOM's MessageEvent is a different, incompatible declaration.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      socket.addEventListener('message', async (event) => {
        const message = JSON.parse(
          (event as { data: string }).data
        ) as SolverMessage;
        stopIdle();
        // Everything below is wrapped because this is an event listener: an
        // async handler that rejects has nobody to reject TO, so undici
        // rethrows it on `process.nextTick` and takes the whole process
        // down. A navigation mid-lane is the ordinary way that happens —
        // the bootstrap reloads and `frame.evaluate` loses its context —
        // and it should fail this frame's lane, which `solveAll` already
        // collects, not the run.
        try {
          if (message.type === 'submission') {
            site.authorizedSensorBody = message.body ?? '';
            site.authorizedSensorUrl = message.url ?? '';
            // Authorship, for the conservation pair. The router increments
            // `postsAllowed` when this body turns up on a request; counting the
            // issue here rather than there is what keeps the pair from being
            // two names for the same event.
            site.solverBodiesIssued++;
            stats.solverBodiesIssued++;
            const result = await sendFromPage(frame, {
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
                cookies: await cookies(site.host),
                id: message.id,
                status: result.status,
                type: 'submission_response',
              })
            );
            answeredSubmissions++;
            site.rounds++;
          }

          if (message.type === 'cookie_update') {
            log(
              `[abck] Cookie update: round=${message.round} ` +
                `rval=${message.rval} accepted=${message.accepted}`
            );
          }

          if (message.type === 'status' && message.state === 'accepted') {
            site.accepted = true;
            log(
              `[abck] ${site.host} accepted after ${answeredSubmissions} round(s)`
            );
            finish();
            return;
          }

          if (message.type === 'error') {
            fail(new Error(message.message ?? 'solver reported an error'));
            return;
          }

          armIdle();
        } catch (error) {
          fail(error as Error);
        }
      });

      socket.addEventListener('close', ({ code, reason }) => {
        // Not a failure when the caller never asked for acceptance and the
        // lane did its work: a solver that closes after its last submission
        // is a normal end to a run that was only ever going to walk rounds.
        if (!waitForAcceptance && answeredSubmissions > 0) {
          log(
            `[abck] ${site.host} lane ended: the solver closed the socket ` +
              `after ${answeredSubmissions} round(s) (${code} ${reason})`
          );
          finish();
          return;
        }
        fail(
          new Error(
            `session socket closed before acceptance: ${code} ${reason}`
          )
        );
      });
    });
  }

  const dispose = async (): Promise<void> => {
    if (discoveryTimer !== null) clearTimeout(discoveryTimer);
    try {
      await context.unrouteAll({ behavior: 'ignoreErrors' });
    } catch {
      // The context may already be closing; nothing left to retire.
    }
    try {
      await workerGuard?.detach();
    } catch {
      // Same.
    }
  };

  return {
    carriersAnswered: () => totalAnswered(),
    dispose,
    installed,
    ready,
    realms: () =>
      [...sites.values()]
        .filter((site) => site.bmMain !== null || site.sbsdPath !== null)
        .map((site) => ({
          accepted: site.accepted,
          hasAbck: site.bmMain !== null,
          hasSbsd: site.sbsdPath !== null,
          host: site.host,
          rounds: site.rounds,
        })),
    solveAbck,
    solveAll,
    stats: () => {
      for (const site of sites.values()) checkConserved(site);
      return {
        ...stats,
        byHost: Object.fromEntries(
          [...sites.values()]
            .filter(
              (site) => site.postsAllowed > 0 || site.solverBodiesIssued > 0
            )
            .map((site) => [
              site.host,
              {
                carriersAnswered: site.answered,
                postsAllowed: site.postsAllowed,
                solverBodiesIssued: site.solverBodiesIssued,
              },
            ])
        ),
      };
    },
  };
}
