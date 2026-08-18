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
cp .env.example .env   # then fill in host= and proxy=

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
| [`src/akamai/comcast.ts`](src/akamai/comcast.ts) | Akamai Bot Manager | `_abck` sensor | yes |
| [`src/akamai/ca-edd.ts`](src/akamai/ca-edd.ts) | Akamai Bot Manager | `_abck` sensor + login | yes |

Each vendor directory has its own README with the protocol details:
[**src/akamai**](src/akamai/README.md) · [**src/datadome**](src/datadome/README.md)

Run any of them directly, or use the npm aliases:

```bash
npm run grainger              # DataDome, no browser (undici)
npm run grainger:axios        # ...the same, with axios + a cookie jar
npm run grainger:fetch        # ...the same, with zero dependencies
npm run grainger:browser      # DataDome, via Playwright
npm run idealista
npm run comcast
npm run ca-edd                # needs username= and password=

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
is just its own client. The browser identity sits apart in
[`src/datadome/profile.ts`](src/datadome/profile.ts), which the Playwright
solver shares — there is one answer to "which Chrome are we claiming to be".

**Browser bridge.** The site needs a real browser anyway (a login flow, a
JS-rendered page), or the challenge wants a genuine browser context. The
solver computes the sensor payloads and your Chrome submits them, so the
requests carry real TLS fingerprints and a real cookie jar. This is
`grainger.ts`, `idealista.ts`, and both Akamai examples.

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
| `akamai_solve` | solve an Akamai `_abck` challenge for a URL |
| `datadome_solve` | solve a DataDome captcha or interstitial |

The browser identity is filled in from
[`src/datadome/profile.ts`](src/datadome/profile.ts), so an agent calls these
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
claude mcp add xhr-dev -- npm --prefix /path/to/examples run mcp
```

Anything that reads the standard `mcpServers` block — Claude Desktop, Cursor,
Windsurf, Zed:

```json
{
  "mcpServers": {
    "xhr-dev": {
      "command": "npm",
      "args": ["--prefix", "/path/to/examples", "run", "mcp"]
    }
  }
}
```

Use an absolute path — the client does not launch it from this directory. `.env`
is read relative to `--prefix`, so the same `.env` the examples use applies.

### what works and what does not

`datadome_solve` clears grainger.com end to end through the tool: parse the 403,
solve, submit, verify `200`.

`akamai_solve` drives `POST /akamai/solve`, which fetches and solves
server-side. That path builds a valid sensor payload — call it with
`submit: false` and you get the submission back to send yourself — but for a
target that checks the submitting client, as `business.comcast.com` does, the
cookie is never accepted and the solve ends `timeout` /`deadline_exceeded`. Those
targets need the WebSocket session with a real browser relaying each sensor
request, which is what [`src/akamai/comcast.ts`](src/akamai/comcast.ts) does and
is not reachable over MCP. Treat `akamai_solve` as working for targets the
solver can fetch itself, and drop to the browser bridge when it is not.

## proxies

Clearance cookies are bound to the IP that earned them. Two things follow:

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
    --script=src/akamai/comcast --headless --iterations=200 --concurrency=20
```

| flag | default | description |
|---|---|---|
| `--script` | `src/akamai/ca-edd` | script to run, as a path relative to the project root |
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
