"""Proxy string handling, in one place.

This is a helper library, not a script. It is the Python port of
src/proxy.ts, and it exists for the same reason: every example needs a
pinned session out of a proxy string, and letting each script roll its own
is how the copies drift apart.

Clearance cookies are bound to the IP that earned them, so a pool that
rotates mid-flow hands you a cookie that is void on arrival.
"""

import random
import re
from urllib.parse import quote, unquote, urlsplit

# Session tokens, as the major providers spell them:
#
#   oxylabs      user-<acct>-sessid-<n>
#   rayobyte     <pass>-hardsession-<n>            (in the password)
#   bright data  brd-customer-<acct>-session-<n>
#   smartproxy   user-<acct>-session-<n>
#   joinmassive  <acct>-session-<n>-sessionttl-<n>
SESSION_TOKEN_RE = re.compile(
  r'((?:^|[-_])(?:hard)?sess(?:ion)?(?:id)?[-_])([a-z0-9]+)', re.I
)

# An explicit opt-in for providers we do not recognise.
SESSION_PLACEHOLDER_RE = re.compile(r'\{session\}', re.I)

# Where to graft a token on when a known provider's string has none.
PROVIDERS = (
  ('username', re.compile(r'(^|\.)oxylabs\.io$', re.I), 'sessid'),
  ('password', re.compile(r'(^|\.)rayobyte\.com$', re.I), 'hardsession'),
)

SCHEME_RE = re.compile(r'^[a-z][a-z0-9+.-]*://', re.I)


def _split(raw):
  """Parse a proxy string, tolerating a missing scheme."""
  parts = urlsplit(raw if SCHEME_RE.match(raw) else f'http://{raw}')
  return {
    'host': parts.hostname or '',
    'password': unquote(parts.password or ''),
    'port': parts.port,
    'scheme': parts.scheme,
    'username': unquote(parts.username or ''),
  }


def _join(bits):
  """Re-serialise, percent-encoding the credentials."""
  netloc = ''
  if bits['username'] or bits['password']:
    netloc = quote(bits['username'], safe='')
    if bits['password']:
      netloc += ':' + quote(bits['password'], safe='')
    netloc += '@'
  netloc += bits['host']
  if bits['port']:
    netloc += f':{bits["port"]}'
  return f'{bits["scheme"]}://{netloc}'


def _rotate(value, session):
  """Rewrite a session token in one half of the credentials."""
  if SESSION_PLACEHOLDER_RE.search(value):
    return SESSION_PLACEHOLDER_RE.sub(str(session), value)
  if SESSION_TOKEN_RE.search(value):
    return SESSION_TOKEN_RE.sub(rf'\g<1>{session}', value, count=1)
  return None


def pin_session(raw, session=None):
  """Pin the proxy to one exit IP for the duration of a flow.

  Rewrites an existing session token wherever it appears, honours a
  `{session}` placeholder, and grafts the right token onto known
  providers that have none.

  Returns (url, pinned). `pinned` is False when the string offers nothing
  to pin — tell the user rather than pretending it worked.
  """
  if session is None:
    session = random.randint(100_000, 1_000_000_000)
  bits = _split(raw)

  rotated_user = _rotate(bits['username'], session)
  rotated_pass = _rotate(bits['password'], session)
  if rotated_user is not None:
    bits['username'] = rotated_user
  if rotated_pass is not None:
    bits['password'] = rotated_pass
  if rotated_user is not None or rotated_pass is not None:
    return _join(bits), True

  for half, host_re, token in PROVIDERS:
    if host_re.search(bits['host']) and bits[half]:
      bits[half] = f'{bits[half]}-{token}-{session}'
      return _join(bits), True

  return _join(bits), False


def proxy_host(raw):
  """The bare host:port, no credentials — for NO_PROXY and logging."""
  bits = _split(raw)
  return bits['host'] + (f':{bits["port"]}' if bits['port'] else '')
