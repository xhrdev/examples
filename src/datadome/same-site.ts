import { getDomain } from 'tldts';

/**
 * Whether two hostnames belong to the same site: the same registrable domain
 * under the public suffix list, so `www.kompass.com` and `us.kompass.com`
 * match, `shop.example.co.uk` and `www.example.co.uk` match, and
 * `example.co.uk` does not match `other.co.uk` (comparing the last two labels
 * would). Private suffixes count as suffixes, so two `*.github.io` pages are
 * different sites. Hostnames with no registrable domain — IP literals,
 * `localhost` — only match themselves.
 */
export function sameSite(left: string, right: string): boolean {
  if (left === right) return true;
  const options = { allowPrivateDomains: true };
  const leftDomain = getDomain(left, options);
  return leftDomain !== null && leftDomain === getDomain(right, options);
}
