# Akamai SBSD

SBSD is Akamai's second scoring channel. A property that uses it serves a
bundle from `/.well-known/sbsd`, and that bundle POSTs its own bodies back to
the same path — separately from, and in addition to, the `_abck` sensor the
[`sensor/`](../sensor/README.md) examples solve.

- API reference: <https://docs.xhr.dev/api-akamai-sbsd.html>
- The other channel: [`src/akamai/sensor`](../sensor/README.md)

## how it differs from the sensor lane

The sensor lane is a conversation. SBSD is a single request:

| | `_abck` sensor | SBSD |
|---|---|---|
| transport | WebSocket, `/akamai/session` | one POST, `/akamai/sbsd/generate-session` |
| shape | rounds until the cookie is accepted | a ledger of bodies, issued once |
| bound to | the origin | **one document**, for five minutes |
| your job | relay each submission through the browser | rewrite the page's own carrier POSTs |

You do not send anything new. The page already POSTs to `/.well-known/sbsd` on
its own; the integration intercepts those requests and swaps the body for the
next row of the ledger. Ordering is FIFO and is not negotiable.

## the ledger

One POST returns `expectedCap` rows — three, today — for the document that is
live at that moment:

```jsonc
{
  "complete": true,
  "expectedCap": 3,
  "ordering": "sensor-emission-fifo",
  "runNonce": "b6278f3f-8160-4df7-ab42-b2aeb3bce4c6",
  "submissions": [
    { "index": 0, "body": "...", "bytes": 965, "method": "POST", "resolvedUrl": "https://www.hilton.com/.well-known/sbsd" }
  ]
}
```

Three things about it are worth internalising, because each one fails quietly:

- **Rows are capacity, not a promise.** The page emits as many carriers as it
  emits. If it emits four and you have three, that is a hard stop — abort the
  fourth. Letting the native body through hands Akamai a payload from an
  uninstrumented page alongside yours, which is worse than sending nothing.
- **The ledger belongs to one document.** The bodies are computed from a
  snapshot of the live page: its HTML, its cookies, its resource timings, its
  runtime readings. Replaying them against a second document, a second tab or a
  later load is a mismatch. The server will not issue one for a snapshot older
  than five minutes.
- **The first carrier has to be held.** The snapshot reads
  `sessionStorage.ak_bm_tab_id`, which only exists once the bundle has run. So
  the request that triggers generation is also the one that waits for it.

## ordering, on a page that runs both channels

The first document a protected property serves is a small Akamai bootstrap that
reloads itself once its SBSD carrier is answered. The real page — and the
`_abck` sensor script on it — only exists after that. So:

1. install the router **before** the first navigation,
2. let the SBSD lane answer the bootstrap,
3. solve `_abck` against the document you actually wanted.

`attach()` does the first two and hands you `solveAbck()` for the third.

## using the client

`solver.ts` exports one function:

```typescript
import { attach } from '#src/akamai/sbsd/solver.js';

const akamai = attach(page, {
  host: process.env['host'],        // as in .env; http/ws or https/wss both work
  origin: 'https://www.hilton.com', // only this origin is intercepted
  solverApiKey,                     // sent as x-api-key on both the POST and the upgrade
});

await page.goto(url);               // SBSD is answered during this
// ... reach the real document, do whatever you came to do ...
await akamai.solveAbck();           // resolves when _abck reaches ~0~
```

`attach` is synchronous and installs the route handler immediately, which is
the point — an SBSD carrier that fires before the handler exists is a native
payload already on the wire.

On a property that runs **only** SBSD, do not call `solveAbck()`; it rejects,
because no `_abck` sensor script was ever captured.

## examples

| file | what it shows |
|---|---|
| `hilton.ts` | both channels on one page, then a real hotel search behind the challenge |

```bash
npm run hilton
```

It solves, and the check at the end is a results page rather than a cookie
value:

```
[abck] Opening session against https://www.hilton.com/78jHEHB-.../6LncB (_abck=-1)
[sbsd] Ledger issued: cap=3 nonce=b6278f3f-8160-4df7-ab42-b2aeb3bce4c6
[sbsd] Row 0: 965 bytes
[sbsd] Row 1: 1177 bytes
[sbsd] Row 2: 3472 bytes
[abck] Cookie update: round=5 rval=0 accepted=true
RESULT: SUCCESS - Akamai solved, reached "Orlando, Florida, US Hotel Search - Hilton"
```

### headed, and behind a proxy

Two things about this target are not the solver's doing and cannot be worked
around from the client side.

**There is no `--headless` that works.** hilton.com refuses a headless Chrome
however good the payloads are: the same run that reaches `~0~` on round 5
headed sits at `~-1~` past round 30 headless. That is also why this example is
**not in the CI smoke suite** — the runner has no display, and an example that
can only ever be advisory is worse than an absent one. `sensor/comcast.ts` is
the Akamai example CI gates on.

**Set `proxy=` in `.env`.** Going direct works and then stops working: the
address gets a reputation, and once it has one the payloads stop mattering.
Give it the residential or ISP proxy the top-level [README](../../../README.md)
describes. A datacenter pool is not a substitute.

### why there is no HTTP, Python or Lightpanda variant

The other lanes in this repo all have one. SBSD does not, and this is a
property of the channel rather than a gap.

**No HTTP-client or Python flow.** The integration does not send a request of
its own — it rewrites the body of a POST *the page makes*. With no page there
is no carrier to rewrite, and no realm to snapshot: `document.runtime` is a set
of readings that only a live document has.

**No Lightpanda flow.** `document.runtime` requires `performance.memory`,
`navigator.connection` and `speechSynthesis`, and the server rejects the
request if any of them is missing. Lightpanda has none of the three:

```
$ lightpanda> typeof performance.memory, navigator.connection, speechSynthesis
undefined undefined undefined
```

That is not something a client-side shim can fix — inventing the readings is
exactly the mismatch the [identity trap](#the-identity-trap-worked-through)
section is about. If Lightpanda grows them, the same `attach()` should work
unchanged; `sensor/comcast-lightpanda.ts` already shows the `_abck` lane
running there.

## the identity trap, worked through

`solve()` in the sensor lane sends the *declared* profile — the values written
down in [`src/profile.ts`](../../profile.ts). The obvious thing to do for SBSD,
since the ledger request wants a realm snapshot anyway, is to read the identity
off the live page instead. Do not.

`identity.ts` installs the profile with `Emulation.setDeviceMetricsOverride`,
and that leaves the window emulated rather than real:

```
emulated  availLeft: 0   availTop: 0    outerWidth: 1202
real      availLeft: 51  availTop: 33   outerWidth: 1200
profile   availLeft: 0   availTop: 34   outerWidth: 1200
```

On macOS `availTop: 0` is impossible — the menu bar is always there — so a
payload built from the emulated readings describes a browser that cannot exist.
Nothing errors. `_abck` simply never leaves `~-1~`, which is the same symptom as
a dozen unrelated causes.

So `profile.overrides` carries the declared identity, and the live snapshot is
kept to the things only the page can answer: its cookies, its resource timings,
its heap and connection readings, its DOM inventory. The two lanes then declare
the same identity as each other, which is the property that actually matters.

## gotchas

- **Two ledgers for one document** — carriers fire concurrently, so a naive
  `if (!rows) rows = await generate()` lets two of them both start a request.
  The second ledger replaces the first and the cursor walks into it, so the
  page submits row 0 of one snapshot and rows 1–2 of another. Memoize the
  *promise*, not the value; `solver.ts` does.
- **`bundle.scriptSrc` must include the query string.** The `?v=` is not
  decoration — it seeds the bundle's codec. Send the raw `src` attribute.
- **`document.epochMs` is `performance.timeOrigin`**, not `Date.now()`. It
  identifies the document, and one older than five minutes is refused.
- **`document.cookieHeader` is `document.cookie`**, despite the name — the
  JavaScript-visible jar, not the HTTP header. The `httpOnly` cookies are
  deliberately not part of what the page can see.
- **422 with a refusal code** — the sandbox declined to produce a complete
  ledger for that snapshot. The `receipt` in the body says which input it could
  not reconcile; the usual answer is a snapshot taken before the bundle had run.
