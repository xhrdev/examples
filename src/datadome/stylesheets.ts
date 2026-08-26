/**
 * This is a helper library, not a script. It collects the stylesheets the
 * challenge document loads, so they can be sent along with `/dd/solve`.
 *
 * `/dd/solve` does not fetch them for you. Send them and the solve models the
 * page as it was actually served; leave them out and it works from defaults.
 * Either way you get a submission back, so this is about accuracy rather than
 * success, and the accuracy is cheap: the client has already fetched the
 * challenge document, and the stylesheets sit on the same host behind the
 * same session.
 *
 * Every client here fetches differently — undici with a dispatcher, axios
 * with an agent, node's own fetch, a browser page — so this takes the fetch
 * as an argument rather than choosing one. Pass whatever you already use for
 * the challenge document, so the assets come back over the same session.
 */

/**
 * At most this many assets per solve. The API rejects a request carrying more
 * than 16, so stopping here keeps a pathological document from turning a
 * solve into a 400.
 */
const MAX_ASSETS = 16;

/** `<link ...>`, whole tag at a time; `rel` and `href` are read out of it. */
const LINK_TAG = /<link\b[^>]*>/gi;
const REL_ATTRIBUTE = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const HREF_ATTRIBUTE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/**
 * `@import url("...")`, `@import "..."`, and the unquoted forms of both.
 *
 * Two passes rather than one pattern: a single regex wants `\s+` and `\s*` on
 * either side of an optional `url(`, and those two can divide a run of spaces
 * between them more than one way — which is the ambiguity that makes a matcher
 * backtrack. This input is CSS fetched from the network, so it is worth not
 * having that property at all. The statement scan is bounded, and the target
 * pattern is anchored, so it has one start position rather than one per
 * character. `(` is excluded from the bare-word
 * class for the same reason: leave it in and `url(x` is matchable both by the
 * prefix and by the word, which is a second way to say the same thing.
 *
 * `security/detect-unsafe-regex` still flags the target pattern, and it is a
 * false positive: that rule is a star-height heuristic and does not know the
 * input is capped at 2048 characters by the statement scan. Measured at 200k
 * characters of every adversarial shape it accepts — a run of spaces, `url(`
 * then a run of spaces, one long word — it returns in under a millisecond,
 * linearly.
 */
const CSS_IMPORT_STATEMENT = /@import[^;]{0,2048}/gi;

const CSS_IMPORT_TARGET =
  // eslint-disable-next-line security/detect-unsafe-regex -- bounded and measured; see above
  /^\s*(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s"'();]+))/i;

/** One stylesheet, as `iframeData.stylesheetAssets` wants it. */
export type StylesheetAsset = { body: string; url: string };

/** The first capturing group that actually matched, for the alternations above. */
const captured = (match: null | RegExpMatchArray): string | undefined =>
  match ? (match[1] ?? match[2] ?? match[3]) : undefined;

/**
 * Canonicalise a stylesheet reference, or reject it.
 *
 * This mirrors the API's own validation — HTTPS only, `captcha-delivery.com`
 * or a subdomain, no embedded credentials, fragment stripped — because it
 * re-runs those checks on arrival and answers 400 for the *whole request* if
 * any one entry fails. Dropping an asset costs a little accuracy; sending a
 * bad one costs the solve.
 */
export const stylesheetUrl = (
  value: string | undefined,
  base?: string
): string | undefined => {
  if (!value) return undefined;

  try {
    const url = base ? new URL(value, base) : new URL(value);

    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.hostname !== 'captcha-delivery.com' &&
        !url.hostname.endsWith('.captcha-delivery.com'))
    ) {
      return undefined;
    }

    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
};

/**
 * Every `rel="stylesheet"` href in the challenge document, canonicalised.
 *
 * Regex rather than a DOM: this runs in HTTP-only clients that have no
 * document, and pulling a parser in for two link tags would be the heaviest
 * dependency in the file. Every URL is canonicalised above before it is used.
 */
export const extractStylesheetUrls = (
  html: string,
  documentUrl: string
): string[] => {
  const urls: string[] = [];

  for (const [tag] of html.matchAll(LINK_TAG)) {
    const isStylesheet = captured(REL_ATTRIBUTE.exec(tag))
      ?.split(/\s+/)
      .some((token) => token.toLowerCase() === 'stylesheet');
    if (!isStylesheet) continue;

    const url = stylesheetUrl(captured(HREF_ATTRIBUTE.exec(tag)), documentUrl);
    if (url) urls.push(url);
  }

  return urls;
};

/**
 * Every `@import` in a stylesheet body, resolved against that stylesheet.
 *
 * The captcha's `index.css` imports the Roboto `font-face.css`, so following
 * imports is not an edge case — it is half of what the document loads.
 */
export const extractImportUrls = (css: string, from: string): string[] => {
  const urls: string[] = [];

  for (const [statement] of css.matchAll(CSS_IMPORT_STATEMENT)) {
    const target = CSS_IMPORT_TARGET.exec(statement.slice('@import'.length));
    const url = stylesheetUrl(captured(target), from);
    if (url) urls.push(url);
  }

  return urls;
};

/**
 * Walk the challenge document's stylesheets and their imports, breadth first.
 *
 * Bounded rather than recursive: `@import` can cycle, and a client that hangs
 * fetching CSS is worse than one that sends nothing. `seen` closes the cycle,
 * `MAX_ASSETS` closes the depth, and a fetch that throws drops that asset
 * rather than failing the solve — sending none is a supported state.
 *
 * Worth calling on both challenge types, and free where a document links
 * nothing: the collector only fetches what it finds.
 */
export const collectStylesheetAssets = async ({
  documentHtml,
  documentUrl,
  fetchAsset,
}: {
  documentHtml: string;
  documentUrl: string;
  // eslint-disable-next-line no-unused-vars -- function-type parameter
  fetchAsset: (url: string) => Promise<string>;
}): Promise<StylesheetAsset[]> => {
  const queue = extractStylesheetUrls(documentHtml, documentUrl);
  const seen = new Set(queue);
  const assets: StylesheetAsset[] = [];

  while (queue.length > 0 && assets.length < MAX_ASSETS) {
    // `queue` is non-empty, which `shift()`'s type does not know.
    const url = queue.shift() as string;

    let body: string;
    try {
      body = await fetchAsset(url);
    } catch {
      continue;
    }

    assets.push({ body, url });

    for (const imported of extractImportUrls(body, url)) {
      if (seen.has(imported)) continue;
      seen.add(imported);
      queue.push(imported);
    }
  }

  return assets;
};
