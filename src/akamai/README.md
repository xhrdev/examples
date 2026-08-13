# Akamai Bot Manager

Akamai scores every request. The score lives in an `_abck` cookie, and it is
raised by running Akamai's obfuscated sensor script and POSTing the telemetry
it produces. Do that convincingly and the cookie flips to accepted; do it badly
and you stay blocked no matter how many times you retry.

- API reference: <https://docs.xhr.dev/api-akamai.html>

## reading `_abck`

The cookie value ends in a segment that tells you where you stand:

| value | meaning |
|---|---|
| `~-1~` | not accepted — keep sending sensors |
| `~0~` | **accepted** — you are through |

The examples log this on every round, which makes a run easy to follow:

```
[https://login.xfinity.com] Cookie update: round=5 rval=-1 accepted=false _abck=~-1~
[https://login.xfinity.com] Cookie update: round=6 rval=0  accepted=true  _abck=~0~
[https://login.xfinity.com] Cookie accepted (round 6)
```

Acceptance normally takes several rounds. Rounds 1–5 ending in `~-1~` are the
protocol working as intended, not a failure.

## the WebSocket session

Akamai integration is stateful, so it runs over a socket rather than a single
POST:

```
ws://<host>:3000/akamai/session
```

The exchange:

| direction | message | contents |
|---|---|---|
| → | `init` | page URL, the sensor script and its URL, the page HTML, current cookies, profile id |
| ← | `submission` | a request to make: method, URL, body, headers |
| → | `submission_response` | the status, body, and cookies your browser got back |
| ← | `cookie_update` | the new `_abck`, the round number, `rval`, `accepted` |
| ← | `status` | `running`, then `accepted` |

The solver computes the sensor payloads; **your browser sends them**. That is
the point of the design — the submissions travel on the real connection, with
its real TLS fingerprint and cookie jar, so they look like what they claim to
be. The socket idles out after 5 minutes, and each `submission` expects a
response within 30 seconds.

## using the client

`solver.ts` exports one function:

```typescript
import { solve } from '#src/akamai/solver.js';

const solverUrl = `ws://${process.env['host']}:3000/akamai/session`;
await solve(page, { proxy, solverApiKey, solverUrl, url });
// resolves when _abck is accepted; rejects on timeout (default 120s)
```

`solverApiKey` is sent as `x-api-key` on the upgrade request. If your solver
sits behind an API-key gate you need it here — a gate matches the header on
the WebSocket upgrade like any other request, so leaving it out fails the
handshake with a 401 rather than anything that looks Akamai-related.

Note the `ws://` scheme and the `/akamai/session` path — unlike the DataDome
client, this one takes the full socket URL, not a base URL.

Given a Playwright page, `solve` intercepts the Akamai script, opens a session
**per origin**, and relays submissions until the cookie is accepted. Per-origin
matters: a login flow that spans `business.comcast.com` and
`login.xfinity.com` runs two sessions at once, each with its own rounds. Only
the origin you actually need has to reach `~0~`.

## examples

| file | what it shows |
|---|---|
| `comcast.ts` | solving across two origins during an OAuth redirect chain, up to the login form |
| `ca-edd.ts` | the same, then an actual login — needs `username=` and `password=` in `.env` |
| `comcast-lightpanda.ts` | the same target driven by **Lightpanda** instead of Chrome — see below |

```bash
npm run comcast
node --env-file=.env src/akamai/comcast.ts --headless
npm run ca-edd
```

Drop `--headless` to watch it happen.

### lightpanda

`comcast-lightpanda.ts` runs the same solve on [Lightpanda], a headless browser
with no renderer — a ~70MB binary that starts in milliseconds. `solve()` needs
no CDP session, so it drives a Lightpanda page unchanged:

```bash
curl -Lo lightpanda https://github.com/lightpanda-io/browser/releases/latest/download/lightpanda-aarch64-macos
chmod +x lightpanda
LIGHTPANDA_PATH=./lightpanda npm run comcast:lightpanda
```

It solves. `_abck` reaches `~0~` on round 5 — the same round Chrome takes:

```
[https://login.xfinity.com] Cookie update: round=5 rval=0 accepted=true _abck=~0~
[https://login.xfinity.com] Cookie accepted (round 5)
RESULT: SUCCESS - Akamai solved, reached /login
```

Four things had to be true, and each failed silently in a way that looked like
something else:

- **The connection is re-originated.** `src/lightpanda.ts` runs the browser
  behind `src/mitm.ts`, a local proxy that terminates TLS and re-makes each
  request with undici. That is also the only place the identity can be set:
  Lightpanda's user agent cannot be changed from inside the browser, and
  `context.newCDPSession()` — how `comcast.ts` overrides it — crashes
  Playwright here.
- **The identity has to be the profile the solver was told about**, not the
  proxy's DataDome default. Telemetry claiming Chrome 146 under headers
  claiming 149 is a mismatch, and `_abck` stays at `~-1~` however long you run.
- **`fetchResponse` replaces `route.fetch`.** Playwright's route.fetch never
  returns against Lightpanda — it runs in Playwright's request context, which
  syncs cookies with the browser, and once that stops answering every later
  route.fetch waits out its timeout, sensor script included. The MITM fetches
  it instead, from the same address with the same headers.
- **Cookies are applied by hand on that path.** `route.fulfill` carries one
  `set-cookie` header and Akamai's document response sets four; lose `_abck`
  and the session opens without the cookie the protocol advances. Akamai then
  returns the *same* `_abck` to every submission and the rounds count up
  forever. This is why each session now logs `cookies=[...]` by name: compare
  it with a Chrome run and the missing one is right there.

Two more that look like bugs and are not, both handled for you:

- **`Target page, context or browser has been closed`, on everything at once.**
  Lightpanda caps CDP messages at 1MB by default and drops the connection
  rather than rejecting an oversized one. Playwright fulfills an intercepted
  request by sending the whole body back over CDP, base64'd, so a single 1MB
  analytics bundle ends the session. `start()` passes
  `--cdp-max-message-size 32MB`.
- **`page.goto` and `waitForLoadState` timing out.** The solver's 30s/15s
  defaults are not enough for a script-heavy page under interception; they are
  now the `navigationTimeout` and `loadStateTimeout` options.

`_abck` only has to reach `~0~` on the origin you actually need — here
login.xfinity.com. business.comcast.com stays at `~-1~` in a Chrome run too.

[Lightpanda]: https://lightpanda.io

## gotchas

- **`Resulting promise was garbage collected`** — a frame navigated out from
  under an in-flight submission. Harmless when another origin still reaches
  `~0~`; the examples log it and carry on.
- **Stuck at `~-1~` forever** — usually the identity, not the solver. The
  profile has to match the browser actually making the requests.
- **`sbsd`** — some properties use Akamai's SBSD challenge instead of the
  classic sensor. `/akamai/solve` takes `mode: "abck" | "sbsd"` and
  auto-detects when you omit it.
- **500 with `queue_full` or `queue_wait_timeout`** — the container is
  saturated. It runs 8 concurrent solves with a queue depth of 32 by default;
  `GET /akamai/queue-metrics` shows live numbers before you scale up.
