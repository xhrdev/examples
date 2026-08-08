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
```

Point `host=` at the machine running the container and check it is up:

```bash
curl http://$host:3000/hc
# {"status":"ok"}
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
POST /dd/solve?submit=false
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
| [`src/datadome/grainger-http.ts`](src/datadome/grainger-http.ts) | DataDome | captcha / interstitial | no |
| [`src/datadome/grainger.ts`](src/datadome/grainger.ts) | DataDome | captcha / interstitial | yes |
| [`src/datadome/idealista.ts`](src/datadome/idealista.ts) | DataDome | interstitial → captcha | yes |
| [`src/akamai/comcast.ts`](src/akamai/comcast.ts) | Akamai Bot Manager | `_abck` sensor | yes |
| [`src/akamai/ca-edd.ts`](src/akamai/ca-edd.ts) | Akamai Bot Manager | `_abck` sensor + login | yes |

Each vendor directory has its own README with the protocol details:
[**src/akamai**](src/akamai/README.md) · [**src/datadome**](src/datadome/README.md)

Run any of them directly, or use the npm aliases:

```bash
npm run grainger              # DataDome, no browser
npm run grainger:browser      # DataDome, via Playwright
npm run idealista
npm run comcast
npm run ca-edd                # needs username= and password=

# any script takes flags after --
node --env-file=.env src/datadome/grainger-http.ts --url=https://www.idealista.com/
node --env-file=.env src/datadome/idealista.ts --headless
```

## two ways to integrate

**Plain HTTP.** You already have an HTTP scraper and just want a cookie.
Fetch the challenge, POST it to the solver, submit the result. No Chromium
anywhere. This is `grainger-http.ts`, and it is the cheapest option by a wide
margin — a solve costs four requests and a few hundred milliseconds.

**Browser bridge.** The site needs a real browser anyway (a login flow, a
JS-rendered page), or the challenge wants a genuine browser context. The
solver computes the sensor payloads and your Chrome submits them, so the
requests carry real TLS fingerprints and a real cookie jar. This is
`grainger.ts`, `idealista.ts`, and both Akamai examples.

Start with plain HTTP. Reach for the browser bridge when the site forces you to.

## proxies

Clearance cookies are bound to the IP that earned them. Two things follow:

1. **Pin a session.** If your proxy pool rotates mid-flow, the cookie you get
   back is already void. The examples pin automatically for oxylabs
   (`-sessid-`) and rayobyte (`-hardsession-`); for other providers, make sure
   the pool holds an IP for the duration.
2. **Submit from your own IP.** `/dd/solve` defaults to `submit=true`, where
   the solver sends the payload itself — which binds the cookie to the
   *solver's* IP. Pass `?submit=false` and make the final request yourself.
   The examples all do this.

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
| a fresh 403 right after a successful solve | the cookie was earned on a different IP — check session pinning, and that you used `submit=false` |
| `RESULT: FAIL - proxy session failed` | dead exit node. The examples retry three times; raise it with `--attempts=5` |
| solver returns 400 | the profile and the headers you send disagree. Change both together, never one alone |
| solver returns 500 with `queue_full` | the container is saturated; check `GET /akamai/queue-metrics` |

## hot reload

Point `dev-resources/watch-file` at the script you are working on and run it:

```bash
dev-resources/watch-file
```

## contributing

Adding a site is welcome — copy the closest existing example, keep the
`RESULT: SUCCESS` / `RESULT: FAIL` convention, and make sure `make ci` passes.
Contributions are covered by the [CLA](CLA.md).
