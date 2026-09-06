# Playwright with the browser extension

Everything else in this repo drives the solver from Node. The script holds the
session, receives the payloads, and relays them through a page it controls.

This directory inverts that. The
[xhr.dev Autosolver](https://github.com/xhrdev/extension) extension lives
*inside* the browser: it watches for challenges itself and answers them in
whatever tab they appear in. The Playwright script is a bystander — it opens a
page and waits, and the extension does the work underneath it.

```bash
npm run grainger:extension
npm run grainger:extension -- --headless
npm run grainger:extension -- --screenshot
```

## When to reach for this

Use the ordinary examples when you want a **cookie** — something to carry into
an HTTP client, a scraper, another process. `grainger-undici.ts` is faster,
cheaper, and has no browser in it.

Use this when you want a **browsing session that stays cleared**: an operator
driving a real browser, a long-lived session across many pages, or anything
where the challenge can appear somewhere you were not watching. Nothing here
needs to know a challenge is coming.

## Setup

The extension is a separate repository. Clone it next to this one:

```bash
git clone git@github.com:xhrdev/extension.git ../extension
```

Or point at it explicitly, in `.env`:

```
extension_path=/path/to/extension
```

`host=` and `api_key=` are read from `.env` exactly as every other example
reads them.

## Three things about loading an extension that are not obvious

**Chrome 137 removed `--load-extension`.** The switch is ignored — no error, no
extension, no clue. It goes in over CDP with `Extensions.loadUnpacked` and
`--enable-unsafe-extension-debugging` instead.

**`Extensions.loadUnpacked` is a browser-level command.** It cannot be sent over
a page session, so it goes over the raw browser WebSocket before Playwright
attaches.

**Playwright's bundled Chromium will not do.** It cannot load an extension
headless at all, and the vendors score it differently: measured against aa.com,
`_abck` never leaves `~-1~` in the bundled build and is accepted within a few
rounds in real Chrome. `CHROME_PATH` overrides the search, or
`npx playwright install chrome`.

## The host is passed through raw

`solverBaseUrl` in this repo resolves a bare host to `http://host:3000`, which
is correct for every Node client here — undici and curl reach it happily. It is
the one form an extension can never use: Chrome rewrites `http://` to `https://`
for public hostnames and does not fall back, so the request dies against a port
with no TLS listener.

So `host=` is handed to the extension unresolved, and the extension applies its
own rule to the shorthand.

## Exit codes

The same ones the rest of the repo uses, so a wrapper script can treat this like
any other target:

| Code | Meaning |
| --- | --- |
| 0 | solved, or the target served the page without a challenge |
| 1 | something broke |
| 2 | the solve was completed and the target still refused it |
| 3 | rate limited — not retryable |
| 4 | the exit IP is banned — not retryable |

"No challenge" exits 0 and says so rather than implying a solve happened. A
target that does not challenge you is a legitimate outcome, and the extension
correctly does nothing.

## Akamai

`grainger.ts` sets no eager origins, because DataDome does not need them: the
challenge arrives as an iframe the extension notices after the fact and answers
on a second load. Akamai is different — its sensor script and SBSD bundle have
to be intercepted on the load that serves them — so an Akamai property has to be
listed to be solvable at all:

```ts
await launchWithExtension({
  host,
  apiKey,
  eagerOrigins: ['www.hilton.com'],
});
```
