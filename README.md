# examples

[![release](https://github.com/xhrdev/examples/actions/workflows/release.yml/badge.svg)](https://github.com/xhrdev/examples/actions/workflows/release.yml)
[![CLA assistant](https://cla-assistant.io/readme/badge/xhrdev/examples)](https://cla-assistant.io/xhrdev/examples)

Working examples of solving live bot-protection challenges with
[xhr.dev](https://xhr.dev).

xhr.dev is a challenge solver you run yourself. It ships as a Docker container
that sits on your own infrastructure: you hand it a challenge, it hands back a
clearance cookie. Your traffic goes to the target site directly, and neither
your cookies nor your tokens are sent to a third party.

Every script here runs against a real site, and each one prints
`RESULT: SUCCESS` or `RESULT: FAIL` so you can tell at a glance whether it
worked.

- **Docs** — <https://docs.xhr.dev>
- **API reference** — [Akamai](https://docs.xhr.dev/api-akamai.html) ·
  [DataDome](https://docs.xhr.dev/api-datadome.html) ·
  [OpenAPI](https://docs.xhr.dev/openapi.yml)

## quickstart

```bash
npm ci
cp .env.example .env   # then fill in host= (proxy= is optional)

# only if you want the Python examples
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
```

Point `host=` at the machine running the container and check it is up:

```bash
curl http://$host:3000/hc
# {"status":"ok"}
```

`host=` takes either a bare host — `host=10.0.0.5`, meaning plain HTTP on port
3000, the self-hosted default — or a full URL such as
`host=https://trial.xhr.dev`. Use the URL form for anything you reach over the
public internet, so the API key and the clearance cookies come back over TLS
rather than in the clear.

If you were issued an API key, put it in `.env` as `api_key=` — every
example sends it as `x-api-key`. `/hc` is always reachable without one, so a
healthy `/hc` alongside a `401` from anything else means the key is missing or
wrong, not that the solver is down. You can check your own solve rate with it:

```bash
curl "http://$host:3000/stats?api_key=$api_key"
```

Then get a clearance cookie for grainger.com, using nothing but `fetch`:

```bash
npm run grainger
```

```
GET https://www.grainger.com/
  <- HTTP 403 (772 bytes)
  challenge: type=captcha cid=AHrlqAAAAAMAhkqgGpXPdrUAYp7pCQ==
GET /captcha/ (challenge document)
  <- HTTP 200 (583748 bytes)
POST /dd/solve
  <- prepared submission for /captcha/check
GET geo.captcha-delivery.com (submit)
  <- HTTP 200
clearance cookie: datadome=5uB5ZJ4oN~ahJP~mbA_M7YPnvF0X61YMMAh4A~VZQY01...
verifying against the target
  <- HTTP 200 (496641 bytes) "Grainger Industrial Supply - MRO Products…"
RESULT: SUCCESS
```

## the examples

| script | vendor | challenge | needs a browser |
|---|---|---|---|
| [`src/datadome/grainger-undici.ts`](src/datadome/grainger-undici.ts) | DataDome | captcha / interstitial | no — undici |
| [`src/datadome/grainger-axios.ts`](src/datadome/grainger-axios.ts) | DataDome | captcha / interstitial | no — axios |
| [`src/datadome/grainger-fetch.ts`](src/datadome/grainger-fetch.ts) | DataDome | captcha / interstitial | no — no deps |
| [`py-src/datadome/grainger_requests.py`](py-src/datadome/grainger_requests.py) | DataDome | captcha / interstitial | no — python, requests |
| [`py-src/datadome/grainger_httpx.py`](py-src/datadome/grainger_httpx.py) | DataDome | captcha / interstitial | no — python, httpx |
| [`py-src/datadome/grainger_urllib.py`](py-src/datadome/grainger_urllib.py) | DataDome | captcha / interstitial | no — python, stdlib |
| [`src/datadome/grainger.ts`](src/datadome/grainger.ts) | DataDome | captcha / interstitial | yes |
| [`src/datadome/idealista.ts`](src/datadome/idealista.ts) | DataDome | interstitial → captcha | yes |
| [`src/datadome/{alaska,saks,anthropologie,yelp,etsy,github,book-secure,bestwestern}.ts`](src/datadome/README.md#the-harder-targets) | DataDome | varies by target | yes |
| [`src/akamai/sensor/comcast.ts`](src/akamai/sensor/comcast.ts) | Akamai Bot Manager | `_abck` sensor | yes |
| [`src/akamai/sensor/ca-edd.ts`](src/akamai/sensor/ca-edd.ts) | Akamai Bot Manager | `_abck` sensor + login | yes |
| [`src/akamai/sbsd/hilton.ts`](src/akamai/sbsd/hilton.ts) | Akamai Bot Manager | SBSD + `_abck` sensor | yes — headed only |

Each vendor directory has its own README with the protocol details:
[**src/akamai**](src/akamai/README.md) · [**src/datadome**](src/datadome/README.md)

Akamai scores on two independent channels and the examples are split to match:
[**sensor**](src/akamai/sensor/README.md) is the classic `_abck` lane,
[**sbsd**](src/akamai/sbsd/README.md) is the bundle served from
`/.well-known/sbsd`. Properties that run both — hilton.com does — need both.

Run any of them directly, or use the npm aliases:

```bash
npm run grainger              # DataDome, no browser (undici)
npm run grainger:axios        # ...the same, with axios + a cookie jar
npm run grainger:fetch        # ...the same, with zero dependencies
npm run grainger:browser      # DataDome, via Playwright
npm run idealista
npm run etsy -- --screenshot  # ...and alaska, saks, anthropologie, yelp,
                              #    github, book-secure, bestwestern
npm run comcast               # Akamai, _abck sensor
npm run ca-edd                # ...and a login; needs username= and password=
npm run hilton                # Akamai, SBSD + _abck; headed only

# any script takes flags after --
node --env-file=.env src/datadome/grainger-undici.ts --url=https://www.idealista.com/
node --env-file=.env src/datadome/idealista.ts --headless
```

The Python examples read the same `.env` and take the same flags:

```bash
./venv/bin/python py-src/datadome/grainger_requests.py
./venv/bin/python py-src/datadome/grainger_httpx.py
./venv/bin/python py-src/datadome/grainger_urllib.py --url=https://www.idealista.com/
```

## two ways to integrate

**Plain HTTP.** You already have an HTTP scraper and just want a cookie.
Fetch the challenge, POST it to the solver, submit the result. No Chromium
anywhere, and it is the cheapest option by a wide margin — a solve costs four
requests and a few hundred milliseconds.

There are three interchangeable versions of that example, so you can copy
whichever matches your stack. They make the same four requests and differ only
in the client:

| file | client | notes |
|---|---|---|
| `src/datadome/grainger-undici.ts` | undici | per-request proxy via `ProxyAgent`; the default |
| `src/datadome/grainger-axios.ts` | axios + `axios-cookiejar-support` | cookie jar carries `datadome` for you |
| `src/datadome/grainger-fetch.ts` | Node's built-in `fetch` | no dependencies; run it with `--use-env-proxy` |
| `py-src/datadome/grainger_requests.py` | requests | `Session` keeps the jar |
| `py-src/datadome/grainger_httpx.py` | httpx | proxy is per-client, one per pinned session |
| `py-src/datadome/grainger_urllib.py` | urllib | standard library only |
| `dev-resources/curl` | curl + jq | the bare HTTP, no runtime at all |

The shared request building lives in
[`src/datadome/http-utils.ts`](src/datadome/http-utils.ts) and
[`py-src/datadome/http_utils.py`](py-src/datadome/http_utils.py), so each file
is just its own client.

The browser identity sits apart in [`src/profile.ts`](src/profile.ts), which
every example shares — both vendors, both languages, and the MCP server. There
is one answer in this repo to "which Chrome are we claiming to be", and that
matters more than it looks: the identity is cross-checked against the headers
actually sent, so a copy that drifts does not fail loudly, it fails as solves
that inexplicably stop being accepted. The Python clients cannot import
TypeScript, so they read [`py-src/profile.json`](py-src/profile.json),
generated by `npm run emit:profile` and kept honest by a test that fails when
the two disagree.

**Browser bridge.** The site needs a real browser anyway (a login flow, a
JS-rendered page), or the challenge wants a genuine browser context. The
solver computes the sensor payloads and your Chrome submits them, so the
requests carry real TLS fingerprints and a real cookie jar. This is
`grainger.ts`, `idealista.ts`, the eight harder DataDome targets, and both
Akamai examples.

Start with plain HTTP. Reach for the browser bridge when the site forces you to.

## mcp server

Everything above is written the other way round from how an agent works: a
human picks the target, and the challenge handling is written out ahead of time
for that one site. An LLM agent doing its own browsing does not know which page
will block it until the 403 arrives, so it cannot have the handling written in
advance.

[`src/mcp.ts`](src/mcp.ts) exposes the solver over
[MCP](https://modelcontextprotocol.io) so an agent can solve a challenge inside
its own loop and retry the request:

```bash
npm run mcp
```

It speaks stdio and reads `host=`, `api_key=` and `proxy=` from `.env`, exactly
like every other script here. Started by hand it will just sit there waiting for
a client on stdin — that is correct; the client is what launches it.

| tool | what it does |
|---|---|
| `health_check` | `GET /hc` — is the solver reachable |
| `solver_stats` | your own solve rate |
| `akamai_queue_metrics` | queue depth, for backpressure |
| `akamai_solve` | solve an Akamai `_abck` challenge for a URL, returning clearance cookies |
| `datadome_solve` | solve a DataDome captcha or interstitial |

The browser identity is filled in from [`src/profile.ts`](src/profile.ts), so an agent calls these
with a URL rather than having to invent a coherent `profile` and `js_profile` —
which it cannot do, since those fields are cross-checked against each other and
against the headers actually sent.

`datadome_solve` takes the HTML body of the 403 you just received, parses the
challenge out of it, and returns a **prepared submission** rather than a cookie.
Your agent has to send that itself, from the same exit IP it will browse from —
DataDome binds the clearance cookie to whoever submitted it, so a submission
made by anything else earns a cookie that is void where you need it.

### client config

Claude Code:

```bash
claude mcp add xhrdev -- npm --prefix /path/to/examples run mcp
```

Anything that reads the standard `mcpServers` block — Claude Desktop, Cursor,
Windsurf, Zed:

```json
{
  "mcpServers": {
    "xhrdev": {
      "command": "npm",
      "args": ["--prefix", "/path/to/examples", "run", "mcp"]
    }
  }
}
```

Use an absolute path — the client does not launch it from this directory. `.env`
is read relative to `--prefix`, so the same `.env` the examples use applies.

### an example prompt

Give the agent a target and tell it what to do when the target says no:

> Fetch `https://business.comcast.com/account/` and tell me the page title.
> Make the request through the proxy in `.env`, following redirects. If you get
> a `403` or an "Access Denied" page, use the **xhrdev** MCP server to get past
> it, then retry the same request with whatever cookies it gives you — through
> that same proxy.

That is the whole shape of it. The agent makes its request, and only if it is
actually blocked does it reach for a tool:

```
1. GET https://business.comcast.com/account/   (through the proxy)
   -> HTTP 403, "Access Denied"

2. akamai_solve { url: "https://business.comcast.com/account/" }
   -> { accepted: true, cookie_header: "_abck=...~0~...; bm_sz=...", ... }

3. GET the same URL again, same proxy, sending that cookie header
   -> HTTP 200, "Dashboard"
```

**All three steps have to leave from the same address.** The cookies are bound
to the IP that earned them, so an agent that solves through the proxy and then
retries with a built-in web-fetch tool from somewhere else gets a fresh 403
that looks exactly like a failed solve. Whatever your agent makes requests
with, it has to honour the proxy — which is worth stating in the prompt, as
above, rather than hoping.

For a DataDome target the middle step differs, because the solver hands back a
submission rather than a cookie:

> Fetch `https://www.grainger.com/` through the proxy in `.env`. If the
> response is a `403` whose body contains `var dd =`, pass that whole body to
> the xhrdev MCP server's `datadome_solve`, send the prepared submission it
> returns — same proxy — and retry with the `datadome` cookie you get back.

`akamai_solve` answers `challenged: false` when the target serves the page
without a challenge, which is the common case when an IP is already warm. That
is not a failure and takes about a second — the agent should just make its
request.

### what it does under the hood

`akamai_solve` launches a real Chrome and relays each sensor request through
it, which is the same browser bridge [`src/akamai/sensor/comcast.ts`](src/akamai/sensor/comcast.ts)
uses. That is deliberate: `POST /akamai/solve` solves server-side, so the
sensor requests carry the container's TLS fingerprint rather than a browser's,
and against a target that checks the submitting client the payload is built
correctly and then never accepted — the solve ends `timeout` /
`deadline_exceeded` with nothing naming the cause. Driving a browser costs a
launch and 20–60s per call, and it gets `_abck` to `~0~`.

Two things follow. **Raise your client's request timeout** past its default —
60s in most clients, which a cold solve can outrun. And **retry through the
same proxy**, since the cookies are bound to the exit IP that earned them.

`datadome_solve` needs no browser: it is four HTTP requests, and the tool makes
the first three.

## proxies

`proxy=` is optional. Leave it unset and every example goes out from the
machine it runs on — the challenge, the solve and the submission all from one
address, which is the only thing the bot vendors actually require. That is the
simplest way to try the flow, and it is a real deployment for a box that
already egresses where you want it to. The scripts say `DIRECT` instead of
`PROXY` in their log lines so you can tell which mode you are in.

DataDome captcha solves used to be an exception here. They are not any more,
and the examples no longer carry the hint that said otherwise. Akamai has
always worked with no proxy at all — it relays its sensors through your own
browser, so there is nothing to route.

Set it when you need someone else's exit IP: a residential pool to exercise
the solve path, or geography the target expects. Then clearance cookies are
bound to the IP that earned them, and two things follow:

1. **Pin a session.** If your proxy pool rotates mid-flow, the cookie you get
   back is already void. `src/proxy.ts` handles this for every provider we
   know of — it rewrites an existing session token wherever it appears
   (oxylabs `-sessid-`, rayobyte `-hardsession-`, bright data / smartproxy /
   joinmassive `-session-`), in the username or the password, and grafts one
   on when a known provider's string has none.

   Using something else? Put a `{session}` placeholder in the credentials
   where the rotating value belongs and it will be filled in:

   ```
   proxy=http://myuser-{session}:mypass@proxy.example.com:8000
   ```

   If a proxy offers nothing to pin, the load-test runner says so rather than
   quietly sending every iteration through one IP.
2. **Submit from your own IP.** `/dd/solve` returns a prepared submission
   rather than sending one, because DataDome binds the cookie to whichever IP
   submitted it. Make that final request yourself. The examples all do this.

Datacenter proxies are faster and cheaper, but plenty of sites do not bother
challenging them, so you may never exercise the solve path. In our testing
grainger.com serves datacenter IPs without a challenge but challenges
residential ones, while idealista.com challenges both. If a run reports
`no challenge to solve`, that is the proxy talking, not a bug.

## load testing

`src/loadtest.ts` runs any script repeatedly with rotating proxy sessions and
reports pass/fail/error rates. Docker keeps Chromium isolated:

```bash
docker build -t examples .

docker run --rm --env-file .env examples \
  node --env-file=.env src/loadtest.ts \
    --script=src/akamai/sensor/comcast --headless --iterations=200 --concurrency=20
```

| flag | default | description |
|---|---|---|
| `--script` | `src/akamai/sensor/ca-edd` | script to run, as a path relative to the project root |
| `--iterations` | `100` | total attempts |
| `--concurrency` | `1` | parallel workers |
| `--headless` | off | pass `--headless` through to the child script |
| `--proxy` | `$proxy` | proxy URL with optional session rotation |
| `--host` | `$host` | host/IP forwarded to the child as `host` |
| `--quiet` | off | suppress per-attempt output |

Drop `--headless` to watch a browser-based script work.

## troubleshooting

| symptom | cause |
|---|---|
| `no challenge to solve` | the site let your IP through. Try a residential proxy. |
| a fresh 403 right after a successful solve | the cookie was earned on a different IP — check session pinning, and that you sent the submission yourself |
| `RESULT: FAIL - proxy session failed` | dead exit node. The examples retry three times; raise it with `--attempts=5` |
| `RESULT: FAIL - network error` | same, with no `proxy=` set: the transport failed from this machine |
| `HTTP 500 DD solve error` on a `DIRECT` run | DataDome captcha solves need a proxy; set `proxy=` in `.env` |
| solver returns 400 | the profile and the headers you send disagree. Change both together, never one alone |
| solver returns 500 with `queue_full` | the container is saturated; check `GET /akamai/queue-metrics` |
| `RESULT: FAIL - rate limit hit` | the solver answered 429. See rate limits below |

## rate limits

The solver is rate limited per API key. Over the limit it answers HTTP 429
with a `Retry-After`, and every example here treats that as its own outcome:
it prints `RESULT: FAIL - rate limit hit` with how long to wait, and exits **3**
(distinct from 1 for a generic failure and 2 for an Akamai access denial).

Nothing retries a 429 on purpose. Every other error in these examples is worth
another attempt on a fresh proxy session; a 429 is not, because the budget is
already spent and retrying only spends more of it. `src/loadtest.ts` goes
further and stops launching iterations the moment one comes back rate limited.

Permanent keys are not limited. If you are on a shared or trial key and hitting
the ceiling in normal use, ask for a higher limit rather than retrying in a
loop.

## curl

[`dev-resources/curl`](dev-resources/curl) runs the same four requests in
shell, which is the one to read if you are integrating from a language we do
not have an example for:

```bash
dev-resources/curl                          # defaults to seloger.com
dev-resources/curl https://www.leboncoin.fr/
```

It also makes one thing very visible: **DataDome fingerprints the TLS
handshake**, and curl's is nothing like Chrome's. That never stops the solve —
the solver only sees the challenge you hand it — but it changes what the site
is willing to give you. Of the three we tested:

| site | plain curl |
|---|---|
| seloger.com | works end to end — the default |
| leboncoin.fr | solves, but the site re-challenges when the cookie comes back |
| idealista.com | refuses before there is anything to solve; the challenge document is a block page and the solver reports `IP is banned` |

If a site rejects curl, that is the fingerprint talking and not the solver.
Use one of the Node or Python examples, or a curl build that impersonates
Chrome.

## repl

`npm run repl` opens a Node REPL with the repo's helpers and your pinned proxy
already loaded, which is the quickest way to poke at a live challenge:

```
> const html = await get('https://www.grainger.com/')
HTTP 403
> parseBlockPage(html)
{ rt: 'c', cid: 'AHrlqAAAAAM…', hsh: '97DAF2A1CB…', cookie: 'YWlkQoc1…' }
```

`npm run repl:watch` reloads it on save.

## hot reload

Point `dev-resources/watch-file` at the script you are working on and run it:

```bash
dev-resources/watch-file
```

## contributing

Adding a site is welcome — copy the closest existing example, keep the
`RESULT: SUCCESS` / `RESULT: FAIL` convention, and make sure `make ci` passes.
Contributions are covered by the [CLA](CLA.md).
