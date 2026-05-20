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
node --env-file=.env src/flarecloud/apollo/auth.ts
```

or:
```bash
NODE_EXTRA_CA_CERTS=./xhrdev.pem node --env-file=.env src/playwright.ts
# or
npm run playwright
```

`npm run playwright` already sets `NODE_EXTRA_CA_CERTS=./xhrdev.pem`, so you do
not need to install the cert system-wide for this flow. You can still install
and trust the cert globally if you prefer.

### hot reload

add the relevant file to run in `dev-resources/watch-file`

`dev-resources/watch-file`

```typescript
...

file="src/flarecloud/apollo/auth.ts"

...
```

then run:

```bash
$ dev-resources/watch-file
```

## load test (docker)

`src/loadtest.ts` runs any script repeatedly with rotating proxy sessions and
reports pass/fail/error rates. The `--script` flag takes a path relative to the
project root (e.g. `src/xperimeter/zillow`, `src/akmi/ca-edd`). The easiest
way to run it at scale is via Docker so Chromium is fully isolated.

```bash
# build
docker build -t examples .

# run — xperimeter/zillow
docker run --rm \
  --name examples \
  --env-file .env \
  examples \
  node --env-file=.env src/loadtest.ts --script=src/xperimeter/zillow --iterations=50 --concurrency=5

# run — akmi/ca-edd (requires username + password)
docker run --rm \
  --name examples \
  --env-file .env \
  examples \
  node --env-file=.env src/loadtest.ts --script=src/akmi/ca-edd --headless --iterations=200 --concurrency=20

# run — akmi/comcast
docker run --rm \
  --name examples \
  --env-file .env \
  examples \
  node --env-file=.env src/loadtest.ts --script=src/akmi/comcast --headless --iterations=200 --concurrency=20
```

### headed mode (watch what it's doing)

omit `--headless` to see the browser (browser-based scripts only):

```bash
docker run --rm \
  --name examples \
  --env-file .env \
  examples \
  node --env-file=.env src/loadtest.ts --script=src/akmi/comcast --iterations=5 --concurrency=1
```

| flag | default | description |
|---|---|---|
| `--script` | `src/akmi/ca-edd` | script to run, as a path relative to project root |
| `--iterations` | `100` | total attempts |
| `--concurrency` | `1` | parallel workers |
| `--headless` | off | pass `--headless` through to the child script |
| `--proxy` | `$proxy` | proxy URL with optional session rotation |
| `--host` | `$host` | host/IP forwarded to child as `host` env var |
| `--quiet` | off | suppress per-attempt output |
