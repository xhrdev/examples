# Akamai Bot Manager

Akamai scores every request, and it does so on **two independent channels**.
Which ones a property runs is a per-property choice, so the examples are split
the same way the channels are:

| directory | channel | what it is |
|---|---|---|
| [`sensor/`](sensor/README.md) | `_abck` | the classic obfuscated sensor script, solved over a stateful WebSocket session |
| [`sbsd/`](sbsd/README.md) | SBSD | a bundle served from `/.well-known/sbsd`, answered with a one-shot ledger of bodies |

- API reference: <https://docs.xhr.dev/api-akamai.html>

## which one do I need?

Look at the page, not at the docs. A property that serves a script from
`/.well-known/sbsd` runs the SBSD channel; one whose HTML carries a long
random-looking script path (`/78jHEHB-.../6LncB`) runs the `_abck` sensor.
Plenty of properties run both — hilton.com does, which is why
[`sbsd/hilton.ts`](sbsd/hilton.ts) solves both and
[`sbsd/solver.ts`](sbsd/solver.ts) is the library that handles the pair.

If you are only shown `_abck`, start from [`sensor/`](sensor/README.md): it is
the simpler integration and it is what most targets need.

## what the two have in common

Both are **browser bridges**. The solver computes the payloads; your browser
sends them, so every request travels on the real connection with its real TLS
fingerprint and the page's own cookie jar. Neither one fetches the target
server-side on your behalf.

Both also depend on the identity in [`src/profile.ts`](../profile.ts) being the
identity the browser actually presents. That is the single most common cause of
a solve that never lands: nothing errors, the rounds simply count up forever.
[`identity.ts`](identity.ts) installs the profile on a real Chrome over CDP,
and both lanes declare the same profile to the solver.

## a note on the other integration styles

The `_abck` sensor lane runs anywhere a browser does, Lightpanda included, and
DataDome has HTTP-client and Python flows besides. SBSD has neither, because it
rewrites a POST the page itself makes rather than sending one — see
[`sbsd/README.md`](sbsd/README.md#why-there-is-no-http-python-or-lightpanda-variant).

## shared pieces

| file | what it does |
|---|---|
| [`identity.ts`](identity.ts) | installs the profile on a live Chrome — user agent, client hints, device metrics |
| [`../profile.ts`](../profile.ts) | the one place the claimed Chrome identity is written down |
| [`../solver-url.ts`](../solver-url.ts) | turns `host=` from `.env` into an HTTP or WebSocket solver URL |
| [`../rate-limit.ts`](../rate-limit.ts) | what to do when the solver answers 429 (stop — it is not retryable) |

## gotchas that apply to both

- **Stuck at `~-1~` forever** — usually the identity, not the solver. The
  profile has to match the browser actually making the requests. See
  `sbsd/README.md` for a worked example of how subtle this gets.
- **500 with `queue_full` or `queue_wait_timeout`** — the container is
  saturated. It runs 8 concurrent solves with a queue depth of 32 by default;
  `GET /akamai/queue-metrics` shows live numbers before you scale up.
- **401 on the WebSocket upgrade** — the API-key gate matched the upgrade
  request like any other. Pass `solverApiKey`; it goes out as `x-api-key`.
