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


def _send(opener, url, headers, data=None, method=None):
  """Return (status, body). A 403 is an answer here, not an error."""
  request = urllib.request.Request(
    url, data=data, headers=headers, method=method
  )
  try:
    with opener.open(request, timeout=TIMEOUT_S) as response:
      return response.status, response.read().decode('utf-8', 'replace')
  except urllib.error.HTTPError as error:
    # DataDome answers the block with 403; we want to read that body.
    return error.code, error.read().decode('utf-8', 'replace')


def attempt(proxy, solver_api_key, solver_url, target_url):
  # Credentials ride along in the proxy URL; urllib turns them into the
  # Proxy-Authorization header on the CONNECT.
  proxied = urllib.request.build_opener(
    urllib.request.ProxyHandler({'http': proxy, 'https': proxy})
  )
  # An empty ProxyHandler means "no proxy", which is how the solver call
  # stays on your own network.
  direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))

  # 1. Trip the challenge.
  log(f'GET {target_url}')
  status, blocked_html = _send(proxied, target_url, navigation_headers())
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
  status, document_html = _send(
    proxied, document_url, document_headers(target_url)
  )
  log(f'  <- HTTP {status} ({len(document_html)} bytes)')

  # 3. Ask xhr.dev to build the submission — but not to send it.
  log('POST /dd/solve?submit=false')
  headers = {'content-type': 'application/json'}
  if solver_api_key:
    headers['x-api-key'] = solver_api_key
  body = solve_request_body(
    dd, document_html, document_url, proxy, target_url
  )
  status, solve_body = _send(
    direct,
    solve_endpoint(solver_url),
    headers,
    data=json.dumps(body).encode('utf-8'),
    method='POST',
  )
  if status != 200:
    raise RuntimeError(f'solver returned HTTP {status}: {solve_body[:300]}')
  prepared = check_prepared_submission(json.loads(solve_body))
  log('  <- prepared submission')

  # 4. Submit it ourselves, over the same proxy session. Captcha solves
  #    carry their payload in the query string (GET); interstitials post.
  payload = prepared.get('body')
  method = 'POST' if payload else 'GET'
  log(f'{method} submission')
  status, submitted = _send(
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
  status, html = _send(proxied, target_url, verify_headers)
  log(f'  <- HTTP {status} ({len(html)} bytes) "{page_title(html)}"')

  return cookie, status


if __name__ == '__main__':
  load_dotenv()
  run(attempt)
