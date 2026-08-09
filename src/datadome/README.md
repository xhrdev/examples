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
3.  POST <solver>/dd/solve?submit=false       -> a prepared submission
4.  GET  geo.captcha-delivery.com/captcha/check?…  -> {"cookie":"datadome=…"}
5.  GET  https://www.grainger.com/  + cookie  -> 200, the real page
```

Step 3 sends `dd`, `ddCookie`, `iframeData` (the HTML from step 2), and a
`profile` / `js_profile` pair describing the browser you are claiming to be.

### `submit=false`, always

`/dd/solve` defaults to `submit=true`: the solver posts the payload itself and
returns `{"cookie": "…"}`. It is one less request, and it is almost always
wrong — **DataDome binds the clearance cookie to the IP that submitted it**, so
a cookie the solver earned works from the solver, not from you. You get a fresh
403 on your very next request and it looks like the solve failed.

Pass `?submit=false`, take the prepared submission, and send it yourself from
the IP you intend to scrape from.

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
  IP. Check session pinning and that you used `submit=false`.
- **The cookie is a full `Set-Cookie` string.** `/captcha/check` returns
  `datadome=abc…; Max-Age=31536000; Domain=.grainger.com; …`. Split on `;` and
  keep the value.
- **Cookies are per-registered-domain.** One earned on `grainger.com` works
  across its subdomains, and nowhere else.
