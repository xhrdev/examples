"""DataDome challenge handling shared by the Python examples.

This is a helper library, not a script. It holds the protocol details the
browser-free Python examples have in common, so each of those files shows
only its own HTTP client:

  grainger_requests.py  requests
  grainger_httpx.py     httpx
  grainger_urllib.py    urllib, from the standard library

It is the Python port of src/datadome/http-utils.ts, and the flow is
identical — see src/datadome/README.md.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone
from urllib.parse import urlencode

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from proxy import pin_session  # noqa: E402

GEO_ORIGIN = 'https://geo.captcha-delivery.com'
DEFAULT_URL = 'https://www.grainger.com/'
SOLVER_PORT = 3000
TIMEOUT_S = 120

# A coherent Chrome-on-macOS identity. Every field the solver receives has
# to agree with the headers you actually send — DataDome cross-checks
# them, so changing the user agent here without changing
# navigation_headers() is the most common way to get a solve rejected.
PROFILE = {
  'brands': [
    {'brand': 'Google Chrome', 'version': '149'},
    {'brand': 'Chromium', 'version': '149'},
    {'brand': 'Not)A;Brand', 'version': '24'},
  ],
  'chromeFullVersion': '149.0.7827.201',
  'chromeVersion': '149',
  'deviceMemory': 32,
  'hardwareConcurrency': 10,
  'languages': 'en-US,en',
  'os': 'macos',
  'platformVersion': '26.5.2',
  'screen': {
    'availHeight': 948,
    'availLeft': 0,
    'availTop': 0,
    'availWidth': 1512,
    'colorDepth': 30,
    'devicePixelRatio': 2,
    'height': 982,
    'innerHeight': 761,
    'innerWidth': 1200,
    'outerHeight': 904,
    'outerWidth': 1200,
    'pixelDepth': 30,
    'screenX': 0,
    'screenY': 143,
    'width': 1512,
  },
  'timezone': 'America/New_York',
  'timezoneOffsetMinutes': 240,
  'userAgent': (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
  ),
  'vendor': 'Google Inc.',
}

PROFILE_ID = f'chrome-{PROFILE["chromeVersion"]}-{PROFILE["os"]}'

DD_BLOCK_RE = re.compile(r'var\s+dd\s*=\s*(\{[^}]*\})')
TITLE_RE = re.compile(r'<title>([^<]*)', re.I)


def log(message):
  stamp = datetime.now(timezone.utc).isoformat(timespec='milliseconds')
  print(f'[{stamp.replace("+00:00", "Z")}] {message}', flush=True)


def navigation_headers():
  brands = ', '.join(
    f'"{b["brand"]}";v="{b["version"]}"' for b in PROFILE['brands']
  )
  return {
    'accept': (
      'text/html,application/xhtml+xml,application/xml;q=0.9,'
      'image/avif,image/webp,image/apng,*/*;q=0.8'
    ),
    'accept-language': 'en-US,en;q=0.9',
    'sec-ch-ua': brands,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'user-agent': PROFILE['userAgent'],
  }


def document_headers(target_url):
  """Headers for the challenge document, which loads in an iframe."""
  headers = navigation_headers()
  headers.update({
    'referer': target_url,
    'sec-fetch-dest': 'iframe',
    'sec-fetch-site': 'cross-site',
  })
  return headers


def submission_headers(prepared):
  """Headers for the final submission back to DataDome."""
  return {
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'origin': prepared['origin'],
    'referer': prepared['referer'],
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': PROFILE['userAgent'],
  }


def parse_block_page(html):
  """Pull the `var dd = {...}` literal out of a 403 body.

  Returns None when the page is not a DataDome block — i.e. you were not
  challenged at all.
  """
  match = DD_BLOCK_RE.search(html)
  if not match:
    return None
  # The literal uses single quotes, which json rejects. No value in a
  # DataDome block contains a quote, so this swap is safe.
  dd = json.loads(match.group(1).replace("'", '"'))
  if not isinstance(dd, dict):
    return None
  if not dd.get('cid') or not dd.get('hsh') or not dd.get('cookie'):
    return None
  if dd.get('rt') not in ('c', 'i'):
    return None
  return dd


def challenge_document_url(dd, target_url):
  """Rebuild the challenge document URL exactly as DataDome's c.js would."""
  path = '/captcha/' if dd['rt'] == 'c' else '/interstitial/'
  params = {
    'initialCid': dd['cid'],
    'hash': dd['hsh'],
    'cid': dd['cookie'],
    't': dd.get('t', 'fe'),
    'referer': target_url,
    's': str(dd.get('s', 0)),
  }
  if dd.get('e'):
    params['e'] = dd['e']
  params['dm'] = 'cd'
  return f'{GEO_ORIGIN}{path}?{urlencode(params)}'


def solve_endpoint(solver_url):
  """`/dd/solve` never submits for you — it returns a prepared submission.

  DataDome binds the clearance cookie to whichever IP submitted it, so a
  cookie the solver earned would be void from your address.
  """
  return f'{solver_url}/dd/solve'


def solve_request_body(dd, document_html, document_url, proxy, target_url):
  challenge = {'cid': dd['cid'], 'hsh': dd['hsh'], 'rt': dd['rt']}
  challenge['s'] = dd.get('s', 0)
  for key in ('b', 'e', 't'):
    if dd.get(key) is not None:
      challenge[key] = dd[key]

  return {
    'dd': challenge,
    'ddCookie': dd['cookie'],
    'iframeData': {'html': document_html, 'url': document_url},
    'js_profile': {
      'brands': PROFILE['brands'],
      'chromeFullVersion': PROFILE['chromeFullVersion'],
      'chromeVersion': PROFILE['chromeVersion'],
      'deviceMemory': PROFILE['deviceMemory'],
      'hardwareConcurrency': PROFILE['hardwareConcurrency'],
      'languages': PROFILE['languages'],
      'os': PROFILE['os'],
      'platformVersion': PROFILE['platformVersion'],
      'screen': PROFILE['screen'],
      'timezone': PROFILE['timezone'],
      'timezoneOffsetMinutes': PROFILE['timezoneOffsetMinutes'],
      'vendor': PROFILE['vendor'],
    },
    'profile': {
      'chromeFullVersion': PROFILE['chromeFullVersion'],
      'httpHeaderTemplates': {
        'form': [],
        'iframe': [],
        'image': [],
        'xhr': [],
      },
      'id': PROFILE_ID,
      'os': PROFILE['os'],
      'timezone': PROFILE['timezone'],
      'timezoneOffsetMinutes': PROFILE['timezoneOffsetMinutes'],
      'tlsClientHello': '',
      'userAgent': PROFILE['userAgent'],
    },
    'proxy': proxy,
    'timeout': TIMEOUT_S * 1000,
    'url': target_url,
  }


def check_prepared_submission(prepared):
  if prepared.get('origin') != GEO_ORIGIN:
    raise RuntimeError(
      f'solver returned an unexpected origin: {prepared.get("origin")}'
    )
  return prepared


def read_clearance_cookie(response_body):
  """DataDome answers with a full Set-Cookie string; keep just the value."""
  issued = json.loads(response_body).get('cookie')
  if not issued:
    raise RuntimeError(
      f'DataDome rejected the solve: {response_body[:300]}'
    )
  return issued.split(';')[0].removeprefix('datadome=')


def page_title(html):
  match = TITLE_RE.search(html)
  return match.group(1).strip() if match else ''


def read_flag(name, default=None):
  prefix = f'{name}='
  for arg in sys.argv[1:]:
    if arg.startswith(prefix):
      return arg[len(prefix):]
  return default


def _is_transport(error):
  """Dead exit nodes are not solve failures — take a new session."""
  text = f'{type(error).__name__}: {error}'
  return bool(
    re.search(
      r'Connection|Timeout|timed out|reset by peer|EOF|Tunnel|Proxy',
      text,
      re.I,
    )
  )


def run(attempt):
  """Read the environment, pin a fresh session per attempt, report.

  `attempt` takes (proxy, solver_api_key, solver_url, target_url) and
  returns a (cookie, status) pair, or None when there was no challenge.
  """
  solver_host = os.environ.get('host')
  configured_proxy = os.environ.get('proxy')
  if not solver_host:
    raise SystemExit('set host= in .env')
  if not configured_proxy:
    raise SystemExit('set proxy= in .env')

  attempts = int(read_flag('--attempts', '3'))
  target_url = read_flag('--url', DEFAULT_URL)
  solver_url = f'http://{solver_host}:{SOLVER_PORT}'
  solver_api_key = os.environ.get('solver_api_key')

  last_error = None
  for i in range(1, attempts + 1):
    # A fresh session per attempt: a new IP, and a clean slate.
    proxy, _pinned = pin_session(configured_proxy)
    try:
      outcome = attempt(proxy, solver_api_key, solver_url, target_url)
      if outcome is None:
        log('RESULT: no challenge to solve')
        return
      _cookie, status = outcome
      if status != 200:
        raise RuntimeError(f'verification failed: HTTP {status}')
      log('RESULT: SUCCESS')
      return
    except Exception as error:  # noqa: BLE001 - report and retry
      last_error = error
      reason = 'proxy session failed' if _is_transport(error) else str(error)
      if i < attempts:
        log(f'attempt {i}/{attempts} failed ({reason}) — retrying')

  reason = (
    'proxy session failed' if _is_transport(last_error) else str(last_error)
  )
  log(f'RESULT: FAIL - {reason}')
  raise SystemExit(1)
