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
await solve(page, { proxy, solverUrl, url });
// resolves when _abck is accepted; rejects on timeout (default 120s)
```

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

```bash
npm run comcast
node --env-file=.env src/akamai/comcast.ts --headless
npm run ca-edd
```

Drop `--headless` to watch it happen.

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
