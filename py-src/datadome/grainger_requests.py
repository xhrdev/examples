"""Run with:

python3 py-src/datadome/grainger_requests.py
python3 py-src/datadome/grainger_requests.py --url=https://www.idealista.com/

DataDome clearance cookies for grainger.com with **requests** — no browser.

There are three interchangeable Python versions of this example, one per
HTTP client. They make exactly the same four requests; only the client
differs:

  grainger_requests.py  requests   (this file)
  grainger_httpx.py     httpx
  grainger_urllib.py    urllib, from the standard library

The four requests:

  1. GET the target. DataDome answers 403 with an inline `var dd = {...}`.
  2. GET the challenge document from geo.captcha-delivery.com.
  3. POST /dd/solve — the solver returns a prepared submission.
  4. Send that submission yourself. DataDome returns the clearance cookie.

Step 4 has to come from your own IP: DataDome binds the cookie to whoever
submitted it, which is why the solver hands back the submission instead of
sending it. See http_utils.py.

`requests.Session` keeps a cookie jar for you, which is the reason to pick
this one: `datadome` is set on the block response and again on the solve,
and the session carries it without you threading a Cookie header through.
"""

import os
import sys
from urllib.parse import urlsplit

import requests
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


def attempt(proxy, solver_api_key, solver_url, target_url):
  session = requests.Session()
  session.proxies = {'http': proxy, 'https': proxy}

  # 1. Trip the challenge.
  log(f'GET {target_url}')
  blocked = session.get(
    target_url, headers=navigation_headers(), timeout=TIMEOUT_S
  )
  log(f'  <- HTTP {blocked.status_code} ({len(blocked.text)} bytes)')

  dd = parse_block_page(blocked.text)
  if dd is None:
    log('  no DataDome challenge — the request went straight through')
    return None
  kind = 'captcha' if dd['rt'] == 'c' else 'interstitial'
  log(f'  challenge: {kind} cid={dd["cid"]}')

  # 2. Fetch the challenge document the solver needs to read.
  document_url = challenge_document_url(dd, target_url)
  log('GET challenge document')
  document = session.get(
    document_url, headers=document_headers(target_url), timeout=TIMEOUT_S
  )
  log(f'  <- HTTP {document.status_code} ({len(document.text)} bytes)')

  # 3. Ask xhr.dev to build the submission — but not to send it. This call
  #    goes to your own solver, so it must not use the proxy.
  log('POST /dd/solve')
  headers = {'content-type': 'application/json'}
  if solver_api_key:
    headers['x-api-key'] = solver_api_key
  solve = requests.post(
    solve_endpoint(solver_url),
    headers=headers,
    json=solve_request_body(
      dd, document.text, document_url, proxy, target_url
    ),
    timeout=TIMEOUT_S,
  )
  if solve.status_code != 200:
    raise RuntimeError(
      f'solver returned HTTP {solve.status_code}: {solve.text[:300]}'
    )
  prepared = check_prepared_submission(solve.json())
  log('  <- prepared submission')

  # 4. Submit it ourselves, over the same proxy session. Captcha solves
  #    carry their payload in the query string (GET); interstitials post.
  method = 'POST' if prepared.get('body') else 'GET'
  log(f'{method} submission')
  submitted = session.request(
    method,
    prepared['url'],
    data=prepared.get('body'),
    headers=submission_headers(prepared),
    timeout=TIMEOUT_S,
  )
  cookie = read_clearance_cookie(submitted.text)
  log(f'  <- HTTP {submitted.status_code}')
  log(f'clearance cookie: datadome={cookie}')

  # Put the cookie in the jar by hand, and take the old one out first.
  #
  # Two things conspire here. DataDome sets the clearance cookie with
  # `Domain=.grainger.com`, but the response comes from
  # geo.captcha-delivery.com, so the jar drops it as a domain mismatch.
  # Meanwhile the *block* response did set a `datadome` cookie for
  # .grainger.com — the pre-solve one. Add the new cookie without
  # removing that, and both go out on the next request; DataDome reads
  # the stale one and blocks you again, which looks exactly like a failed
  # solve.
  domain = urlsplit(target_url).hostname
  for stale in list(session.cookies):
    if stale.name == 'datadome':
      domain = stale.domain
      session.cookies.clear(stale.domain, stale.path, stale.name)
  session.cookies.set('datadome', cookie, domain=domain, path='/')

  log('verifying against the target')
  verified = session.get(
    target_url, headers=navigation_headers(), timeout=TIMEOUT_S
  )
  title = page_title(verified.text)
  log(
    f'  <- HTTP {verified.status_code} '
    f'({len(verified.text)} bytes) "{title}"'
  )

  return cookie, verified.status_code


if __name__ == '__main__':
  load_dotenv()
  run(attempt)
