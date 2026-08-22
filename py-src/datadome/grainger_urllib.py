"""Run with:

python3 py-src/datadome/grainger_urllib.py
python3 py-src/datadome/grainger_urllib.py --url=https://www.idealista.com/

DataDome clearance cookies for grainger.com with **nothing but the
standard library** — no browser, and no third-party HTTP client. Same four
requests as grainger_requests.py; see that file for the flow.

`urllib.request` tunnels HTTPS through a proxy via `ProxyHandler`, and
takes the credentials straight from the proxy URL. Build one opener for
the proxied traffic and a second, proxy-less one for the call to your own
solver: unlike requests and httpx, there is no per-request escape hatch,
so the separation has to be in which opener you call.

There is no cookie jar here by choice — the flow only ever needs one
cookie, and passing it explicitly is clearer than wiring up
`http.cookiejar` to see it. If you want the jar, `HTTPCookieProcessor`
slots into `build_opener` alongside the `ProxyHandler`.
"""

import json
import os
import sys
import urllib.error
import urllib.request

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datadome.http_utils import (  # noqa: E402
  TIMEOUT_S,
  challenge_document_url,
  check_rate_limit,
  check_prepared_submission,
  document_headers,
  log,
  navigation_headers,
  page_title,
  parse_block_page,
  read_clearance_cookie,
  run,
  solve_endpoint,
  solve_request_body,
  submission_headers,
)


def _is_early_close(error):
  """True when a URLError is the server answering before we finished sending."""
  reason = getattr(error, 'reason', error)
  if isinstance(reason, (BrokenPipeError, ConnectionResetError)):
    return True
  return any(
    marker in str(reason).lower()
    for marker in ('broken pipe', 'connection reset', 'errno 32', 'errno 54')
  )


def _probe_status(opener, url, headers):
  """Re-ask without a body, purely to learn the status we never got to read."""
  probe = urllib.request.Request(url, headers=headers, method='GET')
  try:
    with opener.open(probe, timeout=TIMEOUT_S) as response:
      return response.status, response.read().decode('utf-8', 'replace'), dict(
        response.headers.items()
      )
  except urllib.error.HTTPError as error:
    body = error.read().decode('utf-8', 'replace')
    return error.code, body, dict(error.headers.items())


def _send(opener, url, headers, data=None, method=None):
  """Return (status, body, headers). A 403 is an answer here, not an error.

  The response headers come back too because a 429 carries `Retry-After`, and
  that is the one thing worth telling the caller when the solver rate limits
  us.
  """
  request = urllib.request.Request(
    url, data=data, headers=headers, method=method
  )
  try:
    with opener.open(request, timeout=TIMEOUT_S) as response:
      body = response.read().decode('utf-8', 'replace')
      return response.status, body, dict(response.headers.items())
  except urllib.error.HTTPError as error:
    # DataDome answers the block with 403; we want to read that body.
    body = error.read().decode('utf-8', 'replace')
    return error.code, body, dict(error.headers.items())
  except urllib.error.URLError as error:
    # A rejected POST can surface as a broken pipe rather than a status:
    # the server answers and closes while urllib is still writing the body,
    # so urllib never gets to read the response it already sent. That is
    # exactly what a 429 on a large /dd/solve body looks like here, and
    # reporting it as a transport error would hide the rate limit. urllib is
    # the only client in this repo with the problem -- requests, httpx and
    # undici all read the early response.
    if data is None or not _is_early_close(error):
      raise
    return _probe_status(opener, url, headers)


def attempt(proxy, api_key, solver_url, target_url):
  # An empty ProxyHandler means "no proxy", which is how the solver call
  # stays on your own network.
  direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
  # Credentials ride along in the proxy URL; urllib turns them into the
  # Proxy-Authorization header on the CONNECT. With no proxy configured
  # the target traffic uses the same direct opener as the solver call.
  proxied = (
    urllib.request.build_opener(
      urllib.request.ProxyHandler({'http': proxy, 'https': proxy})
    )
    if proxy
    else direct
  )

  # 1. Trip the challenge.
  log(f'GET {target_url}')
  status, blocked_html, _headers = _send(proxied, target_url, navigation_headers())
  log(f'  <- HTTP {status} ({len(blocked_html)} bytes)')

  dd = parse_block_page(blocked_html)
  if dd is None:
    log('  no DataDome challenge — the request went straight through')
    return None
  kind = 'captcha' if dd['rt'] == 'c' else 'interstitial'
  log(f'  challenge: {kind} cid={dd["cid"]}')

  # 2. Fetch the challenge document the solver needs to read.
  document_url = challenge_document_url(dd, target_url)
  log('GET challenge document')
  status, document_html, _headers = _send(
    proxied, document_url, document_headers(target_url)
  )
  log(f'  <- HTTP {status} ({len(document_html)} bytes)')

  # 3. Ask xhr.dev to build the submission — but not to send it.
  log('POST /dd/solve')
  headers = {'content-type': 'application/json'}
  if api_key:
    headers['x-api-key'] = api_key
  body = solve_request_body(
    dd, document_html, document_url, proxy, target_url
  )
  status, solve_body, _headers = _send(
    direct,
    solve_endpoint(solver_url),
    headers,
    data=json.dumps(body).encode('utf-8'),
    method='POST',
  )
  check_rate_limit(status, _headers)
  if status != 200:
    raise RuntimeError(f'solver returned HTTP {status}: {solve_body[:300]}')
  prepared = check_prepared_submission(json.loads(solve_body))
  log('  <- prepared submission')

  # 4. Submit it ourselves, over the same proxy session. Captcha solves
  #    carry their payload in the query string (GET); interstitials post.
  payload = prepared.get('body')
  method = 'POST' if payload else 'GET'
  log(f'{method} submission')
  status, submitted, _headers = _send(
    proxied,
    prepared['url'],
    submission_headers(prepared),
    data=payload.encode('utf-8') if payload else None,
    method=method,
  )
  cookie = read_clearance_cookie(submitted)
  log(f'  <- HTTP {status}')
  log(f'clearance cookie: datadome={cookie}')

  # Prove it: the request that 403'd should now return the real page.
  log('verifying against the target')
  verify_headers = navigation_headers()
  verify_headers['cookie'] = f'datadome={cookie}'
  status, html, _headers = _send(proxied, target_url, verify_headers)
  log(f'  <- HTTP {status} ({len(html)} bytes) "{page_title(html)}"')

  return cookie, status


if __name__ == '__main__':
  load_dotenv()
  run(attempt)
