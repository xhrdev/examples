"""A one-request-at-a-time HTTP client that looks exactly like Chrome.

This is a helper process, not a script. `src/mitm.ts` starts it and forwards
every upstream request to it over loopback; it makes the real request with
curl_cffi (curl-impersonate, BoringSSL) and hands the response back as JSON.

## why it exists

`src/mitm.ts` re-originates Lightpanda's traffic because DataDome bans
Lightpanda's own TLS stack on sight. Re-originating with undici moved the
problem rather than solving it: node's TLS bindings expose the cipher list
and the curve order and nothing else, so the hello that went out was
OpenSSL's shape wearing Chrome's ciphers. A JA3/JA4 hash covers the
extension list, their order and the GREASE values too, and node can set none
of them. The same is true one layer up — undici negotiated http/1.1 because
node's HTTP/2 SETTINGS frames are not Chrome's either, and Akamai reads
those.

curl-impersonate is a build of curl against BoringSSL with Chrome's
extensions, in Chrome's order, with Chrome's GREASE and Chrome's HTTP/2
SETTINGS and pseudo-header order. It is not an approximation:

  undici, with Chrome's ciphers   ja4 t13d...  akamai h2 fingerprint: none
  this                            ja4 t13d1516h2_8daaf6152771_806a8c22fdea
                                  akamai 1:65536;2:0;4:6291456;6:262144|
                                         15663105|0|m,a,s,p

which is Chrome's, both of them.

## the protocol

One endpoint. `POST /request` with

  {"url", "method", "headers": [[name, value], ...], "bodyBase64",
   "proxy", "impersonate", "timeoutMs"}

and back comes

  {"status", "headers": [[name, value], ...], "bodyBase64"}

or `{"error"}` with a 502. Headers go both ways as ordered pairs rather than
an object because order is part of the fingerprint on the way out and
`set-cookie` legitimately repeats on the way back.

`GET /hc` answers `{"ok": true, "impersonate": [...]}` — the targets this
build supports, which is how `src/mitm.ts` picks one without hard-coding a
Chrome version on the node side.

Redirects are never followed: the browser owns navigation. No cookie jar is
kept either — the browser owns cookies, and a jar here would replay them
alongside the `cookie` header it was handed.
"""

import argparse
import base64
import json
import queue
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
  from curl_cffi import requests as curl_requests
except ImportError as error:  # pragma: no cover - reported to the caller
  print(
    json.dumps({'error': f'curl_cffi is not installed: {error}'}),
    flush=True,
  )
  raise SystemExit(1) from error

# Sessions are pooled rather than made per request so connections are reused:
# a fresh handshake on every request is slow, and against a bot manager a
# client that never keeps a connection alive is itself a signal. The cap is
# not about memory — each session owns a curl handle that is not safe to use
# from two threads at once, so checkout is what makes concurrency safe.
POOL_SIZE = 16
# Long enough to cover a slow challenge document; `src/mitm.ts` sends its own
# deadline and this is only the fallback.
DEFAULT_TIMEOUT_S = 30.0


def _impersonate_targets():
  """The browser builds this curl-impersonate supports, newest last."""
  literal = curl_requests.impersonate.BrowserTypeLiteral
  return list(literal.__args__)


class _SessionPool:
  """A fixed set of curl_cffi sessions, handed out one thread at a time."""

  def __init__(self, size):
    self._free = queue.LifoQueue()
    self._made = 0
    self._lock = threading.Lock()
    self._size = size

  def acquire(self):
    try:
      return self._free.get_nowait()
    except queue.Empty:
      pass
    with self._lock:
      if self._made < self._size:
        self._made += 1
        return curl_requests.Session()
    # Every session is busy: wait for one rather than opening an unbounded
    # number of them.
    return self._free.get()

  def release(self, session):
    # The browser owns the cookie jar. curl_cffi accumulates `set-cookie`
    # into the session and would replay it next to the `cookie` header
    # `src/mitm.ts` forwards, which is how a stale pre-solve cookie ends up
    # beating the clearance one.
    try:
      session.cookies.clear()
    except Exception:
      pass
    self._free.put(session)

  def close(self):
    while True:
      try:
        self._free.get_nowait().close()
      except queue.Empty:
        return
      except Exception:
        pass


POOL = _SessionPool(POOL_SIZE)


def _perform(payload):
  """Make one request and describe the response."""
  headers = [(str(name), str(value)) for name, value in payload['headers']]
  body = payload.get('bodyBase64')
  proxy = payload.get('proxy')
  timeout = float(payload.get('timeoutMs') or 0) / 1000 or DEFAULT_TIMEOUT_S

  session = POOL.acquire()
  try:
    response = session.request(
      payload.get('method', 'GET'),
      payload['url'],
      # Ordered pairs, not a dict: curl_cffi writes the headers in the order
      # it is given them, and that order is fingerprinted. `default_headers`
      # off because `src/mitm.ts` has already assembled the full Chrome set —
      # letting curl-impersonate add its own would duplicate them and put its
      # own Chrome version in the user agent.
      headers=headers,
      default_headers=False,
      **({'data': base64.b64decode(body)} if body else {}),
      impersonate=payload.get('impersonate') or 'chrome',
      allow_redirects=False,
      proxies={'http': proxy, 'https': proxy} if proxy else None,
      timeout=timeout,
      stream=False,
    )
    return {
      # `multi_items` and not a dict: `set-cookie` repeats, and folding it
      # into one comma-joined value corrupts every `Expires` date in it.
      'headers': [[name, value] for name, value in response.headers.multi_items()],
      'bodyBase64': base64.b64encode(response.content or b'').decode('ascii'),
      'status': response.status_code,
    }
  finally:
    POOL.release(session)


class Handler(BaseHTTPRequestHandler):
  protocol_version = 'HTTP/1.1'

  def log_message(self, *_args):
    """Silence the default stderr access log; the node side does the logging."""

  def _reply(self, status, payload):
    encoded = json.dumps(payload).encode('utf-8')
    self.send_response(status)
    self.send_header('content-type', 'application/json')
    self.send_header('content-length', str(len(encoded)))
    self.end_headers()
    self.wfile.write(encoded)

  def do_GET(self):
    if self.path != '/hc':
      self._reply(404, {'error': 'not found'})
      return
    self._reply(200, {'impersonate': _impersonate_targets(), 'ok': True})

  def do_POST(self):
    if self.path != '/request':
      self._reply(404, {'error': 'not found'})
      return
    length = int(self.headers.get('content-length') or 0)
    try:
      payload = json.loads(self.rfile.read(length) or b'{}')
    except ValueError as error:
      self._reply(400, {'error': f'malformed request: {error}'})
      return
    try:
      self._reply(200, _perform(payload))
    except Exception as error:
      # 502 is the honest answer and it is what `src/mitm.ts` turns into a
      # failed request in the browser, rather than a hang.
      self._reply(502, {'error': f'{type(error).__name__}: {error}'})


def main():
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument('--port', type=int, default=0)
  parser.add_argument('--host', default='127.0.0.1')
  args = parser.parse_args()

  server = ThreadingHTTPServer((args.host, args.port), Handler)
  server.daemon_threads = True
  # The port the caller has to know. Printed as one JSON line on stdout
  # before anything is served, which is what `src/mitm.ts` waits for — a
  # health-check poll would work too and would be slower on every start.
  print(
    json.dumps(
      {
        'impersonate': _impersonate_targets(),
        'port': server.server_address[1],
      }
    ),
    flush=True,
  )
  try:
    server.serve_forever()
  except KeyboardInterrupt:
    pass
  finally:
    POOL.close()
    server.server_close()


if __name__ == '__main__':
  sys.exit(main())
