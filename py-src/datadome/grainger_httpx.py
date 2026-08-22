"""Run with:

python3 py-src/datadome/grainger_httpx.py
python3 py-src/datadome/grainger_httpx.py --url=https://www.idealista.com/

DataDome clearance cookies for grainger.com with **httpx** — no browser.
Same four requests as grainger_requests.py; see that file for the flow.

httpx takes the proxy per client rather than per request, which maps
neatly onto one pinned session per attempt. It also keeps a cookie jar,
with the same caveat as requests: the clearance cookie arrives from
geo.captcha-delivery.com carrying `Domain=.grainger.com`, so the jar drops
it and you have to set it on the target host yourself.
"""

import os
import sys
from urllib.parse import urlsplit

import httpx
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


def attempt(proxy, api_key, solver_url, target_url):
  # `proxy=None` is httpx's own default: a client that goes direct.
  with httpx.Client(
    follow_redirects=True, proxy=proxy, timeout=TIMEOUT_S
  ) as client:
    # 1. Trip the challenge.
    log(f'GET {target_url}')
    blocked = client.get(target_url, headers=navigation_headers())
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
    document = client.get(document_url, headers=document_headers(target_url))
    log(f'  <- HTTP {document.status_code} ({len(document.text)} bytes)')

    # 3. Ask xhr.dev to build the submission — but not to send it. This
    #    call goes to your own solver, so it uses a proxy-less client.
    log('POST /dd/solve')
    headers = {'content-type': 'application/json'}
    if api_key:
      headers['x-api-key'] = api_key
    solve = httpx.post(
      solve_endpoint(solver_url),
      headers=headers,
      json=solve_request_body(
        dd, document.text, document_url, proxy, target_url
      ),
      timeout=TIMEOUT_S,
    )
    check_rate_limit(solve.status_code, solve.headers)
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
    submitted = client.request(
      method,
      prepared['url'],
      content=prepared.get('body'),
      headers=submission_headers(prepared),
    )
    cookie = read_clearance_cookie(submitted.text)
    log(f'  <- HTTP {submitted.status_code}')
    log(f'clearance cookie: datadome={cookie}')

    # Replace the pre-solve cookie the block response left in the jar.
    # Leaving it there means both values go out and DataDome reads the
    # stale one, which looks exactly like a failed solve.
    host = urlsplit(target_url).hostname
    client.cookies.delete('datadome')
    client.cookies.set('datadome', cookie, domain=host)

    log('verifying against the target')
    verified = client.get(target_url, headers=navigation_headers())
    title = page_title(verified.text)
    log(
      f'  <- HTTP {verified.status_code} '
      f'({len(verified.text)} bytes) "{title}"'
    )

    return cookie, verified.status_code


if __name__ == '__main__':
  load_dotenv()
  run(attempt)
