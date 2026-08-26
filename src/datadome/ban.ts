/**
 * This is a helper library, not a script. It holds what every DataDome example
 * needs to agree on: what it means when DataDome has already decided about
 * you, before any challenge is offered.
 *
 * DataDome answers a banned visitor with `t: "bv"` instead of a challenge.
 * There is nothing to solve — no interstitial, no captcha, no payload the
 * solver could build — because the verdict is about the address the request
 * came from, not about anything in the request.
 *
 * That makes it the same shape of outcome as a 429, and it is treated the same
 * way here for the same reason: **it is not a retryable failure, and it is not
 * a regression.** Retrying sends the same address back to the same verdict.
 * Reporting it as a failed solve blames the solver for an exit IP's
 * reputation, which is how a smoke suite ends up red for a reason nobody can
 * fix by changing code.
 *
 * A ban is fixed by leaving from somewhere else: rotate the proxy, use a
 * residential or ISP pool, or unset `proxy=` and go direct. Nothing downstream
 * of the request can recover from it.
 */

/**
 * Exit code used when DataDome reports the exit IP is banned. Distinct from 1
 * (generic failure), 2 (Akamai access denied) and 3 (rate limited), so a
 * wrapper script can tell "this address is burned" apart from "this broke".
 */
export const BANNED_EXIT_CODE = 4;

/** Thrown when DataDome serves `t: "bv"`. Not retryable — see the file header. */
export class BannedError extends Error {
  constructor(detail?: string) {
    super(
      detail === undefined
        ? 'DataDome reports this IP is banned'
        : `DataDome reports this IP is banned: ${detail}`
    );
    this.name = 'BannedError';
  }
}

const log = (message: string): void =>
  console.log(`[${new Date().toISOString()}] ${message}`);

/**
 * What every example prints when it stops because of a ban. Kept here so they
 * all say the same thing, and so the advice is the advice that actually works.
 */
export const reportBanned = (error: BannedError): void => {
  log(`RESULT: BANNED - ${error.message}`);
  log(
    '  DataDome served t="bv" (banned visitor) rather than a challenge. There ' +
      'is no payload to build: the verdict is about the address, not the request.'
  );
  log(
    '  not retried on purpose: the same address gets the same answer. Rotate ' +
      'to a different exit IP, move to a residential or ISP pool, or unset ' +
      'proxy= to go out directly.'
  );
};
