/**
 * DataDome interstitial solver bridge.
 *
 * Chrome creates the native interstitial XHR. The bridge pauses that request,
 * replaces only `payload` and `plv3`, then lets Chrome send it unchanged.
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

type Challenge = {
  b?: number;
  cid: string;
  e?: string;
  hsh: string;
  ir?: number;
  rt: 'c' | 'i';
  s: number;
  t?: string;
};

type ChallengeData = {
  cookie: Cookie;
  dd: Challenge;
  pageUrl: string;
};

type FrameSurfaces = {
  connection?: {
    downlink: number;
    effectiveType: string;
    rtt: number;
    saveData: boolean;
  };
  nextHopProtocol: string;
  screen: Record<string, number>;
};

type InterstitialData = {
  html: string;
  surfaces: FrameSurfaces;
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

type SolverResult = {
  body: string;
  origin: string;
  referer: string;
  url: string;
};

const GEO_HOST = 'geo.captcha-delivery.com';
const GEO_ORIGIN = `https://${GEO_HOST}`;
const INTERSTITIAL_URL = `${GEO_ORIGIN}/interstitial/`;
const PROFILE_ID = 'chrome-149-macos';
const TIMEOUT = 120000;
const QUIET_WINDOW_MS = 5000;
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
  languages: 'en-US',
  os: 'macos',
  platformVersion: '26.5.2',
  timezone: 'America/New_York',
  timezoneOffsetMinutes: 240,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  vendor: 'Google Inc.',
} as const;
const UA_OVERRIDE = {
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

const log = (msg: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${msg}`, ...extra);

/** Solve one DataDome interstitial in an existing Playwright page. */
export async function solveDataDome(
  page: Page,
  opts: SolveDataDomeOptions
): Promise<SolveDataDomeResult> {
  const { proxy, solverUrl, timeout = TIMEOUT, url } = opts;
  const targetUrl = httpUrl(url, 'target');
  const solverBaseUrl = httpUrl(solverUrl, 'solver');
  const browser = requiredBrowser(page);
  const context = page.context();
  if (browser.version() !== PROFILE.chromeFullVersion) {
    throw new Error(
      `Chrome ${browser.version()} does not match ${PROFILE_ID} (${PROFILE.chromeFullVersion})`
    );
  }
  await checkHealth(solverBaseUrl, timeout);

  const challenge = deferred<ChallengeData>();
  const interstitial = deferred<InterstitialData>();
  const submit = deferred<number>();
  const fatal = deferred<never>();
  void fatal.promise.catch(() => undefined);
  let failed = false;
  let challengeSeen = false;
  let interstitialSeen = false;
  let relayStarted = false;
  let solved: Promise<SolverResult> | undefined;
  const fail = (error: unknown): void => {
    if (failed) return;
    failed = true;
    fatal.reject(asError(error));
  };
  const getSolved = (): Promise<SolverResult> => {
    solved ??= Promise.all([challenge.promise, interstitial.promise]).then(
      ([challengeData, iframeData]) =>
        callSolver(solverBaseUrl, challengeData, iframeData, proxy, timeout)
    );
    return solved;
  };

  const onResponse = (response: Response): void => {
    void (async () => {
      const request = response.request();
      const requestUrl = new URL(request.url());
      if (
        request.resourceType() === 'document' &&
        requestUrl.hostname === GEO_HOST &&
        requestUrl.pathname.startsWith('/captcha/')
      ) {
        throw new Error('DataDome requested a captcha document');
      }
      if (isInterstitialPost(request.method(), request.url())) {
        if (!relayStarted) {
          throw new Error('DataDome POST escaped the request bridge');
        }
        if (!response.ok()) {
          throw new Error(
            `DataDome rejected the POST with HTTP ${response.status()}`
          );
        }
        log(`DataDome POST returned HTTP ${response.status()}`);
        submit.resolve(response.status());
        return;
      }
      if (isInterstitialDocument(request)) {
        if (interstitialSeen) {
          throw new Error('DataDome interstitial document recurred');
        }
        interstitialSeen = true;
        const frame = response.frame();
        if (frame.parentFrame() !== page.mainFrame() || !response.ok()) {
          throw new Error('Unexpected DataDome interstitial document');
        }
        const html = await response.text();
        const surfaces = await sampleFrame(frame);
        interstitial.resolve({ html, surfaces, url: request.url() });
        void getSolved().catch(fail);
        return;
      }
      if (
        response.status() !== 403 ||
        request.frame() !== page.mainFrame() ||
        !request.isNavigationRequest() ||
        requestUrl.hostname !== targetUrl.hostname
      ) {
        return;
      }
      if (challengeSeen) throw new Error('DataDome challenge recurred');
      const html = await response.text();
      const dd = parseChallenge(html);
      if (!dd) throw new Error('Target 403 was not a DataDome challenge');
      if (dd.rt !== 'i') throw new Error('DataDome requested a captcha');
      const cookie = (await context.cookies(response.url()))
        .filter(({ name }) => name === 'datadome')
        .sort((left, right) => right.path.length - left.path.length)[0];
      if (!cookie) throw new Error('DataDome challenge cookie was not set');
      challengeSeen = true;
      log('DataDome interstitial detected');
      challenge.resolve({ cookie, dd, pageUrl: response.url() });
      void getSolved().catch(fail);
    })().catch(fail);
  };
  const onRequestFailed = (request: Request): void => {
    if (!isInterstitialPost(request.method(), request.url())) return;
    fail(
      new Error(
        `DataDome POST failed: ${request.failure()?.errorText ?? 'unknown network error'}`
      )
    );
  };
  const routeHandler = async (
    route: Route,
    request: Request
  ): Promise<void> => {
    try {
      if (!isInterstitialPost(request.method(), request.url())) {
        await route.continue();
        return;
      }
      if (relayStarted) {
        throw new Error('Browser created more than one DataDome POST');
      }
      relayStarted = true;
      const nativeBody = request.postData();
      if (request.resourceType() !== 'xhr' || !nativeBody) {
        throw new Error('Unexpected native DataDome submission');
      }
      const result = await waitFor(
        getSolved(),
        'sandbox payload',
        timeout,
        fatal.promise
      );
      await assertNativeRequest(request, result);
      const relayBody = buildRelayBody(nativeBody, result.body);
      log(`Relaying sandbox payload in Chrome (${relayBody.length} bytes)`);
      await route.continue({ postData: relayBody });
    } catch (error) {
      fail(error);
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  };
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  let browserSession: CDPSession | undefined;
  let pageSession: CDPSession | undefined;
  let closeBridge: (() => void) | undefined;
  let routeInstalled = false;
  try {
    await context.route(`${INTERSTITIAL_URL}*`, routeHandler);
    routeInstalled = true;
    browserSession = await browser.newBrowserCDPSession();
    pageSession = await context.newCDPSession(page);
    await pageSession.send('Emulation.setUserAgentOverride', UA_OVERRIDE);
    const { targetInfo } = await pageSession.send('Target.getTargetInfo');
    if (!targetInfo.browserContextId) {
      throw new Error('Could not identify the Chrome browser context');
    }
    await setWindowGeometry(browserSession, pageSession, targetInfo.targetId);
    closeBridge = await installIdentityBridge(
      pageSession,
      targetInfo.browserContextId,
      fail
    );

    log(`Chrome ${browser.version()} started for ${targetUrl.hostname}`);
    const initialNavigation = page
      .goto(targetUrl.href, { timeout, waitUntil: 'domcontentloaded' })
      .catch((error: unknown) => {
        if (!challengeSeen) fail(error);
        return null;
      });
    const initialChallenge = await waitFor(
      challenge.promise,
      'initial DataDome challenge',
      timeout,
      fatal.promise
    );
    await waitFor(
      interstitial.promise,
      'interstitial document',
      timeout,
      fatal.promise
    );
    const submitStatus = await waitFor(
      submit.promise,
      'DataDome POST response',
      timeout,
      fatal.promise
    );
    log(`Sandbox submission accepted with HTTP ${submitStatus}`);
    await raceFatal(initialNavigation, fatal.promise);
    const solvedCookie = await waitForCookieRotation(
      context,
      initialChallenge,
      timeout,
      fatal.promise
    );
    log('DataDome cookie rotated');

    const retry = await waitFor(
      page.goto(targetUrl.href, { timeout, waitUntil: 'domcontentloaded' }),
      'target retry',
      timeout,
      fatal.promise
    );
    if (
      !retry ||
      retry.status() >= 400 ||
      new URL(retry.url()).hostname !== targetUrl.hostname
    ) {
      throw new Error('Target retry was not accepted');
    }
    await waitFor(
      delay(QUIET_WINDOW_MS),
      'acceptance window',
      QUIET_WINDOW_MS + 1000,
      fatal.promise
    );
    if (new URL(page.url()).hostname !== targetUrl.hostname) {
      throw new Error('Page left the target after acceptance');
    }
    log(`DataDome acceptance proven with HTTP ${retry.status()}`);
    return {
      cookie: solvedCookie.value,
      responseStatus: retry.status(),
      url: page.url(),
    };
  } finally {
    page.removeListener('response', onResponse);
    page.removeListener('requestfailed', onRequestFailed);
    if (routeInstalled) {
      await context.unroute(`${INTERSTITIAL_URL}*`, routeHandler);
    }
    closeBridge?.();
    if (pageSession) {
      await pageSession.detach().catch(() => undefined);
    }
    if (browserSession) await browserSession.detach().catch(() => undefined);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function assertNativeRequest(
  request: Request,
  solved: SolverResult
): Promise<void> {
  const headers = await request.allHeaders();
  const expectedBrands = PROFILE.brands
    .map(({ brand, version }) => `"${brand}";v="${version}"`)
    .join(', ');
  if (
    request.url() !== INTERSTITIAL_URL ||
    new URL(solved.url, solved.origin).href !== INTERSTITIAL_URL ||
    header(headers, 'origin') !== solved.origin ||
    header(headers, 'referer') !== solved.referer ||
    header(headers, 'content-type') !==
      'application/x-www-form-urlencoded; charset=UTF-8' ||
    header(headers, 'sec-ch-ua') !== expectedBrands ||
    header(headers, 'sec-ch-ua-mobile') !== '?0' ||
    header(headers, 'sec-ch-ua-platform') !== '"macOS"'
  ) {
    throw new Error('Native DataDome request identity did not match');
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

function buildRelayBody(nativeBody: string, solvedBody: string): string {
  const nativeFields = rawForm(nativeBody);
  const solvedFields = rawForm(solvedBody);
  if (
    nativeFields.length !== solvedFields.length ||
    nativeFields.some(({ name }, index) => name !== solvedFields[index]?.name)
  ) {
    throw new Error('Native and sandbox form field order differed');
  }
  return nativeFields
    .map((field, index) => {
      const solved = solvedFields[index];
      if (!solved) throw new Error('Sandbox form field was missing');
      if (field.name === 'payload' || field.name === 'plv3') {
        return solved.segment;
      }
      if (field.segment !== solved.segment) {
        throw new Error(`DataDome invariant field ${field.name} differed`);
      }
      return field.segment;
    })
    .join('&');
}

async function callSolver(
  solverBaseUrl: URL,
  challenge: ChallengeData,
  interstitial: InterstitialData,
  proxy: string | undefined,
  timeout: number
): Promise<SolverResult> {
  const connection = interstitial.surfaces.connection;
  const raw = await fetchJson(
    new URL('/dd/solve?submit=false', solverBaseUrl),
    {
      body: JSON.stringify({
        dd: challenge.dd,
        ddCookie: challenge.cookie.value,
        iframeData: {
          html: interstitial.html,
          url: interstitial.url,
        },
        js_profile: {
          brands: PROFILE.brands,
          chromeFullVersion: PROFILE.chromeFullVersion,
          chromeVersion: PROFILE.chromeVersion,
          deviceMemory: PROFILE.deviceMemory,
          hardwareConcurrency: PROFILE.hardwareConcurrency,
          languages: PROFILE.languages,
          ...(connection
            ? {
                networkDownlink: connection.downlink,
                networkEffectiveType: connection.effectiveType,
                networkRtt: connection.rtt,
                networkSaveData: connection.saveData,
              }
            : {}),
          os: PROFILE.os,
          perf: {
            nextHopProtocol: interstitial.surfaces.nextHopProtocol,
          },
          platformVersion: PROFILE.platformVersion,
          screen: interstitial.surfaces.screen,
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
  if (!isRecord(raw)) throw new Error('Solver returned an invalid response');
  const result = raw as Partial<SolverResult>;
  if (
    typeof result.body !== 'string' ||
    typeof result.origin !== 'string' ||
    typeof result.referer !== 'string' ||
    typeof result.url !== 'string' ||
    result.origin !== GEO_ORIGIN
  ) {
    throw new Error('Solver response was incomplete');
  }
  const fields = new URLSearchParams(result.body);
  if (
    !fields.get('payload') ||
    !fields.get('plv3') ||
    fields.get('hash') !== challenge.dd.hsh
  ) {
    throw new Error('Solver result did not match the active challenge');
  }
  log(`Sandbox payload ready (${result.body.length} bytes)`);
  return result as SolverResult;
}

async function checkHealth(baseUrl: URL, timeout: number): Promise<void> {
  await fetchJson(new URL('/hc', baseUrl), undefined, timeout);
}

function deferred<T>() {
  let resolvePromise = (value: PromiseLike<T> | T): void => {
    void value;
  };
  let rejectPromise = (reason?: unknown): void => {
    void reason;
  };
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
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
  if (!response.ok)
    throw new Error(`${url.pathname} returned HTTP ${response.status}`);
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
  const url = new URL(raw);
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

function isInterstitialDocument(request: Request): boolean {
  if (request.method() !== 'GET' || request.resourceType() !== 'document') {
    return false;
  }
  const url = new URL(request.url());
  return url.hostname === GEO_HOST && url.pathname === '/interstitial/';
}

function isInterstitialPost(method: string, url: string): boolean {
  return method === 'POST' && url === INTERSTITIAL_URL;
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

function parseChallenge(html: string): Challenge | null {
  const string = (pattern: RegExp): string | undefined =>
    pattern.exec(html)?.[1];
  const number = (pattern: RegExp): number | undefined => {
    const value = string(pattern);
    return value === undefined ? undefined : Number.parseInt(value, 10);
  };
  const cid = string(
    /(?:^|[,{]\s*)["']?(?:cid|initialCid)["']?\s*:\s*["']([^"']+)["']/
  );
  const hsh = string(
    /(?:^|[,{]\s*)["']?(?:hsh|hash)["']?\s*:\s*["']([^"']+)["']/
  );
  const rt = string(/(?:^|[,{]\s*)["']?rt["']?\s*:\s*["']([^"']+)["']/);
  if (!cid || !hsh || (rt !== 'c' && rt !== 'i')) return null;
  const b = number(/(?:^|[,{]\s*)["']?b["']?\s*:\s*["']?(\d+)/);
  const e = string(/(?:^|[,{]\s*)["']?e["']?\s*:\s*["']([^"']+)["']/);
  const ir = number(/(?:^|[,{]\s*)["']?ir["']?\s*:\s*["']?(\d+)/);
  const t = string(/(?:^|[,{]\s*)["']?t["']?\s*:\s*["']([^"']+)["']/);
  return {
    cid,
    hsh,
    rt,
    s: number(/(?:^|[,{]\s*)["']?s["']?\s*:\s*["']?(\d+)/) ?? 0,
    ...(b === undefined ? {} : { b }),
    ...(e === undefined ? {} : { e }),
    ...(ir === undefined ? {} : { ir }),
    ...(t === undefined ? {} : { t }),
  };
}

async function raceFatal<T>(
  promise: Promise<T>,
  fatal: Promise<never>
): Promise<T> {
  return Promise.race([promise, fatal]);
}

function rawForm(body: string): Array<{ name: string; segment: string }> {
  const names = new Set<string>();
  const fields = body.split('&').map((segment) => {
    const separator = segment.indexOf('=');
    if (separator <= 0) throw new Error('Malformed DataDome form');
    const rawName = segment.slice(0, separator);
    const name = decodeURIComponent(rawName.split('+').join(' '));
    if (names.has(name)) throw new Error(`Duplicate DataDome field ${name}`);
    if ((name === 'payload' || name === 'plv3') && rawName !== name) {
      throw new Error(`Encoded DataDome sensor field ${name}`);
    }
    names.add(name);
    return { name, segment };
  });
  if (!names.has('payload') || !names.has('plv3')) {
    throw new Error('DataDome form omitted payload or plv3');
  }
  return fields;
}

function requiredBrowser(page: Page): Browser {
  const browser = page.context().browser();
  if (!browser) throw new Error('DataDome requires a browser-backed page');
  return browser;
}

async function sampleFrame(frame: Frame): Promise<FrameSurfaces> {
  const sampled = await frame.evaluate(async () => {
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
    const positionedScreen = screen as unknown as {
      availLeft: number;
      availTop: number;
    };
    const navigation = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    return {
      ...(connection ? { connection: { ...connection } } : {}),
      identity: {
        brands: userAgentData?.brands ?? [],
        fullVersionList,
        platform: userAgentData?.platform ?? '',
        userAgent: browserNavigator.userAgent,
        webdriver: browserNavigator.webdriver,
      },
      nextHopProtocol: navigation?.nextHopProtocol ?? '',
      screen: {
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
      },
    };
  });
  const expectedIdentity = {
    brands: PROFILE.brands,
    fullVersionList: UA_OVERRIDE.userAgentMetadata.fullVersionList,
    platform: 'macOS',
    userAgent: PROFILE.userAgent,
    webdriver: false,
  };
  if (JSON.stringify(sampled.identity) !== JSON.stringify(expectedIdentity)) {
    throw new Error(
      'Interstitial frame did not inherit the Chrome 149 identity'
    );
  }
  return sampled;
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
    bounds: { height: 904, left: 0, top: 143, width: 1200 },
    windowId,
  });
  await pageSession.send('Emulation.setVisibleSize', {
    height: 761,
    width: 1200,
  });
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
      new Promise<never>((_, reject) => {
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
  while (Date.now() < deadline) {
    const current = (
      await raceFatal(context.cookies(challenge.pageUrl), fatal)
    ).find(
      (cookie) =>
        cookie.name === challenge.cookie.name &&
        cookie.domain === challenge.cookie.domain &&
        cookie.path === challenge.cookie.path
    );
    if (current && current.value !== challenge.cookie.value) return current;
    await raceFatal(delay(50), fatal);
  }
  throw new Error('DataDome cookie did not rotate');
}
