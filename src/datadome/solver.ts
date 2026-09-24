/**
 * This is a Playwright library file, not a script. It exposes a `solve`
 * function you add to Playwright scripts to integrate with the xhr.dev
 * on-prem solver for anti-bot solving. See src/datadome/grainger.ts for a
 * runnable example, or src/datadome/grainger-undici.ts to do the same thing
 * without a browser.
 *
 * DataDome browser bridge.
 *
 * This file is long, but it only does one thing: it lets a Playwright page
 * walk through a DataDome challenge. The division of labour is the key idea —
 *
 *   the solver  computes the sensor values (the hard, proprietary part)
 *   Chrome      makes every request (so the TLS fingerprint, headers and
 *               cookie jar are genuinely a browser's, not ours)
 *
 * We never forge the submission ourselves. We hand Chrome a payload and let
 * it send the native interstitial POST or captcha callback GET, take
 * DataDome's response, apply the cookie, and navigate to the target.
 *
 * ## The flow
 *
 *   1. Watch for a challenge document (`geo.captcha-delivery.com`).
 *   2. Read the challenge parameters out of the page.
 *   3. POST them to `/dd/solve`; get a prepared submission back.
 *   4. Splice that payload into the request Chrome is already making.
 *   5. Repeat for as long as DataDome keeps asking. An interstitial (`i`)
 *      turning into a captcha (`c`) is the common case, but nothing here
 *      counts challenges or insists on a particular order: whatever is on
 *      screen gets answered.
 *   6. Resolve once a navigation succeeds with the accepted cookie.
 *
 * ## Only one thing is unsolvable
 *
 * A captcha document with no slider in it is DataDome's block page. It looks
 * like a captcha in the `dd` object — `rt: "c"` all the same — but there is
 * no puzzle on the page, so there is nothing to send. That is the one failure
 * this bridge declares on its own. A rejected submission, a re-served
 * challenge, a challenge that swaps type mid-flight: all of those just mean
 * another challenge to answer.
 *
 * ## Nothing here reloads the page
 *
 * The challenge script treats a failed subresource as a reason to start over,
 * so this file never aborts a DataDome request and never navigates on its own.
 * A carrier it cannot use is passed through untouched. Every navigation in the
 * flow is one the challenge script chose to make.
 *
 * ## Reading this file
 *
 * Everything below `solve` is a helper, in alphabetical order. The parts
 * worth knowing:
 *
 *   solve()                     the entry point and the challenge loop
 *   callSolver()                the one HTTP call to xhr.dev
 *   parseChallenge()            challenge params out of a document URL
 *   buildCaptchaRelayUrl()      splices the solved payload into a captcha GET
 *   buildInterstitialRelayBody() the same for an interstitial POST
 *   sampleChallengeFrame()      reads the live browser surfaces (screen,
 *                               languages, connection) that go to the solver
 *
 * The rest is validation. It is deliberately strict: a challenge that half
 * matches expectations means the protocol moved, and failing loudly there is
 * much easier to debug than a silently wrong payload.
 */
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Cookie,
  Frame,
  Page,
  Request,
  Response,
  Route,
} from 'playwright-core';

import {
  GEO_HOST,
  GEO_ORIGIN,
  PROFILE,
  PROFILE_ID,
} from '#src/datadome/profile.js';
import { BannedError } from '#src/datadome/ban.js';
import {
  buildCaptchaLayout,
  CAPTCHA_HANDLE_SELECTOR,
  CAPTCHA_LAYOUT_SETTLE_MS,
  CAPTCHA_LAYOUT_TIMEOUT_MS,
  type CaptchaLayout,
} from '#src/datadome/captcha-layout.js';
import {
  type ExternalScript,
  externalScriptUrl,
  extractExternalScriptUrls,
} from '#src/datadome/external-scripts.js';
import { collectStylesheetAssets } from '#src/datadome/stylesheets.js';
import { checkRateLimit } from '#src/rate-limit.js';

type CaptchaRelayContext = {
  headers: Readonly<Record<string, string | undefined>>;
  solved: CaptchaSolverResult;
  url: string;
};

type CaptchaSolverResult = {
  origin: string;
  referer: string;
  type: 'captcha';
  url: string;
};

type ChallengeIr = number | string;

type DataDomeChallenge = {
  b?: number;
  cid: string;
  e?: string;
  hsh: string;
  ir?: ChallengeIr;
  rt: 'c' | 'i';
  s: number;
  t?: string;
};

type InterstitialSolverResult = {
  body: string;
  origin: string;
  referer: string;
  type: 'interstitial';
  url: string;
};

type PreparedSubmission = CaptchaSolverResult | InterstitialSolverResult;

type RawField = {
  decodedName: string;
  decodedValue: string;
  rawName: string;
  rawSegment: string;
  rawValue: string;
};

const CAPTCHA_SENSOR_FIELDS = new Set(['ddCaptchaEncodedPayload', 'plv3']);
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=UTF-8';
const CAPTCHA_CHECK_URL = `${GEO_ORIGIN}/captcha/check`;
const INTERSTITIAL_URL = `${GEO_ORIGIN}/interstitial/`;
const MAX_SOLVER_ERROR_DETAIL_LENGTH = 1000;

export type SolveOptions = {
  proxy?: string;
  solverApiKey?: string;
  solverUrl: string;
  timeout?: number;
  url: string;
};

export type SolveResult = {
  cookie: string;
  responseStatus: number;
  url: string;
};

/**
 * One challenge, read and priced. There is no numbering and no history: the
 * page either has a challenge on screen or it does not, and if it puts a new
 * one up, that one replaces this.
 */
type Attempt = {
  challenge: ChallengeData;
  document: ChallengeDocumentData;
  solver: Promise<PreparedSubmission>;
};

type ChallengeData = {
  cookie: Cookie;
  dd: DataDomeChallenge;
  pageUrl: string;
};

type ChallengeDocumentData = {
  finalNavigationResponseBodySizes: {
    decodedBodySize: number;
    encodedBodySize: number;
  };
  frame: Frame;
  html: string;
  surfaces: FrameSurfaces;
  url: string;
};

/**
 * The slot the challenge on screen occupies. Opened the moment a challenge
 * document response is seen — synchronously, before it is read — so that the
 * submission the challenge script makes can be matched to it without anyone
 * counting anything. `superseded` resolves with the slot that replaced it.
 */
type ChallengeSlot = {
  attempt: Deferred<Attempt>;
  nativeSubmitStarted: Deferred<undefined>;
  superseded: Deferred<ChallengeSlot>;
};

type Deferred<T> = {
  promise: Promise<T>;
  // eslint-disable-next-line no-unused-vars -- function-type parameter
  reject(error: Error): void;
  // eslint-disable-next-line no-unused-vars -- function-type parameter
  resolve(value: T): void;
  readonly settled: boolean;
};

type FrameSurfaces = {
  connection?: {
    downlink: number;
    effectiveType: string;
    rtt: number;
    saveData: boolean;
  };
  languages: string[];
  nextHopProtocol: string;
  screen: WindowGeometry;
};

type NavigationResult = {
  status: number;
  url: string;
};

type RawChannel = {
  id: string;
  parent?: RawChannel;
  sessionId?: string;
};

type RawMessage = {
  error?: { message?: string };
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
};

type WindowGeometry = {
  availHeight: number;
  availLeft: number;
  availTop: number;
  availWidth: number;
  colorDepth: number;
  devicePixelRatio: number;
  height: number;
  innerHeight: number;
  innerWidth: number;
  outerHeight: number;
  outerWidth: number;
  pixelDepth: number;
  screenX: number;
  screenY: number;
  width: number;
};

/** Replace only the two sensor fields in Chrome's native captcha XHR URL. */
function buildCaptchaRelayUrl(context: CaptchaRelayContext): string {
  if (requestHeader(context.headers, 'referer') !== context.solved.referer) {
    throw new Error('The native and sandbox captcha Referer did not match');
  }
  if (requestHeader(context.headers, 'content-type') !== FORM_CONTENT_TYPE) {
    throw new Error(
      'The native captcha carrier used an unexpected Content-Type'
    );
  }

  const native = parseCaptchaCarrierUrl(context.url, 'native');
  const solved = parseCaptchaCarrierUrl(context.solved.url, 'sandbox');
  const nativeByName = new Map(
    native.fields.map((field) => [field.decodedName, field])
  );
  const solvedByName = new Map(
    solved.fields.map((field) => [field.decodedName, field])
  );
  if (nativeByName.has('ddCaptchaResponse')) {
    throw new Error('The native captcha carrier already contained a response');
  }
  const nativeCid = nativeByName.get('cid')?.decodedValue;
  const solvedCid = solvedByName.get('cid')?.decodedValue;
  if (!nativeCid || solvedCid !== nativeCid) {
    throw new Error(
      'The sandbox captcha cid did not match the native Chrome carrier'
    );
  }

  const relayed = native.fields.map((field) =>
    CAPTCHA_SENSOR_FIELDS.has(field.decodedName)
      ? solvedByName.get(field.decodedName)?.rawSegment
      : field.rawSegment
  );
  for (const sensor of CAPTCHA_SENSOR_FIELDS) {
    if (nativeByName.has(sensor)) continue;
    relayed.push(solvedByName.get(sensor)?.rawSegment);
  }
  if (relayed.some((field) => field === undefined)) {
    throw new Error('The sandbox captcha carrier omitted a sensor field');
  }

  return `${native.baseUrl}?${relayed.join('&')}`;
}

/** Replace only payload and plv3 in Chrome's ordered interstitial form. */
function buildInterstitialRelayBody(
  nativeBody: string,
  solvedBody: string
): string {
  const nativeFields = parseRawSubmitForm(nativeBody);
  const solvedFields = parseRawSubmitForm(solvedBody);
  const nativeByName = new Map(
    nativeFields.map((field) => [field.decodedName, field])
  );
  const solvedByName = new Map(
    solvedFields.map((field) => [field.decodedName, field])
  );
  const nativeCid = nativeByName.get('cid')?.decodedValue;
  if (!nativeCid || solvedByName.get('cid')?.decodedValue !== nativeCid) {
    throw new Error(
      'The sandbox interstitial cid did not match the native Chrome carrier'
    );
  }
  return nativeFields
    .map((field) =>
      field.decodedName === 'payload' || field.decodedName === 'plv3'
        ? solvedByName.get(field.decodedName)?.rawSegment
        : field.rawSegment
    )
    .join('&');
}

function challengeIrValue(value: unknown): ChallengeIr | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parts = value.split(',');
  if (parts.length > 1) {
    return parts.every(isUnsignedInteger) ? value : undefined;
  }
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  if (!isUnsignedInteger(unsigned)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isUnsignedInteger(value: string): boolean {
  if (value.length === 0) return false;
  for (const character of value) {
    if (character < '0' || character > '9') return false;
  }
  return true;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCaptchaCarrierUrl(
  value: string,
  source: 'native' | 'sandbox'
): { baseUrl: string; fields: RawField[] } {
  const queryIndex = value.indexOf('?');
  const baseUrl = queryIndex < 0 ? value : value.slice(0, queryIndex);
  const rawQuery = queryIndex < 0 ? '' : value.slice(queryIndex + 1);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`The ${source} captcha carrier URL was malformed`);
  }
  if (
    baseUrl !== CAPTCHA_CHECK_URL ||
    url.origin !== GEO_ORIGIN ||
    url.pathname !== '/captcha/check' ||
    url.hash !== '' ||
    rawQuery.length === 0
  ) {
    throw new Error(`The ${source} captcha carrier used an unexpected URL`);
  }

  const fields: RawField[] = [];
  const names = new Set<string>();
  for (const rawSegment of rawQuery.split('&')) {
    const separator = rawSegment.indexOf('=');
    if (separator <= 0) {
      throw new Error(`The ${source} captcha carrier query was malformed`);
    }
    const rawName = rawSegment.slice(0, separator);
    const rawValue = rawSegment.slice(separator + 1);
    let decodedName: string;
    let decodedValue: string;
    try {
      decodedName = decodeURIComponent(rawName.split('+').join(' '));
      decodedValue = decodeURIComponent(rawValue.split('+').join(' '));
    } catch {
      throw new Error(`The ${source} captcha carrier query was malformed`);
    }
    if (CAPTCHA_SENSOR_FIELDS.has(decodedName) && rawName !== decodedName) {
      throw new Error(
        `The ${source} captcha sensor field name was percent encoded`
      );
    }
    if (names.has(decodedName)) {
      throw new Error(`The ${source} captcha carrier duplicated a field`);
    }
    if (
      source === 'sandbox' &&
      CAPTCHA_SENSOR_FIELDS.has(decodedName) &&
      rawValue.length === 0
    ) {
      throw new Error(
        `The ${source} captcha carrier contained an empty sensor field`
      );
    }
    names.add(decodedName);
    fields.push({
      decodedName,
      decodedValue,
      rawName,
      rawSegment,
      rawValue,
    });
  }
  if (source === 'sandbox') {
    for (const sensorName of CAPTCHA_SENSOR_FIELDS) {
      if (!names.has(sensorName)) {
        throw new Error(`The ${source} captcha carrier omitted a sensor field`);
      }
    }
  }
  return { baseUrl, fields };
}

/** Parse the structured challenge required by `/dd/solve` from its document URL. */
function parseChallenge(input: string): DataDomeChallenge | null {
  let url: URL;
  try {
    url = new URL(input.split('&amp;').join('&'));
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== GEO_HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    return null;
  }

  const rt =
    url.pathname === '/captcha/'
      ? 'c'
      : url.pathname === '/interstitial/'
        ? 'i'
        : null;
  if (!rt) return null;

  const cid =
    url.searchParams.get('initialCid') ??
    (rt === 'i' ? url.searchParams.get('cid') : null);
  const hsh = url.searchParams.get('hash');
  if (!cid || !hsh) return null;

  const rawIr = url.searchParams.get('ir');
  const ir = challengeIrValue(rawIr);
  if (rawIr !== null && ir === undefined) return null;
  const b = numberValue(url.searchParams.get('b'));
  const e = url.searchParams.get('e') || undefined;
  const s = numberValue(url.searchParams.get('s')) ?? 0;
  const t = url.searchParams.get('t') || undefined;
  return {
    ...(b === undefined ? {} : { b }),
    cid,
    ...(e === undefined ? {} : { e }),
    hsh,
    ...(ir === undefined ? {} : { ir }),
    rt,
    s,
    ...(t === undefined ? {} : { t }),
  };
}

function parseRawSubmitForm(body: string): RawField[] {
  if (body.length === 0) throw new Error('A DataDome submit form was empty');
  const fields: RawField[] = [];
  const names = new Set<string>();
  const sensors = new Set(['payload', 'plv3']);
  for (const rawSegment of body.split('&')) {
    const separator = rawSegment.indexOf('=');
    if (separator <= 0) throw new Error('A DataDome submit form was malformed');
    const rawName = rawSegment.slice(0, separator);
    const rawValue = rawSegment.slice(separator + 1);
    let decodedName: string;
    let decodedValue: string;
    try {
      decodedName = decodeURIComponent(rawName.split('+').join(' '));
      decodedValue = decodeURIComponent(rawValue.split('+').join(' '));
    } catch {
      throw new Error('A DataDome submit field was malformed');
    }
    if (sensors.has(decodedName) && rawName !== decodedName) {
      throw new Error('A DataDome sensor field name was percent encoded');
    }
    if (names.has(decodedName)) {
      throw new Error('A DataDome submit field name was duplicated');
    }
    if (sensors.has(rawName) && rawValue.length === 0) {
      throw new Error('A DataDome sensor field was empty');
    }
    names.add(decodedName);
    fields.push({
      decodedName,
      decodedValue,
      rawName,
      rawSegment,
      rawValue,
    });
  }
  for (const sensor of sensors) {
    if (!names.has(sensor))
      throw new Error('A DataDome sensor field was missing');
  }
  return fields;
}

function requestHeader(
  headers: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  const expected = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === expected) return value;
  }
  return undefined;
}

/** Select the cookie identity appropriate to the live challenge document. */
function solverCookieForChallengeDocument(
  type: DataDomeChallenge['rt'],
  documentUrl: string,
  targetCookie: string
): string {
  if (type !== 'c') return targetCookie;

  let url: URL;
  try {
    url = new URL(documentUrl);
  } catch {
    throw new Error('The captcha document URL was malformed');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== GEO_HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/captcha/' ||
    url.hash !== ''
  ) {
    throw new Error('The captcha document did not use the canonical URL');
  }

  const cidValues = url.searchParams.getAll('cid');
  if (cidValues.length === 0 || cidValues[0] === '') {
    throw new Error('The captcha document URL did not contain a cid');
  }
  if (cidValues.length !== 1) {
    throw new Error('The captcha document URL contained an ambiguous cid');
  }
  const cid = cidValues[0];
  if (!cid) throw new Error('The captcha document URL contained an empty cid');
  return cid;
}

/** Validate and narrow the raw `/dd/solve` response. */
function validateSolverResult(
  raw: unknown,
  type: DataDomeChallenge['rt']
): PreparedSubmission {
  if (!isRecord(raw)) throw new Error('Solver returned an invalid response');

  const body = raw['body'];
  const origin = raw['origin'];
  const referer = raw['referer'];
  const rawUrl = raw['url'];
  if (
    origin !== GEO_ORIGIN ||
    typeof referer !== 'string' ||
    referer.length === 0 ||
    typeof rawUrl !== 'string' ||
    rawUrl.length === 0
  ) {
    throw new Error('Solver response was incomplete');
  }

  let url: URL;
  try {
    url = new URL(rawUrl, origin);
  } catch {
    throw new Error('Solver returned a malformed carrier URL');
  }

  if (type === 'i') {
    if (typeof body !== 'string' || body.length === 0) {
      throw new Error('Interstitial solver response omitted its body');
    }
    if (url.href !== INTERSTITIAL_URL) {
      throw new Error('Solver returned an unexpected interstitial URL');
    }
    return {
      body,
      origin,
      referer,
      type: 'interstitial',
      url: url.href,
    };
  }

  if (body !== undefined && body !== null) {
    throw new Error('Captcha solver response unexpectedly contained a body');
  }
  if (url.origin !== GEO_ORIGIN || url.pathname !== '/captcha/check') {
    throw new Error('Solver returned an unexpected captcha URL');
  }
  return {
    origin,
    referer,
    type: 'captcha',
    url: url.href,
  };
}

const CHALLENGE_ROUTE = 'https://geo.captcha-delivery.com/**';
const DD_TAGS_ROUTE = '*://dd.*/**/tags.js*';
const QUIET_WINDOW_MS = 5000;
const TIMEOUT = 120000;

const UA_OVERRIDE = {
  acceptLanguage: 'en-US,en',
  platform: 'MacIntel',
  userAgent: PROFILE.userAgent,
  userAgentMetadata: {
    architecture: 'arm',
    bitness: '64',
    brands: PROFILE.brands.map(({ brand, version }) => ({ brand, version })),
    formFactors: ['Desktop'],
    fullVersion: PROFILE.chromeFullVersion,
    fullVersionList: PROFILE.brands.map(({ brand, version }) => ({
      brand,
      version:
        brand === 'Google Chrome' || brand === 'Chromium'
          ? PROFILE.chromeFullVersion
          : `${version}.0.0.0`,
    })),
    mobile: false,
    model: '',
    platform: 'macOS',
    platformVersion: PROFILE.platformVersion,
    wow64: false,
  },
};

const log = (message: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${message}`, ...extra);

/** Solve however many DataDome challenges the page decides to serve. */
export async function solve(
  page: Page,
  options: SolveOptions
): Promise<SolveResult> {
  const { proxy, solverApiKey, solverUrl, timeout = TIMEOUT, url } = options;
  const targetUrl = httpUrl(url, 'target');
  const solverBaseUrl = httpUrl(solverUrl, 'solver');
  const browser = requiredBrowser(page);
  const context = page.context();
  await checkHealth(solverBaseUrl, timeout, solverApiKey);

  const fatal = deferred<never>();
  void fatal.promise.catch(() => undefined);
  const accepted = deferred<NavigationResult>();
  const carriers = new Set<Request>();
  const challengeSlots = new Map<Response, ChallengeSlot>();
  const firstSlot = deferred<ChallengeSlot>();
  let currentSlot: ChallengeSlot | undefined;
  let relayed = false;
  let failed = false;
  let responseQueue = Promise.resolve();

  const fail = (error: unknown): void => {
    if (failed) return;
    failed = true;
    fatal.reject(asError(error));
  };

  // Opened the instant a challenge document response is seen, before any of
  // the asynchronous work of reading it — so a carrier request that races
  // that work still waits for *this* challenge's payload and never picks up
  // the one before it.
  const openSlot = (): ChallengeSlot => {
    const slot: ChallengeSlot = {
      attempt: deferred<Attempt>(),
      nativeSubmitStarted: deferred<undefined>(),
      superseded: deferred<ChallengeSlot>(),
    };
    currentSlot?.superseded.resolve(slot);
    currentSlot = slot;
    firstSlot.resolve(slot);
    return slot;
  };

  const externalScriptBodies = new Map<string, Deferred<string>>();
  const externalScriptBody = (url: string): Deferred<string> => {
    let entry = externalScriptBodies.get(url);
    if (!entry) {
      entry = deferred<string>();
      void entry.promise.catch(() => undefined);
      externalScriptBodies.set(url, entry);
    }
    return entry;
  };
  const onScriptResponse = (response: Response): void => {
    if (response.request().resourceType() !== 'script' || !response.ok()) {
      return;
    }
    const url = externalScriptUrl(response.url());
    if (!url) return;
    const entry = externalScriptBody(url);
    if (entry.settled) return;
    response.body().then(
      (body) => entry.resolve(body.toString('utf8')),
      (error: unknown) => entry.reject(asError(error))
    );
  };
  const awaitExternalScript = (url: string): Promise<string> =>
    waitFor(
      externalScriptBody(url).promise,
      `the challenge's external script ${url}`,
      timeout,
      fatal.promise
    );

  const processChallengeDocument = async (
    slot: ChallengeSlot,
    response: Response,
    type: DataDomeChallenge['rt']
  ): Promise<void> => {
    const request = response.request();
    const frame = response.frame();
    if (
      request.method() !== 'GET' ||
      request.resourceType() !== 'document' ||
      !request.isNavigationRequest() ||
      frame.parentFrame() !== page.mainFrame() ||
      !response.ok()
    ) {
      throw new Error('Unexpected DataDome challenge document');
    }

    const dd = parseChallenge(request.url());
    if (!dd || dd.rt !== type) {
      throw new Error('The challenge document identity could not be parsed');
    }
    const cookie = selectTargetCookie(
      await context.cookies(targetUrl.href),
      targetUrl
    );
    if (!cookie) {
      throw new Error('The challenge lost its target cookie');
    }
    const challenge: ChallengeData = { cookie, dd, pageUrl: targetUrl.href };
    log(`DataDome ${type === 'c' ? 'captcha' : 'interstitial'} detected`);

    const [body, sizes] = await Promise.all([response.body(), request.sizes()]);
    const surfaces = await sampleChallengeFrame(page.mainFrame(), frame);
    const html = body.toString('utf8');
    // A captcha document with no slider in it is not a captcha we can answer:
    // it is the block page DataDome serves when it has already decided. That
    // is the one thing this bridge treats as unsolvable. Checked after the
    // body is in hand, because waiting first risks losing it to a navigation.
    if (type === 'c') await assertCaptchaSlider(frame, slot, timeout);
    if (!html.includes('<script')) {
      throw new Error('The challenge document did not contain a script');
    }
    const document: ChallengeDocumentData = {
      finalNavigationResponseBodySizes: {
        decodedBodySize: body.byteLength,
        encodedBodySize: Math.max(0, Math.round(sizes.responseBodySize)),
      },
      frame,
      html,
      surfaces,
      url: request.url(),
    };
    const solver = callSolver(
      solverBaseUrl,
      challenge,
      document,
      proxy,
      timeout,
      solverApiKey,
      awaitExternalScript
    ).catch((error: unknown) => {
      fail(error);
      throw error;
    });
    void solver.catch(() => undefined);
    log(`DataDome ${type === 'c' ? 'captcha' : 'interstitial'} document ready`);
    slot.attempt.resolve({ challenge, document, solver });
  };

  const processTargetDocument = async (response: Response): Promise<void> => {
    const request = response.request();
    if (
      request.frame() !== page.mainFrame() ||
      request.resourceType() !== 'document' ||
      !request.isNavigationRequest() ||
      new URL(response.url()).hostname !== targetUrl.hostname
    ) {
      return;
    }

    if (response.status() !== 403) {
      if (response.status() >= 200 && response.status() < 300 && relayed) {
        accepted.resolve({ status: response.status(), url: response.url() });
      }
      return;
    }

    const compactHtml = (await response.text()).replace(/\s/g, '');
    if (
      ["t:'bv'", 't:"bv"', "'t':'bv'", '"t":"bv"'].some((token) =>
        compactHtml.includes(token)
      )
    ) {
      throw new BannedError();
    }
    // Any other 403 is DataDome saying "challenge first". The challenge
    // document that follows opens its own slot; there is nothing to do here.
  };

  const processResponse = async (response: Response): Promise<void> => {
    const request = response.request();
    if (carriers.has(request)) {
      carriers.delete(request);
      log(`DataDome submission returned HTTP ${response.status()}`);
      return;
    }
    if (
      isInterstitialPost(request.method(), request.url()) ||
      isCaptchaCheck(request.method(), request.url())
    ) {
      throw new Error('A DataDome submission escaped the browser bridge');
    }
    const type = challengeDocumentType(request);
    if (type) {
      const slot = challengeSlots.get(response);
      if (!slot) throw new Error('A challenge document arrived without a slot');
      challengeSlots.delete(response);
      await processChallengeDocument(slot, response, type);
      return;
    }
    await processTargetDocument(response);
  };

  const onResponse = (response: Response): void => {
    // Rotate the slot synchronously, before the queued work below runs.
    if (challengeDocumentType(response.request())) {
      challengeSlots.set(response, openSlot());
    }
    responseQueue = responseQueue
      .then(() => processResponse(response))
      .catch((error: unknown) => fail(error));
  };

  const onRequestFailed = (request: Request): void => {
    if (!carriers.delete(request)) return;
    fail(
      new Error(
        `DataDome browser submission failed: ${request.failure()?.errorText ?? 'unknown network error'}`
      )
    );
  };

  const onBrowserDisconnected = (): void => {
    fail(new Error('Chrome disconnected before DataDome acceptance'));
  };

  const onPageClosed = (): void => {
    fail(new Error('The page closed before DataDome acceptance'));
  };

  const onPageCrashed = (): void => {
    log('Chrome page crashed');
    fail(new Error('The page crashed before DataDome acceptance'));
  };

  const routeHandler = async (
    route: Route,
    request: Request
  ): Promise<void> => {
    const interstitial = isInterstitialPost(request.method(), request.url());
    const captcha = isCaptchaCheck(request.method(), request.url());
    if (!interstitial && !captcha) {
      await route.continue();
      return;
    }

    // Whatever challenge is on screen when the carrier is created is the one
    // it belongs to. Nothing here ever aborts a DataDome request: an abort is
    // a failed subresource to the challenge script, and a failed subresource
    // is what makes it reload itself.
    const slot = currentSlot;
    if (!slot) {
      log('A DataDome submission appeared before any challenge; passing it on');
      await route.continue();
      return;
    }
    carriers.add(request);

    try {
      const attempt = await waitFor(
        slot.attempt.promise,
        'the challenge document',
        timeout,
        fatal.promise
      );
      // A carrier that does not belong to the challenge on screen is one the
      // page has already left behind — an interstitial POST that arrives
      // after the captcha replaced it, say. Its sensors would describe a
      // challenge that no longer exists, so let the browser's own request go
      // through untouched. DataDome will decline it and ask again, and the
      // challenge it asks with is one this loop answers like any other.
      const mine =
        request.resourceType() === 'xhr' &&
        request.frame() === attempt.document.frame &&
        (attempt.challenge.dd.rt === 'c' ? captcha : interstitial);
      if (!mine) {
        log('Passing on a carrier that is not this challenge’s');
        await route.continue();
        return;
      }
      slot.nativeSubmitStarted.resolve(undefined);

      const solved = await attempt.solver;
      if (slot.superseded.settled) {
        // The page moved on while the solver was working. These sensors
        // describe a challenge that is no longer on screen, so send the
        // browser's own request untouched rather than relay them.
        log('Passing on a carrier whose challenge the page replaced');
        await route.continue();
        return;
      }
      if (solved.type === 'captcha') {
        const relayUrl = buildCaptchaRelayUrl({
          headers: await request.allHeaders(),
          solved,
          url: request.url(),
        });
        log(`Relaying sandbox sensors in Chrome captcha GET`);
        relayed = true;
        await route.continue({ url: relayUrl });
        return;
      }

      await assertInterstitialCarrier(request, solved);
      const nativeBody = request.postData();
      if (!nativeBody) {
        throw new Error('The native interstitial POST body was unavailable');
      }
      const relayBody = buildInterstitialRelayBody(nativeBody, solved.body);
      log(`Relaying sandbox sensors in Chrome interstitial POST`);
      relayed = true;
      await route.continue({ postData: relayBody });
    } catch (error) {
      fail(error);
      await route.continue().catch(() => undefined);
    }
  };
  const blockDdTags = (route: Route, request: Request): Promise<void> => {
    const url = new URL(request.url());
    const isDdTags =
      request.resourceType() === 'script' &&
      url.hostname.startsWith('dd.') &&
      url.pathname.endsWith('/tags.js');
    return isDdTags ? route.abort('blockedbyclient') : route.fallback();
  };

  browser.on('disconnected', onBrowserDisconnected);
  page.on('close', onPageClosed);
  page.on('crash', onPageCrashed);
  page.on('response', onResponse);
  page.on('response', onScriptResponse);
  page.on('requestfailed', onRequestFailed);

  let browserSession: CDPSession | undefined;
  let closeIdentityBridge: (() => void) | undefined;
  let pageSession: CDPSession | undefined;
  let routeInstalled = false;
  let tagsRouteInstalled = false;
  try {
    await context.route(CHALLENGE_ROUTE, routeHandler);
    routeInstalled = true;
    await context.route(DD_TAGS_ROUTE, blockDdTags);
    tagsRouteInstalled = true;
    browserSession = await browser.newBrowserCDPSession();
    pageSession = await context.newCDPSession(page);
    await pageSession.send('Emulation.setUserAgentOverride', UA_OVERRIDE);
    const { targetInfo } = await pageSession.send('Target.getTargetInfo');
    if (!targetInfo.browserContextId) {
      throw new Error('Could not identify the Chrome browser context');
    }
    await setWindowGeometry(browserSession, pageSession, targetInfo.targetId);
    closeIdentityBridge = await installIdentityBridge(
      pageSession,
      targetInfo.browserContextId,
      fail
    );

    // Answer the challenge on screen. An interstitial's carrier fires on its
    // own; a captcha's has to be asked for. Errors here are only fatal while
    // this challenge is still the one on screen — once the page has replaced
    // it, a dead frame is expected, not a fault.
    const driveAttempt = (slot: ChallengeSlot, attempt: Attempt): void => {
      void (async () => {
        try {
          await waitFor(
            attempt.solver,
            'the prepared submission',
            timeout,
            fatal.promise
          );
          if (attempt.challenge.dd.rt === 'c') {
            const giveUp = Promise.race<never>([
              fatal.promise,
              slot.superseded.promise.then(() => {
                throw new Error('The challenge was replaced');
              }),
            ]);
            void giveUp.catch(() => undefined);
            await triggerPassiveCaptchaCarrier(
              attempt.document.frame,
              slot.nativeSubmitStarted,
              timeout,
              giveUp
            );
          }
        } catch (error) {
          if (slot.superseded.settled) {
            log(`Abandoning a replaced challenge: ${asError(error).message}`);
            return;
          }
          fail(error);
        }
      })();
    };

    const initialNavigation = page
      .goto(targetUrl.href, { timeout, waitUntil: 'domcontentloaded' })
      .catch((error: unknown) => {
        if (!currentSlot) fail(error);
        return null;
      });

    let slot = await waitFor(
      firstSlot.promise,
      'a DataDome challenge',
      timeout,
      fatal.promise
    );
    let answered: Attempt | undefined;
    let navigation: NavigationResult | undefined;
    while (!navigation) {
      const attempt = await waitFor(
        slot.attempt.promise,
        'the challenge document',
        timeout,
        fatal.promise
      );
      answered = attempt;
      driveAttempt(slot, attempt);
      const outcome = await waitFor(
        Promise.race<
          | { kind: 'accepted'; navigation: NavigationResult }
          | { kind: 'replaced'; slot: ChallengeSlot }
        >([
          accepted.promise.then((value) => ({
            kind: 'accepted' as const,
            navigation: value,
          })),
          slot.superseded.promise.then((value) => ({
            kind: 'replaced' as const,
            slot: value,
          })),
        ]),
        'DataDome acceptance',
        timeout,
        fatal.promise
      );
      if (outcome.kind === 'accepted') navigation = outcome.navigation;
      else slot = outcome.slot;
    }

    if (!answered) throw new Error('DataDome acceptance lost its challenge');
    const cookie = await waitForCookieRotation(
      context,
      answered.challenge,
      timeout,
      fatal.promise
    );
    await raceFatal(initialNavigation, fatal.promise);
    await waitFor(
      delay(QUIET_WINDOW_MS),
      'acceptance window',
      QUIET_WINDOW_MS + 1000,
      fatal.promise
    );
    await responseQueue;
    if (
      slot.superseded.settled ||
      new URL(page.url()).hostname !== targetUrl.hostname ||
      navigation.status >= 400
    ) {
      throw new Error('DataDome acceptance could not be proven');
    }

    log(`DataDome acceptance proven with HTTP ${navigation.status}`);
    return {
      cookie: cookie.value,
      responseStatus: navigation.status,
      url: page.url(),
    };
  } finally {
    browser.removeListener('disconnected', onBrowserDisconnected);
    page.removeListener('close', onPageClosed);
    page.removeListener('crash', onPageCrashed);
    page.removeListener('response', onResponse);
    page.removeListener('response', onScriptResponse);
    page.removeListener('requestfailed', onRequestFailed);
    if (routeInstalled) {
      await context
        .unroute(CHALLENGE_ROUTE, routeHandler)
        .catch(() => undefined);
    }
    if (tagsRouteInstalled) {
      await context.unroute(DD_TAGS_ROUTE, blockDdTags).catch(() => undefined);
    }
    closeIdentityBridge?.();
    if (pageSession) await pageSession.detach().catch(() => undefined);
    if (browserSession) await browserSession.detach().catch(() => undefined);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * A captcha document with no slider in it is the block page. DataDome serves
 * the same `t: "c"` shell either way, so the object says "captcha" while the
 * page offers nothing to solve — asking the solver for sensors there produces
 * a payload for a puzzle that does not exist. The slider is the difference,
 * so the slider is what this waits for. It is the only unsolvable outcome
 * this bridge recognises; everything else is just another challenge.
 */
async function assertCaptchaSlider(
  frame: Frame,
  slot: ChallengeSlot,
  timeout: number
): Promise<void> {
  try {
    const handle = await frame.waitForFunction(
      (selector: string) => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box !== undefined && box.width > 0 && box.height > 0;
      },
      CAPTCHA_HANDLE_SELECTOR,
      { polling: 100, timeout: Math.min(timeout, CAPTCHA_LAYOUT_TIMEOUT_MS) }
    );
    await handle.dispose();
  } catch {
    // A frame the page replaced while we were looking is not a block page.
    if (slot.superseded.settled) return;
    throw new Error(
      'DataDome served a captcha with no slider: this is a block page, not a challenge'
    );
  }
}

async function assertInterstitialCarrier(
  request: Request,
  solved: InterstitialSolverResult
): Promise<void> {
  const headers = await request.allHeaders();
  const expectedBrands = PROFILE.brands
    .map(({ brand, version }) => `"${brand}";v="${version}"`)
    .join(', ');
  if (
    request.method() !== 'POST' ||
    request.resourceType() !== 'xhr' ||
    request.url() !== INTERSTITIAL_URL ||
    solved.url !== INTERSTITIAL_URL ||
    header(headers, 'origin') !== solved.origin ||
    header(headers, 'referer') !== solved.referer ||
    header(headers, 'content-type') !== FORM_CONTENT_TYPE ||
    header(headers, 'sec-ch-ua') !== expectedBrands ||
    header(headers, 'sec-ch-ua-mobile') !== '?0' ||
    header(headers, 'sec-ch-ua-platform') !== '"macOS"'
  ) {
    throw new Error('The native interstitial request identity did not match');
  }
}

function autoAttachParams() {
  return {
    autoAttach: true,
    filter: [{ type: 'iframe' }, { exclude: true }],
    flatten: false,
    waitForDebuggerOnStart: true,
  };
}

async function callSolver(
  solverBaseUrl: URL,
  challenge: ChallengeData,
  document: ChallengeDocumentData,
  proxy: string | undefined,
  timeout: number,
  solverApiKey: string | undefined,
  // eslint-disable-next-line no-unused-vars -- function-type parameter
  externalScriptBody: (url: string) => Promise<string>
): Promise<PreparedSubmission> {
  const connection = document.surfaces.connection;
  const captchaLayoutMeasurement =
    challenge.dd.rt === 'c'
      ? measureCaptchaLayout(
          document.frame,
          {
            height: document.surfaces.screen.innerHeight,
            width: document.surfaces.screen.innerWidth,
          },
          timeout
        )
      : Promise.resolve(undefined);

  const externalScripts: ExternalScript[] = await Promise.all(
    extractExternalScriptUrls(document.html, document.url).map(
      async (scriptUrl) => ({
        body: await externalScriptBody(scriptUrl),
        url: scriptUrl,
      })
    )
  );

  // The challenge document's stylesheets. Fetched from inside the challenge
  // frame itself — same origin, same cookies, same proxy as the document —
  // which is as close to what the browser actually loaded as this client can
  // get. Sent on both challenge types; a document that links nothing costs
  // nothing to ask about.
  const stylesheetAssets = await collectStylesheetAssets({
    documentHtml: document.html,
    documentUrl: document.url,
    fetchAsset: async (assetUrl) =>
      document.frame.evaluate(async (href: string) => {
        const response = await fetch(href);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      }, assetUrl),
  });
  const captchaLayout = await captchaLayoutMeasurement;

  const raw = await fetchJson(
    new URL('/dd/solve', solverBaseUrl),
    {
      body: JSON.stringify({
        dd: challenge.dd,
        ddCookie: solverCookieForChallengeDocument(
          challenge.dd.rt,
          document.url,
          challenge.cookie.value
        ),
        iframeData: {
          ...(captchaLayout ? { captchaLayout } : {}),
          finalNavigationResponseBodySizes:
            document.finalNavigationResponseBodySizes,
          ...(externalScripts.length ? { externalScripts } : {}),
          html: document.html,
          ...(stylesheetAssets.length ? { stylesheetAssets } : {}),
          url: document.url,
        },
        js_profile: {
          brands: PROFILE.brands,
          chromeFullVersion: PROFILE.chromeFullVersion,
          chromeVersion: PROFILE.chromeVersion,
          deviceMemory: PROFILE.deviceMemory,
          hardwareConcurrency: PROFILE.hardwareConcurrency,
          languages: document.surfaces.languages.join(',') || PROFILE.languages,
          ...(connection
            ? {
                networkDownlink: connection.downlink,
                networkEffectiveType: connection.effectiveType,
                networkRtt: connection.rtt,
                networkSaveData: connection.saveData,
              }
            : {}),
          os: PROFILE.os,
          perf: { nextHopProtocol: document.surfaces.nextHopProtocol },
          platformVersion: PROFILE.platformVersion,
          screen: document.surfaces.screen,
          timezone: PROFILE.timezone,
          timezoneOffsetMinutes: PROFILE.timezoneOffsetMinutes,
          vendor: PROFILE.vendor,
        },
        profile: {
          chromeFullVersion: PROFILE.chromeFullVersion,
          httpHeaderTemplates: { form: [], iframe: [], image: [], xhr: [] },
          id: PROFILE_ID,
          os: PROFILE.os,
          timezone: PROFILE.timezone,
          timezoneOffsetMinutes: PROFILE.timezoneOffsetMinutes,
          tlsClientHello: '',
          userAgent: PROFILE.userAgent,
        },
        ...(proxy ? { proxy: normalizeProxy(proxy) } : {}),
        timeout,
        url: challenge.pageUrl,
      }),
      headers: {
        'content-type': 'application/json',
        ...(solverApiKey ? { 'x-api-key': solverApiKey } : {}),
      },
      method: 'POST',
    },
    timeout
  );
  const result = validateSolverResult(raw, challenge.dd.rt);
  const referer = new URL(result.referer);
  const expectedPath = challenge.dd.rt === 'c' ? '/captcha/' : '/interstitial/';
  if (
    referer.protocol !== 'https:' ||
    referer.hostname !== GEO_HOST ||
    referer.pathname !== expectedPath
  ) {
    throw new Error('Solver returned an unexpected DataDome Referer');
  }
  return result;
}

function captureWindowGeometry(): WindowGeometry {
  const positionedScreen = screen as unknown as {
    availLeft: number;
    availTop: number;
  };
  return {
    availHeight: screen.availHeight,
    availLeft: positionedScreen.availLeft,
    availTop: positionedScreen.availTop,
    availWidth: screen.availWidth,
    colorDepth: screen.colorDepth,
    devicePixelRatio: window.devicePixelRatio,
    height: screen.height,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    outerHeight: window.outerHeight,
    outerWidth: window.outerWidth,
    pixelDepth: screen.pixelDepth,
    screenX: window.screenX,
    screenY: window.screenY,
    width: screen.width,
  };
}

function challengeDocumentType(
  request: Request
): DataDomeChallenge['rt'] | null {
  if (
    request.method() !== 'GET' ||
    request.resourceType() !== 'document' ||
    !request.isNavigationRequest()
  ) {
    return null;
  }
  const url = new URL(request.url());
  if (url.protocol !== 'https:' || url.hostname !== GEO_HOST) return null;
  if (url.pathname === '/interstitial/') return 'i';
  if (url.pathname === '/captcha/') return 'c';
  return null;
}

async function checkHealth(
  baseUrl: URL,
  timeout: number,
  solverApiKey: string | undefined
): Promise<void> {
  await fetchJson(
    new URL('/hc', baseUrl),
    solverApiKey ? { headers: { 'x-api-key': solverApiKey } } : undefined,
    timeout
  );
}

function cookieDomainMatches(domain: string, hostname: string): boolean {
  const normalized = domain.startsWith('.') ? domain.slice(1) : domain;
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

function cookiePathMatches(path: string, pathname: string): boolean {
  if (path === '/') return true;
  if (!pathname.startsWith(path)) return false;
  return (
    path.endsWith('/') ||
    pathname.length === path.length ||
    pathname[path.length] === '/'
  );
}

function deferred<T>(): Deferred<T> {
  let settled = false;
  let rejectPromise = (error: Error): void => {
    void error;
  };
  let resolvePromise = (value: T): void => {
    void value;
  };
  const promise = new Promise<T>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  return {
    promise,
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    get settled() {
      return settled;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(
  url: URL,
  init: RequestInit | undefined,
  timeout: number
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeout),
  });
  checkRateLimit(response.status, response.headers);
  const text = await response.text();
  if (!response.ok) {
    const detail = solverResponseErrorDetail(text);
    throw new Error(
      `${url.pathname} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${url.pathname} returned invalid JSON`);
  }
}

function header(
  headers: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  const expected = name.toLowerCase();
  return Object.entries(headers).find(
    ([key]) => key.toLowerCase() === expected
  )?.[1];
}

function httpUrl(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ${label} URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} URL must use HTTP or HTTPS`);
  }
  return url;
}

async function installIdentityBridge(
  session: CDPSession,
  browserContextId: string,
  // eslint-disable-next-line no-unused-vars -- function-type parameter
  fail: (error: unknown) => void
): Promise<() => void> {
  const root: RawChannel = { id: 'page' };
  const channels = new Map<string, RawChannel>([[root.id, root]]);
  const pending = new Map<
    string,
    // eslint-disable-next-line no-unused-vars -- function-type parameters
    { reject(error: Error): void; resolve(value: unknown): void }
  >();
  let commandId = 0;
  const rootSend = session.send.bind(session) as unknown as (
    // eslint-disable-next-line no-unused-vars -- function-type parameter
    method: string,
    // eslint-disable-next-line no-unused-vars -- function-type parameter
    params?: Record<string, unknown>
  ) => Promise<unknown>;
  const send = async (
    channel: RawChannel,
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> => {
    if (!channel.parent || !channel.sessionId) return rootSend(method, params);
    const id = ++commandId;
    const key = `${channel.id}:${id}`;
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(key, { reject, resolve });
    });
    void result.catch(() => undefined);
    await send(channel.parent, 'Target.sendMessageToTarget', {
      message: JSON.stringify({ id, method, params }),
      sessionId: channel.sessionId,
    });
    return result;
  };
  const attach = (
    parent: RawChannel,
    event: {
      sessionId: string;
      targetInfo: { browserContextId?: string; type: string };
    }
  ): void => {
    if (
      event.targetInfo.type !== 'iframe' ||
      event.targetInfo.browserContextId !== browserContextId
    ) {
      fail(new Error('Chrome attached an unexpected target'));
      return;
    }
    const channel: RawChannel = {
      id: `${parent.id}/${event.sessionId}`,
      parent,
      sessionId: event.sessionId,
    };
    channels.set(channel.id, channel);
    void (async () => {
      await send(channel, 'Emulation.setUserAgentOverride', UA_OVERRIDE);
      await send(channel, 'Target.setAutoAttach', autoAttachParams());
      await send(channel, 'Runtime.runIfWaitingForDebugger');
    })().catch(fail);
  };
  const rawMessage = (channel: RawChannel, raw: string): void => {
    const message = JSON.parse(raw) as RawMessage;
    if (message.id !== undefined) {
      const command = pending.get(`${channel.id}:${message.id}`);
      if (!command) return;
      pending.delete(`${channel.id}:${message.id}`);
      if (message.error) {
        command.reject(
          new Error(message.error.message ?? 'CDP command failed')
        );
      } else command.resolve(message.result);
      return;
    }
    if (message.method === 'Target.attachedToTarget') {
      attach(channel, message.params as Parameters<typeof attach>[1]);
    } else if (message.method === 'Target.receivedMessageFromTarget') {
      const received = message.params as {
        message: string;
        sessionId: string;
      };
      const child = channels.get(`${channel.id}/${received.sessionId}`);
      if (child) rawMessage(child, received.message);
      else fail(new Error('Received an unknown CDP target message'));
    }
  };
  session.on('Target.attachedToTarget', (event) => attach(root, event));
  session.on('Target.receivedMessageFromTarget', (event) => {
    const child = channels.get(`${root.id}/${event.sessionId}`);
    if (child) rawMessage(child, event.message);
    else fail(new Error('Received an unknown CDP target message'));
  });
  await session.send('Target.setAutoAttach', autoAttachParams());
  return () => {
    for (const command of pending.values()) {
      command.reject(new Error('CDP bridge closed'));
    }
    pending.clear();
  };
}

function isCaptchaCheck(method: string, value: string): boolean {
  if (method !== 'GET') return false;
  const url = new URL(value);
  return url.origin === GEO_ORIGIN && url.pathname === '/captcha/check';
}

function isInterstitialPost(method: string, value: string): boolean {
  return method === 'POST' && value === INTERSTITIAL_URL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function measureCaptchaLayout(
  frame: Frame,
  viewport: { height: number; width: number },
  timeout: number
): Promise<CaptchaLayout | undefined> {
  try {
    const ready = await frame.waitForFunction(
      (selector: string) => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box !== undefined && box.width > 0 && box.height > 0;
      },
      CAPTCHA_HANDLE_SELECTOR,
      { polling: 100, timeout: Math.min(timeout, CAPTCHA_LAYOUT_TIMEOUT_MS) }
    );
    await ready.dispose();
    const measurement = await frame.evaluate(
      async ({ selector, settleMs }) => {
        const readHandle = () => {
          const box = document.querySelector(selector)?.getBoundingClientRect();
          return box
            ? {
                bottom: box.bottom,
                left: box.left,
                right: box.right,
                top: box.top,
              }
            : undefined;
        };
        const handle = readHandle();
        await new Promise((resolve) => setTimeout(resolve, settleMs));
        const settledHandle = readHandle();
        return handle && settledHandle
          ? {
              handle,
              scroll: { x: window.scrollX, y: window.scrollY },
              settledHandle,
              viewport: {
                height: window.innerHeight,
                width: window.innerWidth,
              },
            }
          : undefined;
      },
      { selector: CAPTCHA_HANDLE_SELECTOR, settleMs: CAPTCHA_LAYOUT_SETTLE_MS }
    );
    return measurement ? buildCaptchaLayout(measurement, viewport) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeProxy(raw: string): string {
  return httpUrl(
    /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`,
    'proxy'
  ).href;
}

async function raceFatal<T>(
  promise: Promise<T>,
  fatal: Promise<never>
): Promise<T> {
  return Promise.race([promise, fatal]);
}

function requiredBrowser(page: Page): Browser {
  const browser = page.context().browser();
  if (!browser) throw new Error('DataDome requires a browser-backed page');
  return browser;
}

async function sampleChallengeFrame(
  parentFrame: Frame,
  frame: Frame
): Promise<FrameSurfaces> {
  const [parentScreen, frameScreen, sampled] = await Promise.all([
    parentFrame.evaluate(captureWindowGeometry),
    frame.evaluate(captureWindowGeometry),
    frame.evaluate(async () => {
      const browserNavigator = navigator; // eslint-disable-line n/no-unsupported-features/node-builtins
      const userAgentData = (
        browserNavigator as unknown as {
          userAgentData?: {
            brands: Array<{ brand: string; version: string }>;
            // eslint-disable-next-line no-unused-vars -- function-type parameter
            getHighEntropyValues(hints: string[]): Promise<{
              fullVersionList?: Array<{ brand: string; version: string }>;
            }>;
            platform: string;
          };
        }
      ).userAgentData;
      const fullVersionList = userAgentData
        ? ((await userAgentData.getHighEntropyValues(['fullVersionList']))
            .fullVersionList ?? [])
        : [];
      const connection = (
        browserNavigator as unknown as {
          connection?: {
            downlink: number;
            effectiveType: string;
            rtt: number;
            saveData: boolean;
          };
        }
      ).connection;
      const navigation = performance.getEntriesByType('navigation')[0] as
        PerformanceNavigationTiming | undefined;
      return {
        ...(connection
          ? {
              connection: {
                downlink: connection.downlink,
                effectiveType: connection.effectiveType,
                rtt: connection.rtt,
                saveData: connection.saveData,
              },
            }
          : {}),
        identity: {
          brands: userAgentData?.brands ?? [],
          fullVersionList,
          platform: userAgentData?.platform ?? '',
          userAgent: browserNavigator.userAgent,
          webdriver: browserNavigator.webdriver,
        },
        languages: [...browserNavigator.languages],
        nextHopProtocol: navigation?.nextHopProtocol ?? '',
      };
    }),
  ]);
  const expectedIdentity = {
    brands: PROFILE.brands,
    fullVersionList: UA_OVERRIDE.userAgentMetadata.fullVersionList,
    platform: 'macOS',
    userAgent: PROFILE.userAgent,
    webdriver: false,
  };
  if (JSON.stringify(sampled.identity) !== JSON.stringify(expectedIdentity)) {
    throw new Error('The challenge frame did not inherit the Chrome profile');
  }
  return {
    ...(sampled.connection ? { connection: sampled.connection } : {}),
    languages: sampled.languages,
    nextHopProtocol: sampled.nextHopProtocol,
    screen: {
      ...parentScreen,
      innerHeight: frameScreen.innerHeight,
      innerWidth: frameScreen.innerWidth,
    },
  };
}

function selectTargetCookie(
  cookies: ReadonlyArray<Cookie>,
  target: URL,
  expectedValue?: string
): Cookie | undefined {
  return cookies
    .filter(
      (cookie) =>
        cookie.name === 'datadome' &&
        cookieDomainMatches(cookie.domain, target.hostname) &&
        cookiePathMatches(cookie.path, target.pathname) &&
        (!cookie.secure || target.protocol === 'https:') &&
        (expectedValue === undefined || cookie.value === expectedValue)
    )
    .sort((left, right) => right.path.length - left.path.length)[0];
}

async function setWindowGeometry(
  browserSession: CDPSession,
  pageSession: CDPSession,
  targetId: string
): Promise<void> {
  const { windowId } = await browserSession.send('Browser.getWindowForTarget', {
    targetId,
  });
  await browserSession.send('Browser.setWindowBounds', {
    bounds: {
      height: PROFILE.screen.outerHeight,
      left: PROFILE.screen.screenX,
      top: PROFILE.screen.screenY,
      width: PROFILE.screen.outerWidth,
    },
    windowId,
  });
  await pageSession.send('Emulation.setVisibleSize', {
    height: PROFILE.screen.innerHeight,
    width: PROFILE.screen.innerWidth,
  });
}

function solverResponseErrorDetail(text: string): string {
  const fallback = text.trim();
  if (!fallback) return '';

  let detail = fallback;
  try {
    const parsed = JSON.parse(fallback) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed['error'] === 'string' &&
      parsed['error'].trim()
    ) {
      detail = parsed['error'].trim();
    }
  } catch {
    // The response body itself is the fallback diagnostic.
  }
  return detail.slice(0, MAX_SOLVER_ERROR_DETAIL_LENGTH);
}

async function triggerPassiveCaptchaCarrier(
  frame: Frame,
  nativeSubmitStarted: Deferred<undefined>,
  timeout: number,
  fatal: Promise<never>
): Promise<void> {
  await waitFor(
    frame
      .waitForFunction(
        () =>
          typeof (window as { captchaCallback?: unknown } & typeof window)
            .captchaCallback === 'function',
        undefined,
        { timeout }
      )
      .then((handle) => handle.dispose()),
    'captcha callback readiness',
    timeout,
    fatal
  );
  if (!nativeSubmitStarted.settled) {
    await waitFor(
      frame.evaluate(() => {
        const state = window as {
          captchaCallback?: unknown;
        } & typeof window;
        const callback = state.captchaCallback;
        if (typeof callback !== 'function') {
          throw new Error('The captcha callback is not ready');
        }
        callback.call(state);
      }),
      'captcha callback',
      timeout,
      fatal
    );
  }
  await waitFor(
    nativeSubmitStarted.promise,
    'native captcha callback request',
    timeout,
    fatal
  );
}

async function waitFor<T>(
  promise: Promise<T>,
  label: string,
  timeout: number,
  fatal: Promise<never>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      fatal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          timeout
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForCookieRotation(
  context: BrowserContext,
  challenge: ChallengeData,
  timeout: number,
  fatal: Promise<never>
): Promise<Cookie> {
  const deadline = Date.now() + timeout;
  const target = new URL(challenge.pageUrl);
  while (Date.now() < deadline) {
    const cookies = await raceFatal(context.cookies(challenge.pageUrl), fatal);
    const sameSlot = cookies.find(
      (cookie) =>
        cookie.name === challenge.cookie.name &&
        cookie.domain === challenge.cookie.domain &&
        cookie.path === challenge.cookie.path &&
        cookie.value !== challenge.cookie.value
    );
    if (sameSlot) return sameSlot;
    const rotated = cookies.find(
      (cookie) =>
        cookie.name === 'datadome' &&
        cookieDomainMatches(cookie.domain, target.hostname) &&
        cookiePathMatches(cookie.path, target.pathname) &&
        cookie.value !== challenge.cookie.value
    );
    if (rotated) return rotated;
    await raceFatal(delay(50), fatal);
  }
  throw new Error('The target datadome cookie did not rotate');
}
