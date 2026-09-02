# Akamai SBSD

SBSD is Akamai's second scoring channel. A property that uses it serves a
bundle script, and that bundle POSTs its own bodies back to the path it was
served from — separately from, and in addition to, the `_abck` sensor the
[`sensor/`](../sensor/README.md) examples solve. Where that path is varies by
property; see [finding the bundle](#finding-the-bundle).

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

You do not send anything new. The page already POSTs to the bundle's own path;
the integration intercepts those requests and swaps the body for the next row
of the ledger. Ordering is FIFO and is not negotiable.

## finding the bundle

`/.well-known/sbsd` is one convention, not the rule. The common alternative is
an obfuscated per-property path sitting right next to the `_abck` sensor script
under the same random prefix, with nothing in either path naming the channel:

```
hilton.com     /78jHEHB-.../6LncB                          sensor
               /.well-known/sbsd/953343??v=<uuid>          bundle

aa.com         /bJ21n/.../fQUZPAE/Q01H/JFVIT0YB            sensor
               /bJ21n/.../K0ciPAE/NQdp/VyRmPU8Y?v=<uuid>   bundle

aircanada.com  /OfdcKMrdr/.../AHckAWsB/Cz/dXI1ASFTwB       sensor
               /OfdcKMrdr/.../MWEsAWsB/Az/hjXWlQUFQY?v=…   bundle
```

`solver.ts` discovers it rather than being told: what identifies the bundle,
wherever it lives, is the **UUID `v=`** on its `src`. That value seeds the
bundle's codec rather than versioning a file, so an ordinary `?v=3.5.6`
cache-buster — and every site ships dozens — does not look like it. Carrier
POSTs then go to the same pathname, with a different query or none. Pass
`sbsdPath` to `attach()` if you meet a property that hides it better.

Two things this changes about how you survey a target:

- **`bm_s`, `bm_so`, `bm_sc` and `bm_lso` in the jar mean SBSD is running**,
  even if you never saw a `/.well-known/sbsd` request. All three properties
  above set them; only one of the three uses the conventional path.
- **A site that looks unprotected at its apex may not be.**
  `www.aircanada.com/` is a region chooser and serves to anyone;
  `/ca/en/aco/home.html` behind it is challenged.

And one that runs the channel without challenging: `store.playstation.com`
serves an SBSD bundle from an obfuscated path and sets `bm_s`, but its public
store pages render for an ordinary browser. There is no example for it because
there is nothing to assert — a run there passes with or without a solver.

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

`attach()` takes two more options, both for the awkward cases:

| option | what it does |
|---|---|
| `sbsdPath` | pin the bundle's pathname instead of discovering it |
| `sensor` | `'solver'` (default) captures the `_abck` script and stubs it out, waiting for `solveAbck()`. `'page'` leaves it alone and lets the page answer `_abck` itself — use it when SBSD is the only channel you need answered. |

`sensor: 'page'` is worth knowing about: the default *replaces* the sensor
script, so a page that was solving `_abck` on its own stops doing so the moment
you attach. If you only came for SBSD, say so.

## examples

| file | what it shows | status |
|---|---|---|
| `hilton.ts` | both channels on one page, then a real hotel search behind the challenge | solves end to end |
| `aa.ts` | the bundle on an obfuscated path, discovered rather than configured | solves end to end |
| `aircanada.ts` | SBSD only, on a property that does not gate on `_abck` | solves end to end |

```bash
npm run hilton
npm run aa
npm run aircanada
```

### the two channels are scored separately, and it shows

These three targets disagree about what the sensor is for, which is the most
useful thing about having them side by side:

| | gates on `_abck`? | what the example does |
|---|---|---|
| hilton.com | yes | solves both |
| aa.com | yes — the URL is "Access Denied" without it | solves both |
| aircanada.com | **no** | answers SBSD, `sensor: 'page'` |

aircanada serves its booking page to an ordinary Chrome carrying `_abck=~-1~`,
and it keeps serving it: 35 rounds of solving the sensor moved neither the
cookie nor the page. There is nothing wrong there — that property is not
scoring on that channel at that URL, and `~-1~` is its steady state, not a
stuck solve. Check what a plain browser gets before deciding a target needs the
sensor lane; on a page like that, the default `sensor: 'solver'` replaces a
script that was doing no harm and waits for an acceptance that is not coming.

### headed, and behind a proxy

Two things about this target are not the solver's doing and cannot be worked
around from the client side.

**There is no `--headless` that works.** hilton.com refuses a headless Chrome
however good the payloads are: the same run that reaches `~0~` on round 5
headed sits at `~-1~` past round 30 headless. That is also why this example is
**not in the CI smoke suite** — the runner has no display, and an example that
can only ever be advisory is worse than an absent one. `sensor/comcast.ts` is
the Akamai example CI gates on.

**It is sensitive to the address you leave from**, and the sensitivity is
cumulative. Not to whether you use a proxy — `proxy=` is optional here as
everywhere in this repo — but to how much that address has already been used.
Measured over one afternoon from a single desktop address: direct runs went
2/4, and after another handful of runs from the same address, 0/2. Through an
ISP proxy across the same window, 4/4. Nothing about the payloads changed.

So if it starts failing where it used to pass, suspect the exit before the
solve. A fresh address is the cheapest fix; a residential or ISP proxy is the
durable one, and a datacenter pool is not a substitute for either.

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

- **One ledger per document, not per page.** The bootstrap reloads itself, and
  the document that replaces it is a new snapshot: its own HTML, cookies,
  timings and readings. `solver.ts` retires the ledger on every main-frame
  document and lets the next carrier ask for a fresh one. Carrying rows across
  the reload describes a visitor who was on neither document.
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
- **422 `invalid-carrier` with no speech voices** — the single biggest
  environment trap, and the reason these examples need a real desktop.
  `speechSynthesis.getVoices()` is empty on a headless runner, and a snapshot
  claiming a desktop Chrome with no voices describes a browser that cannot
  exist. It reproduces exactly: stub `getVoices` to return `[]` on a machine
  that works, and the very next ledger request is refused.

  A CI runner cannot be talked into having them. On a GitHub runner, installing
  `speech-dispatcher`, replacing the confined snap browser with an unconfined
  Chrome, and giving the daemon a D-Bus session were each tried, and the count
  stayed at zero through all three. So the examples check up front and exit
  `NO_VOICES_EXIT_CODE` (5), which the smoke suite reports as SKIP rather than
  as a failed solve — see [`environment.ts`](environment.ts).

  What they do **not** do is send the counts a desktop would have had.
  Inventing a reading the page cannot back up is the identity mismatch this
  channel exists to punish, and it would trade a loud environment problem for
  a silent `~-1~` somewhere else.
- **422 `invalid-carrier` on a fast machine** — same code, different cause: the
  snapshot beat one of the asynchronous readings. Voices are empty for the
  first few hundred milliseconds of any page, and `ak_bm_tab_id` appears only
  once the bundle has run. `solver.ts` waits for both, bounded.
- **422 with any refusal code** — read the `receipt` in the body, not
  `error.message`: the message is the same sentence for every code, while the
  receipt names the input that could not be reconciled. `solver.ts` puts it in
  the thrown error for that reason.
