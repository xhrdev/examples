/**
 * This is a helper library, not a script. It holds the one thing every
 * example in this repo needs to agree on: what to do when the solver says
 * "you are going too fast".
 *
 * The solver is rate limited per API key (a shared or trial key has a smaller
 * budget than a permanent one). Over the limit it answers HTTP 429 with a
 * `Retry-After` header, and the request never reaches the solver itself.
 *
 * The important part is that a 429 is **not a retryable failure**. Every other
 * error in these examples is worth another attempt on a fresh proxy session —
 * a dead exit node, a challenge that escalated, a flaky navigation. A 429 is
 * not: the budget is already spent, so retrying cannot succeed, and each retry
 * spends more of the budget you are waiting to get back. So the examples treat
 * it as its own outcome, print what to do about it, and stop immediately.
 */

/**
 * Exit code used by every example here when the rate limit is hit. Distinct
 * from 1 (generic failure) and 2 (Akamai access denied) so a wrapper script
 * can tell "slow down" apart from "this did not work".
 */
export const RATE_LIMIT_EXIT_CODE = 3;

const log = (message: string): void =>
  console.log(`[${new Date().toISOString()}] ${message}`);

/** Thrown when the solver answers 429. Not retryable — see the file header. */
export class RateLimitError extends Error {
  readonly retryAfterSeconds: number | undefined;

  constructor(retryAfterSeconds?: number | undefined) {
    super(
      retryAfterSeconds === undefined
        ? 'rate limit hit: the solver returned HTTP 429'
        : `rate limit hit: the solver returned HTTP 429, retry after ${retryAfterSeconds}s`
    );
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** `Retry-After` out of whatever shape of headers the HTTP client gave us. */
const retryAfter = (headers?: HeaderBag): number | undefined => {
  if (headers === undefined) return undefined;
  const raw: unknown =
    'get' in headers && typeof headers.get === 'function'
      ? headers.get('retry-after')
      : (headers as Record<string, unknown>)['retry-after'];
  // undici and axios agree on a string; a raw Node header bag can hand back an
  // array when the header repeats.
  const value = Array.isArray(raw) ? (raw[0] as unknown) : raw;
  if (value === undefined || value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : undefined;
};

type HeaderBag = HeaderGetter | Record<string, unknown>;

/**
 * Anything with a `Retry-After`: a `fetch`/`undici` `Headers`, or the plain
 * object axios exposes.
 */
// eslint-disable-next-line no-unused-vars -- function-type parameter
type HeaderGetter = { get: (name: string) => null | string };

/**
 * Throw `RateLimitError` if a solver response is a 429, otherwise do nothing.
 *
 * Call this *before* any generic "solver returned HTTP n" check, so the rate
 * limit gets its own message instead of being reported as a random failure.
 */
export const checkRateLimit = (status: number, headers?: HeaderBag): void => {
  if (status !== 429) return;
  throw new RateLimitError(retryAfter(headers));
};

/**
 * The message every example prints when it gives up because of the rate
 * limit. Kept here so all of them say the same thing.
 */
export const reportRateLimit = (error: RateLimitError): void => {
  log('RESULT: FAIL - rate limit hit');
  log(
    error.retryAfterSeconds === undefined
      ? '  the solver returned HTTP 429. Wait for the limit window to roll over, then re-run.'
      : `  the solver returned HTTP 429. Wait ${error.retryAfterSeconds}s for the limit window to roll over, then re-run.`
  );
  log(
    '  limits are per API key, so this is your key going too fast, not the ' +
      'solver being down.'
  );
  log(
    '  not retried on purpose: the budget is already spent, and retrying ' +
      'spends more of it. If you need more throughput, ask for a higher limit.'
  );
};
