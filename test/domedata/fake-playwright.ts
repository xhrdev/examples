import { EventEmitter } from 'node:events';

import type { CDPSession, Frame, Page, Request, Route } from 'playwright-core';

import {
  type DataDomeChallenge,
  solveDataDome,
  type SolveDataDomeResult,
} from '#src/domedata/solver.js';

export type FakeDataDomeFlow = 'c' | 'i-c' | 'i';

export type FakeDataDomeFlowResult = {
  bodyReads: { captcha: number; interstitial: number };
  cleanedUp: boolean;
  relayKinds: Array<'c' | 'i'>;
  relayValues: string[];
  result: SolveDataDomeResult;
  solverIr: Array<number | string>;
  solverTypes: Array<'c' | 'i'>;
};

type Challenge = Required<
  Pick<DataDomeChallenge, 'cid' | 'hsh' | 'ir' | 'rt' | 's'>
>;

type MutableRequest = {
  // eslint-disable-next-line no-unused-vars -- function-type parameter
  update(options: RequestUpdate): void;
} & Request;

type RequestOptions = {
  body?: string;
  frame: Frame;
  headers?: Record<string, string>;
  method?: string;
  navigation?: boolean;
  resourceType?: string;
  url: string;
};

type RequestUpdate = { postData?: string; url?: string };

type ResponseRole = 'c' | 'i' | 'other';

type RouteHandler = (
  // eslint-disable-next-line no-unused-vars -- function-type parameters
  route: Route,
  // eslint-disable-next-line no-unused-vars -- function-type parameters
  request: Request
) => Promise<void>;

type SessionDouble = {
  detached: boolean;
} & CDPSession;

const CAPTCHA_CHECK_URL = 'https://geo.captcha-delivery.com/captcha/check';
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=UTF-8';
const GEO_ORIGIN = 'https://geo.captcha-delivery.com';
const INTERSTITIAL_URL = `${GEO_ORIGIN}/interstitial/`;
const TARGET_URL = 'https://shop.example.test/product/one';
const GEOMETRY = { innerHeight: 761, innerWidth: 1200 };
const FRAME_SAMPLE = {
  identity: {
    brands: [
      { brand: 'Google Chrome', version: '149' },
      { brand: 'Chromium', version: '149' },
      { brand: 'Not)A;Brand', version: '24' },
    ],
    fullVersionList: [
      { brand: 'Google Chrome', version: '149.0.7827.201' },
      { brand: 'Chromium', version: '149.0.7827.201' },
      { brand: 'Not)A;Brand', version: '24.0.0.0' },
    ],
    platform: 'macOS',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    webdriver: false,
  },
  languages: ['en-US', 'en'],
  nextHopProtocol: 'h2',
};
const INTERSTITIAL_HEADERS = {
  'content-type': FORM_CONTENT_TYPE,
  origin: GEO_ORIGIN,
  'sec-ch-ua':
    '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};

class FlowHarness {
  readonly page: Page;
  private readonly bodyReads = { captcha: 0, interstitial: 0 };
  private readonly browserSession = makeSession('browser');
  private captchaFrame: Frame | undefined;
  private captchaSubmitStarted = false;
  private cookieValue = 'initial-cookie';
  private currentUrl = 'about:blank';
  private readonly flow: FakeDataDomeFlow;
  private readonly mainFrame: Frame;
  private readonly pageEvents = new EventEmitter();
  private readonly pageSession = makeSession('page');
  private readonly relays: Array<{ kind: 'c' | 'i'; value: string }> = [];
  private routeHandler: RouteHandler | undefined;
  private readonly solverIr: Array<number | string> = [];
  private readonly solverTypes: Array<'c' | 'i'> = [];
  private unrouted = false;

  constructor(flow: FakeDataDomeFlow) {
    this.flow = flow;
    this.mainFrame = this.makeFrame('main');
    const browser = Object.assign(new EventEmitter(), {
      newBrowserCDPSession: async () => this.browserSession,
      version: () => '149.0.7827.201',
    });
    const context = {
      browser: () => browser,
      cookies: async () => [
        {
          domain: '.example.test',
          name: 'datadome',
          path: '/',
          secure: true,
          value: this.cookieValue,
        },
      ],
      newCDPSession: async () => this.pageSession,
      route: async (pattern: unknown, handler: unknown) => {
        void pattern;
        this.routeHandler = handler as RouteHandler;
      },
      unroute: async () => {
        this.unrouted = true;
        this.routeHandler = undefined;
      },
    };
    this.page = Object.assign(this.pageEvents, {
      context: () => context,
      goto: async (url: string) => {
        this.currentUrl = url;
        await this.start();
        return null;
      },
      mainFrame: () => this.mainFrame,
      url: () => this.currentUrl,
    }) as unknown as Page;
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url =
      input instanceof URL
        ? input
        : typeof input === 'string'
          ? new URL(input)
          : new URL(input.url);
    if (url.pathname === '/hc') return new Response('{}');
    if (url.pathname !== '/dd/solve' || url.search !== '?submit=false') {
      throw new Error(`Unexpected mock fetch: ${url.href}`);
    }
    if (typeof init?.body !== 'string') {
      throw new Error('The solver request omitted its JSON body');
    }
    const request = JSON.parse(init.body) as {
      dd: Challenge;
      iframeData: { url: string };
    };
    const { dd } = request;
    this.solverIr.push(dd.ir);
    this.solverTypes.push(dd.rt);
    const result =
      dd.rt === 'i'
        ? {
            body: this.interstitialBody(dd, 'sandbox-payload', 'sandbox-wire'),
            origin: GEO_ORIGIN,
            referer: request.iframeData.url,
            url: INTERSTITIAL_URL,
          }
        : {
            origin: GEO_ORIGIN,
            referer: request.iframeData.url,
            url: this.captchaCarrierUrl(dd, 'sandbox-payload', 'sandbox-wire'),
          };
    return new Response(JSON.stringify(result));
  }

  result(result: SolveDataDomeResult): FakeDataDomeFlowResult {
    return {
      bodyReads: { ...this.bodyReads },
      cleanedUp:
        this.unrouted &&
        this.pageSession.detached &&
        this.browserSession.detached,
      relayKinds: this.relays.map(({ kind }) => kind),
      relayValues: this.relays.map(({ value }) => value),
      result,
      solverIr: [...this.solverIr],
      solverTypes: [...this.solverTypes],
    };
  }

  private accept(cookie: string): void {
    this.cookieValue = cookie;
    this.currentUrl = TARGET_URL;
    this.emitResponse(
      'other',
      200,
      makeRequest({ frame: this.mainFrame, url: TARGET_URL })
    );
  }

  private captchaCarrierUrl(
    challenge: Challenge,
    payload: string,
    plv3: string
  ): string {
    const target = encodeURIComponent(TARGET_URL);
    return (
      `${CAPTCHA_CHECK_URL}?cid=captcha-html-cid&icid=${challenge.cid}` +
      `&ccid=&userEnv=user-env&dm=cd&ddCaptchaChallenge=slider-challenge` +
      `&ddCaptchaEncodedPayload=${payload}&plv3=${plv3}` +
      `&ddCaptchaEnv=captcha-env&ddCaptchaAudioChallenge=audio-challenge` +
      `&hash=${challenge.hsh}&ua=Chrome%2F149.0.0.0` +
      `&referer=${target}&parent_url=${target}&x-forwarded-for=` +
      `&s=${challenge.s}&ir=${challenge.ir}`
    );
  }

  private carrierContinued(request: Request): void {
    if (request.method() === 'POST') {
      this.relays.push({ kind: 'i', value: request.postData() ?? '' });
      this.emitResponse('i', 302, request);
      if (this.flow === 'i-c') {
        this.emitChallengeDocument(this.challenge('c'));
      } else this.accept('accepted-interstitial-cookie');
      return;
    }

    this.relays.push({ kind: 'c', value: request.url() });
    const cookie = 'accepted-captcha-cookie';
    this.emitResponse('c', 200, request);
    this.accept(cookie);
  }

  private challenge(type: 'c' | 'i'): Challenge {
    return {
      cid: 'challenge-cid',
      hsh: 'CHALLENGEHASH',
      ir: type === 'c' && this.flow === 'i-c' ? '12,34,56,78,90' : 7,
      rt: type,
      s: 51825,
    };
  }

  private challengeDocumentUrl(challenge: Challenge): string {
    const path = challenge.rt === 'c' ? 'captcha' : 'interstitial';
    const cid = challenge.rt === 'c' ? '&cid=captcha-document-cookie' : '';
    return `${GEO_ORIGIN}/${path}/?initialCid=${challenge.cid}&hash=${challenge.hsh}&ir=${challenge.ir}&s=${challenge.s}${cid}`;
  }

  private challengeHtml(challenge: Challenge): string {
    return `<html><script>var dd=${JSON.stringify(challenge)};</script></html>`;
  }

  private emitChallengeDocument(challenge: Challenge): Frame {
    const frame = this.makeFrame(challenge.rt);
    if (challenge.rt === 'c') this.captchaFrame = frame;
    this.emitResponse(
      'other',
      200,
      makeRequest({ frame, url: this.challengeDocumentUrl(challenge) }),
      this.challengeHtml(challenge)
    );
    return frame;
  }

  private emitResponse(
    role: ResponseRole,
    status: number,
    request: Request,
    body = '',
    headers: Array<{ name: string; value: string }> = []
  ): void {
    this.pageEvents.emit('response', {
      body: async () => {
        if (role === 'c' || role === 'i') {
          this.bodyReads[role === 'c' ? 'captcha' : 'interstitial'] += 1;
          throw new Error('The carrier response body is unavailable');
        }
        return Buffer.from(body);
      },
      frame: () => request.frame(),
      headersArray: async () => headers,
      headerValue: async () => null,
      ok: () => status >= 200 && status < 300,
      request: () => request,
      status: () => status,
      text: async () => body,
      url: () => request.url(),
    });
  }

  private emitTargetChallenge(challenge: Challenge): void {
    this.cookieValue = 'initial-cookie';
    this.emitResponse(
      'other',
      403,
      makeRequest({ frame: this.mainFrame, url: TARGET_URL }),
      this.challengeHtml(challenge),
      [
        {
          name: 'set-cookie',
          value: 'datadome=initial-cookie; Path=/; Secure',
        },
      ]
    );
  }

  private interstitialBody(
    challenge: Challenge,
    payload: string,
    plv3: string
  ): string {
    return `cid=${challenge.cid}&hash=${challenge.hsh}&payload=${payload}&plv3=${plv3}&ps=9604`;
  }

  private makeFrame(type: 'c' | 'i' | 'main'): Frame {
    let evaluations = 0;
    const frame = {
      evaluate: async <Result>() => {
        if (type === 'main') return GEOMETRY as Result;
        evaluations += 1;
        if (evaluations === 1) return GEOMETRY as Result;
        if (evaluations === 2) return FRAME_SAMPLE as Result;
        if (type !== 'c' || evaluations !== 3) {
          throw new Error(
            'The mock challenge frame was evaluated unexpectedly'
          );
        }
        queueMicrotask(() => this.submitCaptcha());
        return undefined as Result;
      },
      locator: () => ({ waitFor: async () => undefined }),
      parentFrame: () => (type === 'main' ? null : this.mainFrame),
      waitForFunction: async () => ({ dispose: async () => undefined }),
    } as unknown as Frame;
    return frame;
  }

  private async route(request: MutableRequest): Promise<void> {
    if (!this.routeHandler) {
      throw new Error('The mock DataDome route was not installed');
    }
    const route = {
      abort: async () => undefined,
      continue: async (options: RequestUpdate = {}) => {
        request.update(options);
        this.carrierContinued(request);
      },
    } as unknown as Route;
    await this.routeHandler(route, request);
  }

  private async start(): Promise<void> {
    const first = this.challenge(this.flow === 'c' ? 'c' : 'i');
    this.emitTargetChallenge(first);
    const frame = this.emitChallengeDocument(first);
    if (first.rt === 'i') {
      await this.route(
        makeRequest({
          body: this.interstitialBody(first, 'browser-payload', 'browser-wire'),
          frame,
          headers: {
            ...INTERSTITIAL_HEADERS,
            referer: this.challengeDocumentUrl(first),
          },
          method: 'POST',
          resourceType: 'xhr',
          url: INTERSTITIAL_URL,
        })
      );
    }
  }

  private submitCaptcha(): void {
    const frame = this.captchaFrame;
    if (this.captchaSubmitStarted || !frame) return;
    this.captchaSubmitStarted = true;
    const challenge = this.challenge('c');
    void this.route(
      makeRequest({
        frame,
        headers: {
          'content-type': FORM_CONTENT_TYPE,
          referer: this.challengeDocumentUrl(challenge),
        },
        method: 'GET',
        resourceType: 'xhr',
        url: this.captchaCarrierUrl(
          challenge,
          'browser-payload',
          'browser-wire'
        ),
      })
    );
  }
}

export async function runFakeDataDomeFlow(
  flow: FakeDataDomeFlow
): Promise<FakeDataDomeFlowResult> {
  const harness = new FlowHarness(flow);
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.fetch = harness.fetch.bind(harness) as typeof fetch;
  globalThis.setTimeout = ((callback: () => void, delay?: number) =>
    originalSetTimeout(
      callback,
      delay === 5000 ? 0 : delay
    )) as typeof setTimeout;
  try {
    const result = await solveDataDome(harness.page, {
      solverUrl: 'http://solver.example.test:3000',
      timeout: 2000,
      url: TARGET_URL,
    });
    return harness.result(result);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
}

function makeRequest(options: RequestOptions): MutableRequest {
  let body = options.body ?? null;
  let url = options.url;
  return {
    async allHeaders() {
      return options.headers ?? {};
    },
    failure: () => null,
    frame: () => options.frame,
    isNavigationRequest: () =>
      options.navigation ?? options.resourceType === undefined,
    method: () => options.method ?? 'GET',
    postData: () => body,
    resourceType: () => options.resourceType ?? 'document',
    async sizes() {
      return { responseBodySize: 256 };
    },
    update(update: RequestUpdate) {
      if (update.postData !== undefined) body = update.postData;
      if (update.url !== undefined) url = update.url;
    },
    url: () => url,
  } as unknown as MutableRequest;
}

function makeSession(kind: 'browser' | 'page'): SessionDouble {
  return Object.assign(new EventEmitter(), {
    async detach() {
      this.detached = true;
    },
    detached: false,
    async send(method: string): Promise<Record<string, unknown>> {
      if (kind === 'page' && method === 'Target.getTargetInfo') {
        return {
          targetInfo: {
            browserContextId: 'mock-browser-context',
            targetId: 'mock-page',
          },
        };
      }
      return kind === 'browser' && method === 'Browser.getWindowForTarget'
        ? { windowId: 1 }
        : {};
    },
  }) as unknown as SessionDouble;
}
