/**
 * The small helpers every script in this repo used to define for itself.
 */

export const log = (message: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${message}`, ...extra);

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The value of `--name=value`, or undefined when the flag is absent.
 *
 * Everything after the first `=` is the value, so `--url=https://x/?a=b` comes
 * back whole. The copies this replaced split on `=` and took the second piece,
 * which silently cut such a URL off at its first query parameter.
 */
export const readFlag = (
  name: string,
  argv: readonly string[] = process.argv
): string | undefined => {
  const prefix = `${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};

/** Whether a URL-ish string already carries its own scheme, e.g. `https://`. */
export const hasScheme = (raw: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
