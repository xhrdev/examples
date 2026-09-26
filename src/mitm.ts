/**
 * This is a helper library, not a script. It runs a local HTTPS proxy that
 * **re-originates** every request through Node, and it is what makes the
 * Lightpanda examples work at all.
 *
 * ## why
 *
 * DataDome hands Lightpanda a `t:"bv"` challenge — a banned visitor — before
 * it has run a line of JavaScript. It is not the user agent: undici sending
 * `User-Agent: Lightpanda/1.0` over the same proxy still gets a plain
 * `t:"fe"`. It is the connection itself — Lightpanda's TLS stack, not its
 * headers.
 *
 * You cannot dress that up from inside the browser. `--user-agent` rejects
 * any value containing "Mozilla", `Emulation.setUserAgentOverride` is ignored
 * on the wire, and nothing exposes the TLS layer. But every request already
 * goes through a proxy — so put one in the middle that terminates TLS and
 * makes the upstream request itself:
 *
 *   lightpanda --http-proxy http://127.0.0.1:port  ->  this  ->  your proxy
 *
 * Lightpanda keeps the DOM, the cookie jar and the JavaScript; it just stops
 * being the thing that opens the socket.
 *
 * ## what opens the socket instead
 *
 * By default, curl-impersonate, through the `src/impersonate.ts` sidecar:
 * a BoringSSL build that puts Chrome's exact ClientHello and Chrome's exact
 * HTTP/2 SETTINGS on the wire. `transport: 'undici'` keeps the previous
 * client, which is node's — see `CHROME_TLS` below for what that can and
 * cannot reach, and `src/impersonate.ts` for why it was not enough.
 *
 * What that is worth, measured with `src/fingerprint.ts` on 2026-09-25:
 *
 *   impersonate  ja4 t13d1516h2_8daaf6152771_806a8c22fdea
 *                h2  1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p
 *   undici       ja4 t13d1512h1_8daaf6152771_2c481c11c48b
 *                h2  2:0;4:262144|458753|0|a,m,p,s
 *
 * The middle hash agrees, because that is the cipher list and `CHROME_TLS`
 * sets it. The extension hash does not, and neither do the SETTINGS or the
 * pseudo-header order — `m,a,s,p` is Chrome's and `a,m,p,s` is alphabetical,
 * which is node sorting them and no browser at all.
 *
 * Against the examples, measured 2026-09-25, undici first:
 *
 *   hilton     OperationTimedout, 5s in,   serves the page; the SBSD lane
 *              on the first navigation     runs to a carrier answered
 *   aircanada  TimeoutError                SBSD solved end to end
 *   grainger   —                           SUCCESS, first attempt
 *   comcast    SUCCESS                     SUCCESS
 *   ca-edd     _abck at ~-1~               _abck at ~-1~
 *
 * hilton is the one this file can take credit for on its own: the tarpit
 * `CHROME_TLS`'s note describes, which node's ciphers were not enough to get
 * out of. aircanada and grainger needed bugs fixed elsewhere as well — see
 * `fetchResponse` in `src/akamai/sbsd/solver.ts` and `externalScripts` in
 * `grainger-lightpanda.ts`. `ca-edd` does not move at all, so whatever that
 * one is, it is not the fingerprint.
 *
 * ## what it does to a request
 *
 *   - rewrites `user-agent` and the `sec-ch-*` hints to the Chrome identity in
 *     `profile.ts`, so the headers agree with the profile the solver is given
 *   - decompresses the response and forwards it decoded, dropping
 *     `content-encoding` and `content-length` to match
 *   - never follows redirects — the browser owns navigation
 *   - hands every response to `onResponse`, which is how the Akamai example
 *     captures the sensor script without Playwright's `route.fetch`
 *
 * ## the certificate
 *
 * One self-signed certificate, generated with `openssl` into `target/` on
 * first use and reused after that. It is served for every host, which works
 * because Lightpanda is started with `--ca-cert` pointing at it (so it is a
 * trusted root) and `--insecure-disable-tls-host-verification` (so the name
 * mismatch is not fatal). Both flags apply to the one browser process this
 * library starts, which only ever talks to this proxy.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';
import { promisify } from 'node:util';

import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';

import { PROFILE } from '#src/datadome/profile.js';
import {
  type HeaderPairs,
  type Impersonator,
  start as startImpersonator,
} from '#src/impersonate.js';

const execFileAsync = promisify(execFile);
const CERT_DIR = join(process.cwd(), 'target', 'lightpanda-mitm');
/**
 * A dead upstream connection used to hang `forward()` forever with nothing
 * in the logs to say why — the browser (or `mitm.fetch`) waiting on it looks
 * identical to a slow solve from the outside, and `page.goto`'s own timeout
 * is the only thing that ever surfaced it, 90s later, pointing at navigation
 * rather than the request that actually stalled.
 */
const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Chrome's TLS parameters, in Chrome's order, for the **undici fallback**
 * only — `transport: 'undici'`. The default transport is
 * `src/impersonate.ts`, which does not need any of this because it is
 * Chrome's stack rather than an imitation of it. This is kept because it is
 * the best node alone can do, and because the measurements below are why the
 * sidecar exists.
 *
 * The header rewriting above was only ever half the job. The whole reason
 * this file exists is that a bot manager reads the connection and not just
 * the headers — that is stated at the top for DataDome and Lightpanda, and it
 * is just as true of the client we replace Lightpanda *with*. undici's
 * defaults are OpenSSL's, and OpenSSL is not Chrome.
 *
 * Measured against hilton.com/en/ on 2026-09-09, same headers, same machine,
 * four ways:
 *
 *   undici default, http/1.1            403 after 46s, then no answer at all
 *   http/2, undici default TLS          403 after 9s
 *   these parameters, http/1.1          200 in 351ms
 *   these parameters, http/2            200 in 382ms
 *
 * So the suite list and the curve order are what hilton is reading, not the
 * protocol version. Untouched: aircanada 200 either way, aa 302 either way —
 * this is not a change that trades one target for another.
 *
 * The failure mode is worth recognising because it does not look like a
 * block. Hilton holds the connection open and answers late or never rather
 * than refusing, so everything downstream reports a timeout and blames
 * itself: Lightpanda gives up on the navigation after 5s and renders
 * `OperationTimedout`, which reads as a slow site.
 *
 * **This gets close, not equal.** JA3/JA4 also cover the extension order and
 * GREASE values, and node's TLS bindings expose neither — a determined
 * fingerprint still says "not Chrome". Matching exactly needs a client built
 * on BoringSSL, which is now what `src/impersonate.ts` is and why it is the
 * default. What is here is the part reachable from node, enough for some of
 * these targets and, as the table at the top of this file shows, not enough
 * for hilton, aircanada or ca-edd.
 *
 * ALPN is left alone deliberately, so this keeps negotiating http/1.1. Chrome
 * would speak h2, and undici can (`allowH2`) — but node's h2 SETTINGS frames
 * are not Chrome's either, and Akamai fingerprints those too. Advertising h2
 * to get a second fingerprint wrong is not obviously better than not
 * advertising it; the table above says nothing here needs it.
 */
const CHROME_TLS = {
  ciphers: [
    'TLS_AES_128_GCM_SHA256',
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-ECDSA-CHACHA20-POLY1305',
    'ECDHE-RSA-CHACHA20-POLY1305',
    'ECDHE-RSA-AES128-SHA',
    'ECDHE-RSA-AES256-SHA',
    'AES128-GCM-SHA256',
    'AES256-GCM-SHA384',
    'AES128-SHA',
    'AES256-SHA',
  ].join(':'),
  ecdhCurve: 'X25519:P-256:P-384',
  sigalgs: [
    'ecdsa_secp256r1_sha256',
    'rsa_pss_rsae_sha256',
    'rsa_pkcs1_sha256',
    'ecdsa_secp384r1_sha384',
    'rsa_pss_rsae_sha384',
    'rsa_pkcs1_sha384',
    'rsa_pss_rsae_sha512',
    'rsa_pkcs1_sha512',
  ].join(':'),
};
const CERT_PATH = join(CERT_DIR, 'cert.pem');
const KEY_PATH = join(CERT_DIR, 'key.pem');

/** Hop-by-hop headers, which belong to one connection and must not be relayed. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * The identity we claim upstream, whatever the browser had to say about it.
 * Defaults to the DataDome profile; the Akamai example overrides it, because
 * that solver models a different Chrome and the two have to agree — the
 * telemetry claims one browser and the headers must not claim another.
 */
const DEFAULT_IDENTITY: Record<string, string> = {
  'sec-ch-ua': PROFILE.brands
    .map(({ brand, version }) => `"${brand}";v="${version}"`)
    .join(', '),
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'user-agent': PROFILE.userAgent,
};

/**
 * Chrome's header order, which is part of the fingerprint. Anything the
 * browser sent that is not in this list follows, in its own order.
 */
const CHROME_ORDER = [
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'upgrade-insecure-requests',
  'user-agent',
  'content-type',
  'accept',
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-user',
  'sec-fetch-dest',
  // Only present on the impersonate transport, and only because it is: node
  // cannot decode zstd, so the undici fallback must not claim it. curl can,
  // and placing it here rather than letting curl prepend its own is the
  // difference between Chrome's order and curl's.
  'accept-encoding',
  'accept-language',
  'cookie',
  'priority',
];

/**
 * Chrome's, including `zstd`, which is the giveaway: every other client in
 * this repo sends the three-value list because that is all node can decode.
 */
const CHROME_ACCEPT_ENCODING = 'gzip, deflate, br, zstd';

/**
 * Lightpanda sends six headers and no more: host, accept, accept-encoding,
 * accept-language, user-agent, sec-ch-ua. Chrome sends the `sec-fetch-*` set
 * on every request and `upgrade-insecure-requests` on navigations, and their
 * absence is conspicuous — grainger.com answers a request without them with
 * its own error page rather than the real one. Fill in what the browser did
 * not send, inferring the request's kind from `accept`, which is the one
 * signal Lightpanda does vary.
 */
const fetchMetadata = (
  headers: Record<string, string>,
  targetUrl: string,
  method: string
): Record<string, string> => {
  const accept = headers['accept'] ?? '';
  const isDocument = accept.startsWith('text/html');
  const referer = headers['referer'];
  // A body means `fetch()` or XHR, not a tag load. Chrome sends `Origin` on
  // every such request, even same-origin, and Lightpanda sends none —
  // `Origin` is a forbidden header name, so the page cannot add it either.
  // DataDome checks for it: without it the solve is accepted and the cookie
  // it hands back is void on first use.
  const isApiCall = method !== 'GET' && method !== 'HEAD';
  let site = 'none';
  if (referer) {
    try {
      site =
        new URL(referer).origin === new URL(targetUrl).origin
          ? 'same-origin'
          : 'cross-site';
    } catch {
      site = 'cross-site';
    }
  }
  return isDocument
    ? {
        // Lightpanda's document `accept` is the short form; Chrome 1xx sends
        // the image formats too. DataDome reads it: with the short form it
        // serves a captcha, with Chrome's it serves an interstitial.
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        priority: 'u=0, i',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': site,
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
      }
    : {
        ...(isApiCall && !headers['origin'] && referer
          ? { origin: new URL(referer).origin }
          : {}),
        priority: 'u=1, i',
        'sec-fetch-dest': accept.includes('image/') ? 'image' : 'empty',
        'sec-fetch-mode': isApiCall || headers['origin'] ? 'cors' : 'no-cors',
        'sec-fetch-site': site === 'none' ? 'same-origin' : site,
      };
};

export type Capture = {
  body: string;
  headers: Record<string, string>;
  /** Every `set-cookie` on the response, unjoined. */
  setCookie: string[];
  status: number;
  url: string;
};

export type Forwarded = {
  /** The decoded body as text. Meaningless for an image; `bytes` is not. */
  body: string;
  /**
   * The decoded body as it came off the wire. The proxy relays this rather
   * than `body`, because `body` is a utf-8 decode and every script, font and
   * image that is not utf-8 comes out of one corrupted.
   */
  bytes: Buffer;
  headers: Record<string, string>;
  setCookie: string[];
  status: number;
};

export type Mitm = {
  caCertPath: string;
  /**
   * Make a request through this proxy without a browser involved — same
   * dispatcher, same identity, same exit IP. `src/akamai/sensor/comcast-lightpanda.ts`
   * hands this to the solver in place of Playwright's `route.fetch`, which
   * stalls against Lightpanda.
   */
  fetch: (
    // eslint-disable-next-line no-unused-vars -- function-type parameters
    request: {
      body?: string;
      headers?: Record<string, string>;
      method?: string;
      url: string;
    }
  ) => Promise<Forwarded>;
  port: number;
  stop: () => Promise<void>;
  url: string;
};

export type MitmOptions = {
  /**
   * Log one line per request, with the headers as sent upstream. This is the
   * only place the real request is visible — Playwright reports what the
   * browser asked for, not what went out.
   */
  debug?: boolean;
  /**
   * The `user-agent` and `sec-ch-ua*` headers to claim upstream. Must match
   * whatever profile the solver you are using was told about.
   */
  identity?: Record<string, string>;
  // eslint-disable-next-line no-unused-vars -- function-type parameter
  log?: (message: string) => void;
  /** Called for every response, after decoding. Errors here are swallowed. */
  // eslint-disable-next-line no-unused-vars -- function-type parameter
  onResponse?: (capture: Capture) => void;
  /** The real proxy to go out through. Direct when omitted. */
  proxy?: string;
  /** Which client makes the upstream request. `auto` by default. */
  transport?: Transport;
};

/**
 * Which client makes the upstream request.
 *
 *   `impersonate`  curl-impersonate, via `src/impersonate.ts` — Chrome's own
 *                  ClientHello and HTTP/2 SETTINGS, not an imitation
 *   `undici`       node, with `CHROME_TLS` — no sidecar, no python
 *   `auto`         impersonate, falling back to undici with a warning if the
 *                  sidecar cannot start
 *
 * `auto` is the default so a checkout without the venv still runs, rather
 * than failing on a dependency it never needed before.
 */
export type Transport = 'auto' | 'impersonate' | 'undici';

/**
 * One self-signed certificate, generated on first use. `openssl` ships with
 * macOS and every CI image this repo runs on; there is no Node API for this.
 */
const ensureCertificate = async (): Promise<{ cert: Buffer; key: Buffer }> => {
  if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
    mkdirSync(CERT_DIR, { recursive: true });
    await execFileAsync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '365',
      '-subj',
      '/CN=lightpanda-mitm',
      '-addext',
      'subjectAltName=DNS:lightpanda-mitm,DNS:localhost',
      '-keyout',
      KEY_PATH,
      '-out',
      CERT_PATH,
    ]);
  }
  return {
    cert: readFileSync(CERT_PATH),

    key: readFileSync(KEY_PATH),
  };
};

/** Read a request body into one buffer. */
const readBody = async (req: IncomingMessage): Promise<Buffer | undefined> => {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
};

/** What a transport hands back, before `forward()` decodes and captures it. */
type Upstream = {
  bytes: Buffer;
  headers: Record<string, string>;
  /** Every `set-cookie`, unjoined — it is the one header that repeats. */
  setCookie: string[];
  status: number;
};

/** The sidecar: Chrome's ClientHello, Chrome's HTTP/2, Chrome's header order. */
const viaImpersonate = async (
  impersonator: Impersonator,
  request: {
    body?: Buffer | string;
    method: string;
    proxy?: string;
    url: string;
  },
  headers: HeaderPairs
): Promise<Upstream> => {
  const response = await impersonator.request({
    ...(request.body === undefined
      ? {}
      : {
          body: Buffer.isBuffer(request.body)
            ? request.body
            : Buffer.from(request.body),
        }),
    headers,
    method: request.method,
    ...(request.proxy ? { proxy: request.proxy } : {}),
    timeoutMs: UPSTREAM_TIMEOUT_MS,
    url: request.url,
  });
  const collapsed: Record<string, string> = {};
  const setCookie: string[] = [];
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === 'set-cookie') setCookie.push(value);
    else collapsed[name.toLowerCase()] = value;
  }
  return {
    bytes: response.body,
    headers: collapsed,
    setCookie,
    status: response.status,
  };
};

/**
 * Node, with `CHROME_TLS`. Kept so a checkout with no python still works, and
 * so the difference the sidecar makes stays measurable from one flag.
 *
 * undici's `fetch` and not `request`: `fetch` sends an `accept-encoding` and
 * decompresses, `request` sends none at all, and DataDome answers a request
 * without one with a captcha where the same request with one gets an
 * interstitial.
 */
const viaUndici = async (
  request: { body?: Buffer | string; method: string; url: string },
  headers: HeaderPairs,
  dispatcher?: Agent | ProxyAgent
): Promise<Upstream> => {
  const upstream = await undiciFetch(request.url, {
    ...(dispatcher ? { dispatcher } : {}),
    ...(request.body === undefined ? {} : { body: request.body }),
    headers,
    method: request.method,
    redirect: 'manual',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const bytes = Buffer.from(await upstream.arrayBuffer());
  const collapsed: Record<string, string> = {};
  for (const [name, value] of upstream.headers) collapsed[name] = value;
  return {
    bytes,
    headers: collapsed,
    setCookie: upstream.headers.getSetCookie(),
    status: upstream.status,
  };
};

/** Start the proxy. Resolves once it is listening. */
export const start = async (options: MitmOptions = {}): Promise<Mitm> => {
  const {
    debug = false,
    identity = DEFAULT_IDENTITY,
    log = console.log,
    onResponse,
    proxy,
    transport = 'auto',
  } = options;
  const { cert, key } = await ensureCertificate();
  // `requestTls` and not `connect`: on a ProxyAgent the origin is reached
  // through a CONNECT tunnel, and it is that inner handshake the target sees.
  // `proxyTls` would dress up the hop to our own proxy, which nobody reads.
  // The no-proxy path needs its own Agent for the same parameters — undici's
  // global default would otherwise put OpenSSL's hello on the wire.
  const dispatcher = proxy
    ? new ProxyAgent({ requestTls: CHROME_TLS, uri: proxy })
    : new Agent({ connect: CHROME_TLS });
  const sockets = new Set<Socket>();

  // Started before the listener, so a sidecar that cannot run is a failure to
  // start rather than a proxy that accepts connections and then 502s each one.
  let impersonator: Impersonator | undefined;
  if (transport !== 'undici') {
    try {
      impersonator = await startImpersonator({ log });
      log(`mitm: upstream is curl-impersonate (${impersonator.target})`);
    } catch (error) {
      if (transport === 'impersonate') throw error;
      log(
        `mitm: falling back to undici — ${(error as Error).message}. ` +
          "The TLS and HTTP/2 fingerprints will be node's, which hilton, " +
          'aircanada and ca-edd all refuse; install it with: make install'
      );
    }
  }

  /**
   * The one place a request leaves this process: header rewrite, upstream
   * call, decode. Used by the proxy server and by `mitm.fetch`, so both put
   * exactly the same thing on the wire.
   */
  const forward = async (request: {
    body?: Buffer | string;
    headers: Record<string, string>;
    method: string;
    url: string;
  }): Promise<Forwarded> => {
    const incoming: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (HOP_BY_HOP.has(name) || value === undefined) continue;
      // Three the client below reframes, so forwarding the browser's would
      // be a lie: `host` becomes the authority from the URL, the body is
      // re-sent so `content-length` is counted again, and `accept-encoding`
      // is set by whichever transport is in use — Chrome's four below, or
      // undici's three that it can actually decode.
      if (
        name === 'host' ||
        name === 'accept-encoding' ||
        name === 'content-length'
      )
        continue;
      incoming[name] = value;
    }
    const merged: Record<string, string> = {
      ...incoming,
      ...fetchMetadata(incoming, request.url, request.method),
      ...identity,
      // Only the impersonate transport can honour this: curl decodes all four
      // encodings, node decodes three, and a client that advertises zstd and
      // then cannot read it gets an unreadable body rather than a block.
      ...(impersonator ? { 'accept-encoding': CHROME_ACCEPT_ENCODING } : {}),
    };
    // Reassemble in Chrome's order: header order is fingerprinted too. Pairs
    // rather than an object from here down, because that is the only shape
    // that survives being handed to another process with its order intact.
    const headers: HeaderPairs = [];
    const seen = new Set<string>();
    for (const name of CHROME_ORDER) {
      const value = merged[name];
      if (value === undefined) continue;
      headers.push([name, value]);
      seen.add(name);
    }
    for (const [name, value] of Object.entries(merged)) {
      if (!seen.has(name)) headers.push([name, value]);
    }

    if (debug) {
      console.log(
        `[mitm] ${request.method} ${request.url}\n` +
          headers.map(([name, value]) => `        ${name}: ${value}`).join('\n')
      );
    }

    const {
      bytes,
      headers: upstreamHeaders,
      setCookie,
      status,
    } = impersonator
      ? // The sidecar dials the real proxy itself, so it is passed per
        // request rather than baked into a dispatcher.
        await viaImpersonate(
          impersonator,
          { ...request, ...(proxy ? { proxy } : {}) },
          headers
        )
      : await viaUndici(request, headers, dispatcher);
    // One decode, here, so `body` and the `onResponse` capture agree and
    // nothing downstream decodes the same bytes a second time.
    const text = bytes.toString('utf8');

    const forwarded: Forwarded = {
      body: text,
      bytes,
      headers: upstreamHeaders,
      setCookie,
      status,
    };

    if (onResponse) {
      try {
        onResponse({
          body: text,
          headers: upstreamHeaders,
          setCookie,
          status,
          url: request.url,
        });
      } catch {
        // A capture hook must never take down the request it observed.
      }
    }
    return forwarded;
  };

  // The HTTP server that parses requests off each terminated TLS connection.
  // Requests arriving here have already been CONNECTed, so `req.url` is a path
  // and the authority comes from the Host header.
  const inner: Server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const host = req.headers.host ?? '';
      const target = `https://${host}${req.url ?? '/'}`;
      try {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(req.headers)) {
          if (value === undefined) continue;
          headers[name] = Array.isArray(value) ? value.join(', ') : value;
        }
        const body = await readBody(req);
        const upstream = await forward({
          ...(body ? { body } : {}),
          headers,
          method: req.method ?? 'GET',
          url: target,
        });

        const outHeaders: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(upstream.headers)) {
          // The body is decoded and reframed, so the original framing headers
          // would be lies. Everything else passes.
          if (
            HOP_BY_HOP.has(name) ||
            name === 'content-encoding' ||
            name === 'content-length' ||
            name === 'set-cookie'
          ) {
            continue;
          }
          outHeaders[name] = value;
        }
        if (upstream.setCookie.length > 0) {
          outHeaders['set-cookie'] = upstream.setCookie;
        }

        res.writeHead(upstream.status, outHeaders);
        // `bytes` and not `body`: an image or a non-utf-8 script relayed as a
        // utf-8 string arrives corrupted, and a challenge page that fails to
        // load its own assets looks exactly like a block.
        res.end(upstream.bytes);
      } catch (error) {
        // 502 is the honest answer, and it surfaces in the browser as a failed
        // request rather than a hang.
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`mitm: ${(error as Error).message}`);
      }
    })();
  });

  // The proxy endpoint Lightpanda points at. Only CONNECT matters — every
  // target in these examples is https.
  const outer: Server = createServer((_req, res) => {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('mitm: this proxy only handles CONNECT');
  });

  outer.on('connect', (_req, socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    // Terminate TLS ourselves, then hand the decrypted stream to `inner` as if
    // it were an ordinary connection.
    const tlsSocket = new TLSSocket(socket, { cert, isServer: true, key });
    tlsSocket.on('error', () => tlsSocket.destroy());
    inner.emit('connection', tlsSocket);
  });

  await new Promise<void>((resolve) => outer.listen(0, '127.0.0.1', resolve));
  const address = outer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('mitm: could not determine the listening port');
  }
  const { port } = address;

  return {
    caCertPath: CERT_PATH,
    fetch: (request) =>
      forward({
        ...(request.body === undefined ? {} : { body: request.body }),
        headers: request.headers ?? {},
        method: request.method ?? 'GET',
        url: request.url,
      }),
    port,
    stop: async (): Promise<void> => {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => outer.close(() => resolve())),
        new Promise<void>((resolve) => inner.close(() => resolve())),
      ]);
      await dispatcher?.close();
      // Last, and always: a leaked sidecar is a python process nothing owns,
      // and `loadtest.ts --concurrency` would leave one per session behind.
      await impersonator?.stop();
    },
    url: `http://127.0.0.1:${port}`,
  };
};
