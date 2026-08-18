/**
 * An MCP server that puts the solver in front of an LLM agent.
 *
 * Run with:
 *
 *   npm run mcp
 *
 * Every other script in this repo is written the other way round: a human
 * picks a target, and the challenge handling is written out ahead of time for
 * that one site. That is the right shape for an example and the wrong shape
 * for an agent, which does not know which page will block it until the 403
 * comes back. These tools exist so an agent that has just been blocked can
 * solve the challenge inside its own loop and retry, rather than needing the
 * site anticipated in code someone wrote earlier.
 *
 * The transport is stdio, so STDOUT CARRIES THE PROTOCOL. Anything written
 * there that is not a JSON-RPC frame corrupts the stream and the client drops
 * the connection with a parse error that names none of this. Every diagnostic
 * below goes to stderr for that reason.
 */
import { existsSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Browser } from 'playwright-core';
import { chromium } from 'playwright-core';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';

import { applyIdentity, USER_AGENT, VIEWPORT } from '#src/akamai/identity.js';
import { solve } from '#src/akamai/solver.js';
import { toLaunchProxy } from '#src/proxy.js';
import { RateLimitError } from '#src/rate-limit.js';

import {
  challengeDocumentUrl,
  documentHeaders,
  parseBlockPage,
} from '#src/datadome/http-utils.js';
import { PROFILE, PROFILE_ID } from '#src/datadome/profile.js';
import { solverBaseUrl, solverWsUrl } from '#src/solver-url.js';

const solverHost = process.env['host'];
const apiKey = process.env['api_key'];
/**
 * The default exit IP for tools that do not name one.
 *
 * Optional on purpose. A self-hosted container solving from its own address is
 * a legitimate deployment, so an unset `proxy=` is not an error here — but a
 * DataDome clearance cookie is bound to whichever IP submitted it, so an agent
 * that solves through one address and browses from another gets a fresh 403
 * that looks exactly like a failed solve. See `datadome_solve` below.
 */
const defaultProxy = process.env['proxy'];

if (!solverHost) throw new Error('set host= in .env');

const baseUrl = solverBaseUrl(solverHost);

const log = (msg: string, ...extra: unknown[]): void =>
  console.error(`[${new Date().toISOString()}] ${msg}`, ...extra);

/** `x-api-key` is only read by the reverse proxy in front of a hosted box. */
const headers = (): Record<string, string> => ({
  'content-type': 'application/json',
  ...(apiKey ? { 'x-api-key': apiKey } : {}),
});

/**
 * The browser identity every tool declares, derived from the one the rest of
 * the repo uses so there is a single answer to "which Chrome are we claiming".
 *
 * This is the whole reason an agent can call `akamai_solve` with nothing but a
 * URL. The API requires a full `profile` and `js_profile` on every solve, and
 * an agent has no way to invent a coherent one — the fields are cross-checked
 * against each other and against the headers actually sent, so a plausible
 * guess fails as a solve that is merely never accepted.
 */
const jsProfile = {
  brands: PROFILE.brands,
  chromeFullVersion: PROFILE.chromeFullVersion,
  chromeVersion: PROFILE.chromeVersion,
  deviceMemory: PROFILE.deviceMemory,
  hardwareConcurrency: PROFILE.hardwareConcurrency,
  languages: PROFILE.languages,
  os: PROFILE.os,
  platformVersion: PROFILE.platformVersion,
  screen: PROFILE.screen,
  timezone: PROFILE.timezone,
  timezoneOffsetMinutes: PROFILE.timezoneOffsetMinutes,
  vendor: PROFILE.vendor,
};

const profileSnapshot = {
  chromeFullVersion: PROFILE.chromeFullVersion,
  httpHeaderTemplates: { form: [], iframe: [], image: [], xhr: [] },
  id: PROFILE_ID,
  os: PROFILE.os,
  timezone: PROFILE.timezone,
  timezoneOffsetMinutes: PROFILE.timezoneOffsetMinutes,
  tlsClientHello: '',
  userAgent: PROFILE.userAgent,
};

type ToolResult = {
  content: { text: string; type: 'text' }[];
  isError?: boolean;
};

const asText = (value: unknown, isError = false): ToolResult => ({
  content: [{ text: JSON.stringify(value, null, 2), type: 'text' }],
  ...(isError ? { isError: true } : {}),
});

/**
 * One request to the solver, with the failure modes reported rather than
 * thrown.
 *
 * An MCP tool that throws surfaces to the model as a transport-level failure,
 * which reads as "the tool is broken" and tends to end the attempt. A `4xx`
 * from the solver is not that: it is a result the agent can act on — rotate
 * the exit IP on a ban, fix an argument on a validation error — so the body
 * comes back as tool content with `isError` set instead.
 */
const call = async (
  path: string,
  init?: { body?: unknown; method?: string }
): Promise<ToolResult> => {
  const url = new URL(path, `${baseUrl}/`).toString();
  try {
    const response = await fetch(url, {
      headers: headers(),
      method: init?.method ?? 'GET',
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A non-JSON body is nearly always the reverse proxy rather than the
      // container — an HTML 401 page when `api_key=` is missing or wrong.
      return asText(
        { body: text.slice(0, 500), status: response.status },
        true
      );
    }
    return asText(parsed, !response.ok);
  } catch (error) {
    return asText({ error: (error as Error).message, url }, true);
  }
};

const server = new McpServer({ name: 'xhrdev', version: '1.0.0' });

server.registerTool(
  'health_check',
  {
    description:
      'Check that the xhr.dev solver is reachable and healthy. Returns {"status":"ok"}. This endpoint needs no API key, so a healthy response here alongside a 401 from any other tool means the key is missing or wrong rather than the solver being down.',
    inputSchema: {},
    title: 'Solver health check',
  },
  async () => call('hc')
);

server.registerTool(
  'solver_stats',
  {
    description:
      "Report this deployment's own solve rate — how many challenges it has attempted and how many were accepted.",
    inputSchema: {},
    title: 'Solve-rate stats',
  },
  async () =>
    call(`stats${apiKey ? `?api_key=${encodeURIComponent(apiKey)}` : ''}`)
);

server.registerTool(
  'akamai_queue_metrics',
  {
    description:
      'Inspect the Akamai solve queue (active, queued, admitted, completed, rejected, timed out). Worth checking when akamai_solve returns queue_full or queue_wait_timeout, which mean the container is saturated rather than that the solve itself failed.',
    inputSchema: {},
    title: 'Akamai queue metrics',
  },
  async () => call('akamai/queue-metrics')
);

server.registerTool(
  'akamai_solve',
  {
    description:
      'Solve an Akamai Bot Manager challenge (_abck sensor) for a URL and return clearance cookies. Call this when a request returns 403 or an Akamai "Access Denied" page, then retry your request with the cookie_header this returns, from the same proxy. Launches a real Chrome internally and relays each sensor request through it, so the cookies are bound to a genuine TLS fingerprint. Takes roughly 20-60s and the browser profile is supplied automatically, so a URL is all you need. Your MCP client may need its request timeout raised above the default 60s.',
    inputSchema: {
      headed: z
        .boolean()
        .optional()
        .describe(
          'Run the browser headed rather than headless. Debugging only.'
        ),
      proxy: z
        .string()
        .optional()
        .describe(
          'Outbound proxy URL for this solve. Defaults to proxy= from the environment. Retry your request through the same proxy — the cookies are bound to this exit IP.'
        ),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Overall deadline in milliseconds. Defaults to 120000.'),
      url: z.url().describe('The URL that is being challenged.'),
    },
    title: 'Solve an Akamai challenge',
  },
  async ({ headed, proxy, timeout, url }) => {
    const resolvedProxy = proxy ?? defaultProxy;
    log(`akamai_solve ${url}`);

    /**
     * A real browser, rather than `POST /akamai/solve`.
     *
     * The HTTP endpoint is the obvious thing to call here and does not work
     * for the targets that matter. It solves server-side, so the sensor
     * requests carry the container's TLS fingerprint and cookie jar rather
     * than a browser's; against a target that checks the submitting client
     * the payload is built correctly and then simply never accepted, and the
     * solve ends `timeout`/`deadline_exceeded` with nothing naming the cause.
     *
     * So this drives the same browser bridge `src/akamai/comcast.ts` does:
     * Chrome relays each sensor request over the session socket, and `_abck`
     * reaches `~0~`. The cost is a browser per call and tens of seconds.
     */
    let browser: Browser | undefined;
    try {
      const launchOpts: Parameters<typeof chromium.launch>[0] = {
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
          '--no-default-browser-check',
        ],
        headless: !headed,
        ...(resolvedProxy ? { proxy: toLaunchProxy(resolvedProxy) } : {}),
      };
      const chromePath = process.env['CHROME_PATH'] ?? '';
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      if (chromePath && existsSync(chromePath))
        launchOpts.executablePath = chromePath;
      else launchOpts.channel = 'chrome';

      browser = await chromium.launch(launchOpts);
      const context = await browser.newContext({
        deviceScaleFactor: 2,
        ignoreHTTPSErrors: true,
        locale: 'en-US',
        timezoneId: PROFILE.timezone,
        userAgent: USER_AGENT,
        viewport: VIEWPORT,
      });
      const page = await context.newPage();
      await applyIdentity(await context.newCDPSession(page));

      await solve(page, {
        ...(resolvedProxy ? { proxy: resolvedProxy } : {}),
        ...(apiKey ? { solverApiKey: apiKey } : {}),
        solverUrl: solverWsUrl(solverHost, '/akamai/session'),
        timeout: timeout ?? 120_000,
        url,
      });

      const cookies = await context.cookies();
      const jar: Record<string, string> = {};
      for (const { name, value } of cookies) jar[name] = value;

      // `~0~` in the second field is Akamai's own "this cookie is good".
      // Anything else — `~-1~` especially — means the rounds ran and never
      // landed, which is a failure however clean the transcript looked.
      const abck = jar['_abck'];
      const accepted = abck?.split('~')[1] === '0';

      return asText(
        {
          accepted,
          cookie_header: Object.entries(jar)
            .map(([name, value]) => `${name}=${value}`)
            .join('; '),
          cookies: jar,
          final_url: page.url(),
          ...(accepted
            ? {}
            : {
                note: '_abck did not reach ~0~. The solve ran but was not accepted — usually the exit IP rather than the payload. Rotate the proxy and retry.',
              }),
          proxy: resolvedProxy ?? null,
        },
        !accepted
      );
    } catch (error) {
      if (error instanceof RateLimitError)
        return asText(
          {
            error: `solver rate limit: ${error.message}`,
            retryable: false,
          },
          true
        );
      return asText({ error: (error as Error).message }, true);
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }
);

server.registerTool(
  'datadome_solve',
  {
    description:
      'Solve a DataDome captcha or interstitial challenge. Pass the HTML body of the 403 you just received and this parses the challenge out of it, fetches the challenge document, and solves. Unlike akamai_solve it does NOT return a clearance cookie — it returns a prepared submission ({url, body?, origin, referer}) that YOU must send yourself, from the same IP and proxy session you intend to browse from, because DataDome binds the resulting cookie to whichever address submitted it. Send GET when body is absent (captcha) and POST when it is present (interstitial); DataDome answers with the clearance cookie, which you then send as the datadome= cookie on the retried request.',
    inputSchema: {
      blockedHtml: z
        .string()
        .describe(
          'The full HTML body of the 403 response from the target, carrying the inline `var dd = {...}` block.'
        ),
      proxy: z
        .string()
        .optional()
        .describe(
          'Outbound proxy URL. Defaults to proxy= from the environment. Must be the same exit IP you will submit and browse from.'
        ),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Deadline in milliseconds, 1-120000.'),
      url: z.url().describe('The URL that is being challenged.'),
    },
    title: 'Solve a DataDome challenge',
  },
  async ({ blockedHtml, proxy, timeout, url }) => {
    const dd = parseBlockPage(blockedHtml);
    if (!dd)
      return asText(
        {
          error:
            'No DataDome challenge found in that HTML. A 403 without an inline `var dd = {...}` is not a DataDome block — check that this is the body of the blocked response.',
        },
        true
      );
    if (dd.t === 'bv')
      return asText(
        {
          error:
            'IP is banned (t: "bv"). There is nothing to solve — rotate to a different exit IP and retry the original request.',
        },
        true
      );

    const resolvedProxy = proxy ?? defaultProxy;
    log(`datadome_solve ${url} rt=${dd.rt}`);

    /**
     * Fetch the challenge document and hand it over as `iframeData`.
     *
     * Letting the solver fetch it live instead looks equivalent and is not:
     * the document is tied to this cid/hash/session, so a second fetch gets a
     * different one and the solve aborts partway through with a complaint
     * about a missing element in the captcha DOM.
     */
    const documentUrl = challengeDocumentUrl(dd, url);
    let documentHtml: string;
    try {
      const dispatcher = resolvedProxy
        ? new ProxyAgent(resolvedProxy)
        : undefined;
      const response = await undiciFetch(documentUrl, {
        headers: documentHeaders(url),
        ...(dispatcher ? { dispatcher } : {}),
      });
      documentHtml = await response.text();
    } catch (error) {
      return asText(
        {
          error: `challenge document fetch failed: ${(error as Error).message}`,
        },
        true
      );
    }

    return call('dd/solve', {
      body: {
        dd: {
          ...(dd.b === undefined ? {} : { b: dd.b }),
          cid: dd.cid,
          ...(dd.e === undefined ? {} : { e: dd.e }),
          hsh: dd.hsh,
          rt: dd.rt,
          s: dd.s ?? 0,
          ...(dd.t === undefined ? {} : { t: dd.t }),
        },
        ddCookie: dd.cookie,
        iframeData: { html: documentHtml, url: documentUrl },
        js_profile: jsProfile,
        profile: profileSnapshot,
        url,
        ...(resolvedProxy ? { proxy: resolvedProxy } : {}),
        ...(timeout === undefined ? {} : { timeout }),
      },
      method: 'POST',
    });
  }
);

log(`xhr.dev MCP server -> ${baseUrl}`);
log(`profile ${PROFILE_ID}${apiKey ? ' (sending x-api-key)' : ''}`);

await server.connect(new StdioServerTransport());
