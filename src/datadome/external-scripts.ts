export const MAX_EXTERNAL_SCRIPTS = 4;

const SCRIPT_OPEN_TAG = /<script\b([^>]*)>/gi;
const SRC_ATTRIBUTE = /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

export type ExternalScript = { body: string; url: string };

export const externalScriptUrl = (
  value: string | undefined,
  base?: string
): string | undefined => {
  if (!value) return undefined;

  try {
    const url = base ? new URL(value.trim(), base) : new URL(value.trim());
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
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

export const extractExternalScriptUrls = (
  html: string,
  documentUrl: string
): string[] => {
  const urls: string[] = [];
  const lower = html.toLowerCase();
  SCRIPT_OPEN_TAG.lastIndex = 0;

  let match: null | RegExpExecArray;
  while ((match = SCRIPT_OPEN_TAG.exec(html)) !== null) {
    const src = SRC_ATTRIBUTE.exec(match[1] ?? '');
    const url = externalScriptUrl(
      src ? (src[1] ?? src[2] ?? src[3]) : undefined,
      documentUrl
    );
    if (url && !urls.includes(url)) urls.push(url);

    const close = lower.indexOf('</script>', SCRIPT_OPEN_TAG.lastIndex);
    if (close < 0) break;
    SCRIPT_OPEN_TAG.lastIndex = close + '</script>'.length;
  }

  return urls.slice(0, MAX_EXTERNAL_SCRIPTS);
};
