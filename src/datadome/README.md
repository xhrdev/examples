# DataDome

DataDome protects a site by handing suspicious requests a challenge instead of
the page. Solving it earns a `datadome` cookie; send that cookie and you get
the real content.

- API reference: <https://docs.xhr.dev/api-datadome.html>

## the two challenge types

DataDome serves one of two things, and the `rt` field in the block page tells
you which:

| `rt` | type | what it looks like |
|---|---|---|
| `i` | **interstitial** | a "verifying your browser" page that resolves on its own. Solved by POSTing a payload. |
| `c` | **captcha** | a puzzle page. Solved by GETing `/captcha/check` with the payload in the query string. |

An interstitial often escalates to a captcha when DataDome is unconvinced —
`idealista.ts` exercises exactly that `i -> c` chain. Handle both.

## recognising a challenge

A blocked response is a 403 whose body carries an inline `dd` object:

```html
<script>var dd={'rt':'c','cid':'AHrlqAAAAAM…','hsh':'97DAF2A1CB…','t':'fe',
                's':51825,'e':'9cd1f431…','host':'geo.captcha-delivery.com',
                'cookie':'YWlkQoc1fsbfX4s8…'}</script>
```

Those fields are the challenge. `cookie` is the same value DataDome set in the
`datadome` response cookie, and it is what you pass as `ddCookie`.

## the HTTP flow

`grainger-undici.ts` is this, end to end, in about 200 lines:

```
1.  GET  https://www.grainger.com/            -> 403 + var dd={…} + datadome cookie
2.  GET  geo.captcha-delivery.com/captcha/…   -> challenge document HTML
3.  POST <solver>/dd/solve       -> a prepared submission
4.  GET  geo.captcha-delivery.com/captcha/check?…  -> {"cookie":"datadome=…"}
5.  GET  https://www.grainger.com/  + cookie  -> 200, the real page
```

Step 3 sends `dd`, `ddCookie`, `iframeData` (the HTML from step 2), and a
`profile` / `js_profile` pair describing the browser you are claiming to be.

### you send the submission, always

`/dd/solve` never submits for you — it returns a prepared submission.
**DataDome binds the clearance cookie to the IP that submitted it**, so a
cookie the solver earned would work from the solver, not from you: you would
get a fresh 403 on your very next request and it would look like the solve
failed.

Take the prepared submission and send it yourself from the IP you intend to
scrape from.

### keep the identity consistent

The `profile` you send the solver has to match the headers you actually put on
the wire — user agent, `sec-ch-ua`, platform, language, timezone. DataDome
cross-checks them. Changing the user agent in `PROFILE` without changing
`navigationHeaders` is the most common way to get a solve rejected, and the
error it produces looks nothing like the cause.

## the browser flow

`solver.ts` exports one function:

```typescript
import { solve } from '#src/datadome/solver.js';

const result = await solve(page, { proxy, solverApiKey, solverUrl, url });
// -> { cookie, responseStatus, url }
```

It attaches to a Playwright page, watches for a challenge, asks the solver for
the sensor values, and lets **Chrome** own the actual submission — the native
interstitial POST or captcha GET — so the request carries a real TLS
fingerprint and the browser's own cookie jar. It handles the `i -> c`
escalation and resolves once DataDome returns an accepted cookie.

Use it when the site needs a browser anyway. If all you want is a cookie, the
HTTP flow is far cheaper.

## examples

| file | what it shows |
|---|---|
| `grainger-undici.ts` | the full HTTP flow with **undici**. `--url=` points it at any DataDome site. |
| `grainger-axios.ts` | the same flow with **axios** and a cookie jar |
| `grainger-fetch.ts` | the same flow with **Node's built-in fetch** and no dependencies |
| `grainger.ts` | the same target through the browser bridge |
| `grainger-lightpanda.ts` | the flow driven by **Lightpanda** instead of Chrome — see below |
| `idealista.ts` | an interstitial that escalates to a captcha |
| `http-utils.ts` | request building and response parsing the three HTTP versions share |
| `profile.ts` | the browser identity and DataDome endpoints, shared with `solver.ts` |

The same three, in Python, under `py-src/datadome/`:

| file | what it shows |
|---|---|
| `grainger_requests.py` | the HTTP flow with **requests** |
| `grainger_httpx.py` | the same flow with **httpx** |
| `grainger_urllib.py` | the same flow with **only the standard library** |
| `http_utils.py` | the Python port of `http-utils.ts` (identity included) |

```bash
npm run grainger          # undici
npm run grainger:axios    # axios
npm run grainger:fetch    # no dependencies
node --env-file=.env src/datadome/grainger-undici.ts --url=https://www.idealista.com/
node --env-file=.env src/datadome/idealista.ts --headless
```

### lightpanda

`grainger-lightpanda.ts` swaps Chrome for [Lightpanda], a headless browser with
no renderer — a ~70MB binary that starts in milliseconds and holds a page in a
few MB. `npm install` downloads it to `target/`, so there is nothing to set up:

```bash
npm run grainger:lightpanda
```

**Lightpanda cannot reach DataDome on its own.** Point it straight at a proxy
and DataDome answers `rt:"c"` with `t:"bv"` — a banned visitor — before a line
of JavaScript runs, where the same proxy IP a second later gets a plain
`t:"fe"` from `grainger-undici.ts`. It is not the user agent: undici sending
`User-Agent: Lightpanda/1.0` over that proxy still gets `t:"fe"`. It is the
connection, and nothing inside the browser can change it — `--user-agent`
rejects any value containing "Mozilla", and `Emulation.setUserAgentOverride` is
ignored on the wire.

So `src/lightpanda.ts` puts `src/mitm.ts` in front of it: a local proxy that
terminates TLS and re-makes each request with undici, the client the
browser-free examples already use. With that the ban is gone — grainger serves
an ordinary interstitial and the solve comes back in a second or two. Two
details of that proxy were found here:

- a request with **no `accept-encoding`** gets a captcha where the same request
  with one gets an interstitial. `undici.request` sends none, `undici.fetch`
  does, so the proxy uses `fetch`.
- Lightpanda sends six headers and no `sec-fetch-*`. Without them grainger.com
  serves its own error page instead of the real one.

**Status:** it works, but not on every attempt. A verified attempt returns the
real page and DataDome rotates the cookie:

```
clearance cookie: datadome=QTlff_rUpD_JXTy6VJjnQ0wA9hB7akP68m1D2t678Gh_…
verifying against the target
  <- HTTP 200 (489743 bytes) "Grainger Industrial Supply - MRO Products…"
```

About one attempt in four gets there; the others earn a cookie that is refused
on first use and come back as a fresh `rt=c t=fe`. With the three attempts the
runner makes, a run succeeds roughly six times in ten. `grainger-undici.ts` on
the same proxy in the same minute verifies first time, every time — so what is
borderline is the solve computed from a Lightpanda page, not the solver, the
proxy, or the IP. Retry rather than expect it; a failed attempt costs about
seven seconds.

See `src/lightpanda.ts` for the three differences that bite immediately (never
reuse the starting page, `newCDPSession` crashes Playwright, `content()` never
returns).

[Lightpanda]: https://lightpanda.io

There is a shell version too, `dev-resources/curl`, which is the same flow in
curl and jq. It is the clearest place to see the raw HTTP, and it doubles as a
demonstration that TLS fingerprinting is a separate problem from solving: the
solve always succeeds, but whether the site honours the cookie afterwards
depends on how it treats a non-browser client. See the README for the
site-by-site results.

### picking a client

All three are the same four requests, so copy whichever matches what you
already use. Two differences worth knowing:

- **axios** needs its proxy agent and its cookie jar to be *the same object*.
  Passing `jar` alongside a plain `HttpsProxyAgent` throws `does not support
  for use with other http(s).Agent` — wrap the proxy agent with
  `createCookieAgent` from `http-cookie-agent` instead. Also set
  `proxy: false`, or axios rewrites the request line and breaks CONNECT.
- **requests and httpx** both keep a cookie jar, and both need help with
  this one cookie. DataDome sets the clearance cookie with
  `Domain=.grainger.com`, but the response comes from
  `geo.captcha-delivery.com`, so the jar drops it as a domain mismatch. Worse,
  the *block* response already put a pre-solve `datadome` cookie in the jar
  for that domain — add the new one without removing it and both go out, the
  stale value wins, and it looks exactly like a failed solve. Replace, do not
  append.
- **urllib** has no per-request proxy escape hatch, so build two openers: one
  with a `ProxyHandler` for the target traffic, and one with an empty
  `ProxyHandler({})` for the call to your own solver. Credentials in the proxy
  URL become the `Proxy-Authorization` header on the CONNECT automatically.
- **built-in fetch** takes its proxy from `HTTP_PROXY` / `HTTPS_PROXY`, and
  only reads them when Node is started with `--use-env-proxy`. Set `NO_PROXY`
  to the solver's host so that call goes direct — this is required, not
  tidiness: a datacenter proxy will not tunnel to the solver's port, so the
  solve fails without it. Node matches `NO_PROXY` on the bare host, so an IP
  works as well as a name.

  The only thing you give up is that the configuration is per-process rather
  than per-request, so one process cannot use two proxies at once. Every
  example here uses a single proxy and the load-test runner spawns a process
  per iteration, so it makes no practical difference — pick this version if
  you would rather not take a dependency.

## gotchas

- **`no challenge to solve`** — the site served your IP the page directly.
  Datacenter proxies frequently sail through; try a residential pool.
- **A 403 immediately after a solve** — the cookie was earned on a different
  IP. Check session pinning, and that you sent the submission yourself.
- **The cookie is a full `Set-Cookie` string.** `/captcha/check` returns
  `datadome=abc…; Max-Age=31536000; Domain=.grainger.com; …`. Split on `;` and
  keep the value.
- **Cookies are per-registered-domain.** One earned on `grainger.com` works
  across its subdomains, and nowhere else.
