/**
 * This is a helper library, not a script. It holds the one distinction the
 * load-test summary could not previously draw: the target refusing us, as
 * against something going wrong.
 *
 * A solve can end three ways that are not "it worked". The solver can error,
 * the run can crash or time out — and, separately, everything can go right and
 * the *target* can still say no: the challenge is solved, the clearance cookie
 * is issued, and the next request comes back 403 anyway. That last one is the
 * outcome a load test most wants to count, because it is the one that measures
 * whether solves are being accepted.
 *
 * Exit code 2 has always meant that for `comcast-lightpanda`, and the runner
 * has always had a `Fail (Access Denied)` bucket for it. Nothing else used it,
 * so every DataDome refusal was landing in `Error (timeout/crash)` next to
 * genuine crashes, and the denied bucket read 0% no matter what happened.
 */

/**
 * Exit code for "the target refused us", as distinct from 1 (something broke),
 * 3 (rate limited) and 4 (the exit IP is banned).
 *
 * A run that exits 2 did its job. The solve was accepted by the solver and
 * rejected by the site, which is a measurement, not a fault.
 */
export const ACCESS_DENIED_EXIT_CODE = 2;

/**
 * True when an error is the target turning down a solve we completed.
 *
 * The two clients say it differently, because the refusal reaches them
 * differently. An HTTP client submits and re-requests the page, so it sees the
 * refusal as a status: `verification failed: HTTP 403`. A browser stays on the
 * page, so it sees the target hand back a fresh challenge instead of clearing
 * it: `The target returned a recurrent challenge`. Same event either way — the
 * solve was completed and the site declined it — so both count as denied.
 *
 * Matched on the message rather than on a status threaded through every layer:
 * these two phrases are each produced in exactly one place, and re-plumbing
 * four call paths to restate what the message already says would be the larger
 * change.
 */
export const isAccessDenied = (error: unknown): boolean =>
  /verification failed: HTTP (403|405|41\d)|returned a recurrent challenge/.test(
    (error as Error)?.message ?? ''
  );
