# examples

[![release](https://github.com/xhrdev/examples/actions/workflows/release.yml/badge.svg)](https://github.com/xhrdev/examples/actions/workflows/release.yml)
[![CLA assistant](https://cla-assistant.io/readme/badge/xhrdev/examples)](https://cla-assistant.io/xhrdev/examples)

## intro

xhr.dev is a magic proxy that allows you to bypass bot defences. this can be
used to access internal APIs of websites that are normally protected by bot
defences.

this is an open source repo of hitting some of those sites, normally protected
by bot defences, but successfully accessed using xhr.dev.

use whatever http client you'd like - `curl`, `fetch`, `playwright`, etc.

```node
const supportedHttpClients = [
  'curl',
  'fetch',
  'axios',
  'python requests',
  'playwright',
  ...etc,
]
```

## quickstart

add variables to the `.env` file (`.env.example` for reference), replace with
your api key

install the dependencies: `npm ci` + `npx playwright install` + (if using
python) `python3 -m venv venv` + `pip install -r requirements.txt`

download the xhr.dev certificate:

```bash
curl -s https://docs.xhr.dev/xhrdev.pem -o xhrdev.pem
```

run the relevant script:

```bash
npx tsx src/apollo/auth.ts || npm run tsx src/apollo/auth.ts
```

or:
```bash
npx tsx src/playwright.ts || npm run playwright
```

## hot reload

add the relevant file to run in `dev-resources/watch-file`

`dev-resources/watch-file`

```typescript
...

file="src/apollo/auth.ts"

...
```

then run:

```bash
$ dev-resources/watch-file
```

## sites

[x] apollo
[ ] walmart
[ ] doordash

### apollo

example run:

```bash
npm run tsx src/apollo/auth


> @xhrdev/examples@0.0.1 tsx
> tsx src/apollo/auth.ts
{
  cookies: '[{"key":"GCLB","value":"CLHD5Jvhl_-_bRAD","expires":1735200986,"domain":"app.apollo.io","path":"/","httpOnly":true,"hostOnly":true,"creation":"2024-12-26T08:06:27.696Z","lastAccessed":"2024-12-26T08:06:28.822Z","name":"GCLB"}, ...]',
  csrf: 'Wy_LtdInp2ShCkMjJlbaT992AuZFzjx18fZFTdAEhp0mF2hBre-HH_oOzUG45iEVwAdz1EbcznFRYy1tc61fIg'
}

@Mac:examples $
```
