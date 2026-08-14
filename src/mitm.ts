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
 * Upstream, the request is undici's: the same client `grainger-undici.ts`
 * uses, with the same TLS fingerprint DataDome already accepts. Lightpanda
 * keeps the DOM, the cookie jar and the JavaScript; it just stops being the
 * thing that opens the socket.
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

import { ProxyAgent, fetch as undiciFetch } from 'undici';

import { PROFILE } from '#src/datadome/profile.js';

const execFileAsync = promisify(execFile);
const CERT_DIR = join(process.cwd(), 'target', 'lightpanda-mitm');
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
  'accept',
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-user',
  'sec-fetch-dest',
  'accept-language',
  'cookie',
  'priority',
];

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
  body: string;
  headers: Record<string, string>;
  setCookie: string[];
  status: number;
};

export type Mitm = {
  caCertPath: string;
  /**
   * Make a request through this proxy without a browser involved — same
   * dispatcher, same identity, same exit IP. `src/akamai/comcast-lightpanda.ts`
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
  /** Called for every response, after decoding. Errors here are swallowed. */
  // eslint-disable-next-line no-unused-vars -- function-type parameter
  onResponse?: (capture: Capture) => void;
  /** The real proxy to go out through. Direct when omitted. */
  proxy?: string;
};

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

/** Start the proxy. Resolves once it is listening. */
export const start = async (options: MitmOptions = {}): Promise<Mitm> => {
  const {
    debug = false,
    identity = DEFAULT_IDENTITY,
    onResponse,
    proxy,
  } = options;
  const { cert, key } = await ensureCertificate();
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  const sockets = new Set<Socket>();

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
      // `host` becomes the authority from the URL; `accept-encoding` is
      // undici's to negotiate, since we forward the response decoded.
      if (name === 'host' || name === 'accept-encoding') continue;
      incoming[name] = value;
    }
    const merged: Record<string, string> = {
      ...incoming,
      ...fetchMetadata(incoming, request.url, request.method),
      ...identity,
    };
    // Reassemble in Chrome's order: header order is fingerprinted too.
    const headers: Record<string, string> = {};
    for (const name of CHROME_ORDER) {
      if (merged[name] !== undefined) headers[name] = merged[name];
    }
    for (const [name, value] of Object.entries(merged)) {
      if (headers[name] === undefined) headers[name] = value;
    }

    if (debug) {
      console.log(
        `[mitm] ${request.method} ${request.url}\n` +
          Object.entries(headers)
            .map(([name, value]) => `        ${name}: ${value}`)
            .join('\n')
      );
    }

    // undici's `fetch`, deliberately: it is the client the browser-free
    // examples use, down to the `accept-encoding` it adds and the
    // decompression it does. `request` sends no `accept-encoding` at all, and
    // DataDome answers a request without one with a captcha where the same
    // request with one gets an interstitial.
    const upstream = await undiciFetch(request.url, {
      ...(dispatcher ? { dispatcher } : {}),
      ...(request.body === undefined ? {} : { body: request.body }),
      headers,
      method: request.method,
      redirect: 'manual',
    });
    const text = await upstream.text();

    const upstreamHeaders: Record<string, string> = {};
    for (const [name, value] of upstream.headers) upstreamHeaders[name] = value;

    const forwarded: Forwarded = {
      body: text,
      headers: upstreamHeaders,
      // `set-cookie` is the one header that legitimately repeats, and joining
      // it with commas would corrupt Expires dates.
      setCookie: upstream.headers.getSetCookie(),
      status: upstream.status,
    };

    if (onResponse) {
      try {
        onResponse({
          body: text,
          headers: upstreamHeaders,
          setCookie: forwarded.setCookie,
          status: upstream.status,
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
        res.end(upstream.body);
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
    },
    url: `http://127.0.0.1:${port}`,
  };
};
