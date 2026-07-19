/**
 * DataDome browser bridge.
 *
 * The remote solver generates sensor values. Chrome keeps ownership of the
 * native interstitial POST or captcha callback GET, receives DataDome's
 * response, applies the cookie, and performs the organic target navigation.
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

export type CaptchaSolverResult = {
  origin: string;
  referer: string;
  type: 'captcha';
  url: string;
};

export type ChallengeIr = number | string;

export type ChallengeSequence = ReadonlyArray<DataDomeChallenge['rt']>;

export type DataDomeChallenge = {
  b?: number;
  cid: string;
  e?: string;
  hsh: string;
  ir?: ChallengeIr;
  rt: 'c' | 'i';
  s: number;
  t?: string;
};

export type InterstitialSolverResult = {
  body: string;
  origin: string;
  referer: string;
  type: 'interstitial';
  url: string;
};

export type SolverResult = CaptchaSolverResult | InterstitialSolverResult;

type CaptchaRelayContext = {
  headers: Readonly<Record<string, string | undefined>>;
  solved: CaptchaSolverResult;
  url: string;
};

type RawField = {
  decodedName: string;
  decodedValue: string;
  rawName: string;
  rawSegment: string;
  rawValue: string;
};

const CAPTCHA_SENSOR_FIELDS = new Set(['ddCaptchaEncodedPayload', 'plv3']);
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=UTF-8';
const GEO_HOST = 'geo.captcha-delivery.com';
const GEO_ORIGIN = `https://${GEO_HOST}`;
const CAPTCHA_CHECK_URL = `${GEO_ORIGIN}/captcha/check`;
const INTERSTITIAL_URL = `${GEO_ORIGIN}/interstitial/`;
const MAX_SOLVER_ERROR_DETAIL_LENGTH = 1000;

export type SolveDataDomeOptions = {
  proxy?: string;
  solverUrl: string;
  timeout?: number;
  url: string;
};

export type SolveDataDomeResult = {
  cookie: string;
  responseStatus: number;
  url: string;
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

type Round = {
  challenge: Deferred<ChallengeData>;
  challengeData?: ChallengeData;
  completion: Deferred<RoundCompletion>;
  document: Deferred<ChallengeDocumentData>;
  index: number;
  nativeSubmitStarted: Deferred<undefined>;
  next?: Round;
  relayStarted: boolean;
  solver?: Promise<SolverResult>;
  submit: Deferred<SubmitResult>;
};

type RoundCompletion =
  | { kind: 'escalated'; round: Round }
  | { kind: 'navigation'; navigation: NavigationResult };

type SubmitResult = {
  expectedNavigationUrl?: string;
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
export function buildCaptchaRelayUrl(context: CaptchaRelayContext): string {
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
export function buildInterstitialRelayBody(
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

/** Parse the structured challenge required by `/dd/solve` from its document URL. */
export function parseChallenge(input: string): DataDomeChallenge | null {
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

/** Select the cookie identity appropriate to the live challenge document. */
export function solverCookieForChallengeDocument(
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

/** Validate and narrow the raw `/dd/solve?submit=false` response. */
export function validateSolverResult(
  raw: unknown,
  type: DataDomeChallenge['rt']
): SolverResult {
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

function appendChallengeType(
  sequence: ChallengeSequence,
  next: DataDomeChallenge['rt']
): ChallengeSequence {
  if (sequence.length === 0) return [next];
  if (sequence.length === 1 && sequence[0] === 'i' && next === 'c') {
    return [...sequence, next];
  }
  throw new Error(
    'Only interstitial, captcha, and interstitial-to-captcha sequences are supported'
  );
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

const CHALLENGE_ROUTE = 'https://geo.captcha-delivery.com/**';
const PROFILE_ID = 'chrome-149-macos';
const QUIET_WINDOW_MS = 5000;
const TIMEOUT = 120000;

const PROFILE = {
  brands: [
    { brand: 'Google Chrome', version: '149' },
    { brand: 'Chromium', version: '149' },
    { brand: 'Not)A;Brand', version: '24' },
  ],
  chromeFullVersion: '149.0.7827.201',
  chromeVersion: '149',
  deviceMemory: 32,
  hardwareConcurrency: 10,
  languages: 'en-US,en',
  os: 'macos',
  platformVersion: '26.5.2',
  screen: {
    availHeight: 948,
    availLeft: 0,
    availTop: 0,
    availWidth: 1512,
    colorDepth: 30,
    devicePixelRatio: 2,
    height: 982,
    innerHeight: 761,
    innerWidth: 1200,
    outerHeight: 904,
    outerWidth: 1200,
    pixelDepth: 30,
    screenX: 0,
    screenY: 143,
    width: 1512,
  },
  timezone: 'America/New_York',
  timezoneOffsetMinutes: 240,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  vendor: 'Google Inc.',
} as const;

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

/** Solve a DataDome interstitial, captcha, or interstitial-to-captcha flow. */
export async function solveDataDome(
  page: Page,
  options: SolveDataDomeOptions
): Promise<SolveDataDomeResult> {
  const { proxy, solverUrl, timeout = TIMEOUT, url } = options;
  const targetUrl = httpUrl(url, 'target');
  const solverBaseUrl = httpUrl(solverUrl, 'solver');
  const browser = requiredBrowser(page);
  const context = page.context();
  await checkHealth(solverBaseUrl, timeout);

  const fatal = deferred<never>();
  void fatal.promise.catch(() => undefined);
  const carrierRounds = new Map<Request, Round>();
  let sequence: ChallengeSequence = [];
  let activeRound: Round | undefined;
  let failed = false;
  let responseQueue = Promise.resolve();

  const fail = (error: unknown): void => {
    if (failed) return;
    failed = true;
    fatal.reject(asError(error));
  };

  const createRound = (): Round => {
    const round: Round = {
      challenge: deferred<ChallengeData>(),
      completion: deferred<RoundCompletion>(),
      document: deferred<ChallengeDocumentData>(),
      index: 0,
      nativeSubmitStarted: deferred<undefined>(),
      relayStarted: false,
      submit: deferred<SubmitResult>(),
    };
    activeRound = round;
    return round;
  };

  const createNextRound = (previous: Round): Round => {
    if (previous.next) return previous.next;
    if (previous.challengeData?.dd.rt !== 'i') {
      throw new Error('Only an interstitial may escalate to a captcha');
    }
    const next = createRound();
    previous.next = next;
    previous.completion.resolve({ kind: 'escalated', round: next });
    return next;
  };

  const registerChallenge = (
    round: Round,
    challengeData: ChallengeData
  ): void => {
    if (round.challenge.settled) {
      throw new Error('A challenge round attempted to replace its identity');
    }
    sequence = appendChallengeType(sequence, challengeData.dd.rt);
    round.challengeData = challengeData;
    round.index = sequence.length;
    round.challenge.resolve(challengeData);
    log(
      `DataDome ${challengeData.dd.rt === 'c' ? 'captcha' : 'interstitial'} detected (round ${round.index}, ${sequence.join(' -> ')})`
    );
  };

  const getSolverResult = (
    round: Round,
    challengeData: ChallengeData,
    documentData: ChallengeDocumentData
  ): Promise<SolverResult> => {
    round.solver ??= callSolver(
      solverBaseUrl,
      challengeData,
      documentData,
      proxy,
      timeout
    ).catch((error: unknown) => {
      fail(error);
      throw error;
    });
    return round.solver;
  };

  const processChallengeDocument = async (
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

    let round = activeRound;
    if (!round) {
      throw new Error('A challenge document appeared without an active round');
    }
    if (round.challengeData && round.challengeData.dd.rt !== type) {
      if (type !== 'c' || !round.relayStarted) {
        throw new Error('The challenge document type changed unexpectedly');
      }
      round = createNextRound(round);
    }
    if (round.document.settled) {
      throw new Error('The challenge document recurred in the same round');
    }

    if (!round.challenge.settled) {
      const dd = parseChallenge(request.url());
      if (!dd || dd.rt !== type) {
        throw new Error('The challenge document identity could not be parsed');
      }
      const cookie = selectTargetCookie(
        await context.cookies(targetUrl.href),
        targetUrl
      );
      if (!cookie) {
        throw new Error('The escalated challenge lost its target cookie');
      }
      registerChallenge(round, { cookie, dd, pageUrl: targetUrl.href });
    }

    const challengeData = await waitFor(
      round.challenge.promise,
      `challenge ${round.index} metadata`,
      timeout,
      fatal.promise
    );
    if (challengeData.dd.rt !== type) {
      throw new Error('The challenge metadata and document type differed');
    }

    const [body, sizes] = await Promise.all([response.body(), request.sizes()]);
    const surfaces = await sampleChallengeFrame(page.mainFrame(), frame);
    const html = body.toString('utf8');
    if (!html.includes('<script')) {
      throw new Error('The challenge document did not contain a script');
    }
    const documentData: ChallengeDocumentData = {
      finalNavigationResponseBodySizes: {
        decodedBodySize: body.byteLength,
        encodedBodySize: Math.max(0, Math.round(sizes.responseBodySize)),
      },
      frame,
      html,
      surfaces,
      url: request.url(),
    };
    round.document.resolve(documentData);
    log(`DataDome ${type === 'c' ? 'captcha' : 'interstitial'} document ready`);
    void getSolverResult(round, challengeData, documentData).catch(
      () => undefined
    );
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
      if (
        response.status() >= 200 &&
        response.status() < 300 &&
        activeRound?.relayStarted
      ) {
        activeRound.completion.resolve({
          kind: 'navigation',
          navigation: { status: response.status(), url: response.url() },
        });
      }
      return;
    }

    const compactHtml = (await response.text()).replace(/\s/g, '');
    if (
      ["t:'bv'", 't:"bv"', "'t':'bv'", '"t":"bv"'].some((token) =>
        compactHtml.includes(token)
      )
    ) {
      throw new Error('DataDome reports this IP is banned');
    }

    const round = activeRound;
    if (!round) {
      throw new Error('The target challenge appeared without an active round');
    }
    if (round.challenge.settled) {
      if (!round.relayStarted || round.challengeData?.dd.rt !== 'i') {
        throw new Error('The target returned a recurrent challenge');
      }
      createNextRound(round);
    }
  };

  const processCarrierResponse = async (response: Response): Promise<void> => {
    const request = response.request();
    const round = carrierRounds.get(request);
    if (!round) return;
    carrierRounds.delete(request);

    const captcha = round.challengeData?.dd.rt === 'c';
    const accepted = captcha
      ? response.status() >= 200 && response.status() < 300
      : response.status() >= 200 && response.status() < 400;
    if (!accepted) {
      throw new Error(
        `DataDome ${captcha ? 'captcha GET' : 'interstitial POST'} returned HTTP ${response.status()}`
      );
    }
    const expectedNavigationUrl = captcha
      ? captchaReloadUrl(request.url())
      : undefined;
    round.submit.resolve({
      ...(expectedNavigationUrl ? { expectedNavigationUrl } : {}),
    });
    log(
      `DataDome ${captcha ? 'captcha GET' : 'interstitial POST'} returned HTTP ${response.status()}`
    );
  };

  const processResponse = async (response: Response): Promise<void> => {
    const request = response.request();
    if (carrierRounds.has(request)) {
      await processCarrierResponse(response);
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
      await processChallengeDocument(response, type);
      return;
    }
    await processTargetDocument(response);
  };

  const onResponse = (response: Response): void => {
    responseQueue = responseQueue
      .then(() => processResponse(response))
      .catch((error: unknown) => fail(error));
  };

  const onRequestFailed = (request: Request): void => {
    const round = carrierRounds.get(request);
    if (!round) return;
    carrierRounds.delete(request);
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

    try {
      const round = activeRound;
      if (!round) {
        throw new Error('A DataDome submission appeared without a round');
      }
      if (round.relayStarted) {
        throw new Error('The browser created more than one round submission');
      }
      round.relayStarted = true;

      const challengeData = await waitFor(
        round.challenge.promise,
        'challenge metadata',
        timeout,
        fatal.promise
      );
      const documentData = await waitFor(
        round.document.promise,
        'challenge document',
        timeout,
        fatal.promise
      );
      if (
        (challengeData.dd.rt === 'i' && !interstitial) ||
        (challengeData.dd.rt === 'c' && !captcha)
      ) {
        throw new Error('The native carrier did not match the challenge type');
      }
      if (request.resourceType() !== 'xhr') {
        throw new Error('The native DataDome carrier was not an XHR');
      }
      if (request.frame() !== documentData.frame) {
        throw new Error('The native carrier came from another frame');
      }
      round.nativeSubmitStarted.resolve(undefined);

      const solved = await getSolverResult(round, challengeData, documentData);
      carrierRounds.set(request, round);
      if (solved.type === 'captcha') {
        const relayUrl = buildCaptchaRelayUrl({
          headers: await request.allHeaders(),
          solved,
          url: request.url(),
        });
        log(`Relaying sandbox sensors in Chrome captcha GET`);
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
      await route.continue({ postData: relayBody });
    } catch (error) {
      fail(error);
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  };
  browser.on('disconnected', onBrowserDisconnected);
  page.on('close', onPageClosed);
  page.on('crash', onPageCrashed);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  let browserSession: CDPSession | undefined;
  let closeIdentityBridge: (() => void) | undefined;
  let pageSession: CDPSession | undefined;
  let routeInstalled = false;
  try {
    await context.route(CHALLENGE_ROUTE, routeHandler);
    routeInstalled = true;
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

    const solveRound = async (
      round: Round
    ): Promise<
      | { cookie: Cookie; kind: 'accepted'; navigation: NavigationResult }
      | { kind: 'escalated'; round: Round }
    > => {
      const challengeData = await waitFor(
        round.challenge.promise,
        'DataDome challenge',
        timeout,
        fatal.promise
      );
      const documentData = await waitFor(
        round.document.promise,
        `challenge ${round.index} document`,
        timeout,
        fatal.promise
      );
      await getSolverResult(round, challengeData, documentData);
      if (challengeData.dd.rt === 'c') {
        await triggerPassiveCaptchaCarrier(
          documentData.frame,
          round.nativeSubmitStarted,
          timeout,
          fatal.promise
        );
      }
      const submitted = await waitFor(
        round.submit.promise,
        `challenge ${round.index} browser response`,
        timeout,
        fatal.promise
      );

      const completion = await waitFor(
        round.completion.promise,
        `challenge ${round.index} completion`,
        timeout,
        fatal.promise
      );
      if (completion.kind === 'escalated') return completion;
      if (
        submitted.expectedNavigationUrl &&
        new URL(completion.navigation.url).href !==
          new URL(submitted.expectedNavigationUrl).href
      ) {
        throw new Error(
          'The organic post-captcha navigation used an unexpected URL'
        );
      }

      const cookie = await waitForCookieRotation(
        context,
        challengeData,
        timeout,
        fatal.promise
      );
      return {
        cookie,
        kind: 'accepted',
        navigation: completion.navigation,
      };
    };

    const firstRound = createRound();
    log(
      `Chrome ${browser.version()} started for ${targetUrl.hostname}; presenting ${PROFILE_ID} (${PROFILE.chromeFullVersion})`
    );
    const initialNavigation = page
      .goto(targetUrl.href, { timeout, waitUntil: 'domcontentloaded' })
      .catch((error: unknown) => {
        if (!firstRound.challenge.settled) fail(error);
        return null;
      });

    let round = firstRound;
    let accepted: { cookie: Cookie; navigation: NavigationResult } | undefined;
    while (!accepted) {
      const result = await solveRound(round);
      if (result.kind === 'escalated') {
        round = result.round;
      } else {
        accepted = result;
      }
    }

    await raceFatal(initialNavigation, fatal.promise);
    const roundsBeforeQuietWindow = sequence.length;
    await waitFor(
      delay(QUIET_WINDOW_MS),
      'acceptance window',
      QUIET_WINDOW_MS + 1000,
      fatal.promise
    );
    await responseQueue;
    if (
      sequence.length !== roundsBeforeQuietWindow ||
      new URL(page.url()).hostname !== targetUrl.hostname ||
      accepted.navigation.status >= 400
    ) {
      throw new Error('DataDome acceptance could not be proven');
    }

    log(
      `DataDome acceptance proven after ${sequence.join(' -> ')} with HTTP ${accepted.navigation.status}`
    );
    return {
      cookie: accepted.cookie.value,
      responseStatus: accepted.navigation.status,
      url: page.url(),
    };
  } finally {
    browser.removeListener('disconnected', onBrowserDisconnected);
    page.removeListener('close', onPageClosed);
    page.removeListener('crash', onPageCrashed);
    page.removeListener('response', onResponse);
    page.removeListener('requestfailed', onRequestFailed);
    if (routeInstalled) {
      await context
        .unroute(CHALLENGE_ROUTE, routeHandler)
        .catch(() => undefined);
    }
    closeIdentityBridge?.();
    if (pageSession) await pageSession.detach().catch(() => undefined);
    if (browserSession) await browserSession.detach().catch(() => undefined);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
  timeout: number
): Promise<SolverResult> {
  const connection = document.surfaces.connection;
  const raw = await fetchJson(
    new URL('/dd/solve?submit=false', solverBaseUrl),
    {
      body: JSON.stringify({
        dd: challenge.dd,
        ddCookie: solverCookieForChallengeDocument(
          challenge.dd.rt,
          document.url,
          challenge.cookie.value
        ),
        iframeData: {
          finalNavigationResponseBodySizes:
            document.finalNavigationResponseBodySizes,
          html: document.html,
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
      headers: { 'content-type': 'application/json' },
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
  log(`Sandbox ${result.type} sensors ready (round ${challenge.dd.rt})`);
  return result;
}

function captchaReloadUrl(carrierUrl: string): string {
  const values = new URL(carrierUrl).searchParams.getAll('referer');
  if (values.length !== 1 || !values[0]) {
    throw new Error('The native captcha carrier omitted its reload URL');
  }
  return httpUrl(values[0], 'captcha reload').href;
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

async function checkHealth(baseUrl: URL, timeout: number): Promise<void> {
  await fetchJson(new URL('/hc', baseUrl), undefined, timeout);
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
        | PerformanceNavigationTiming
        | undefined;
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
  } catch {}
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
