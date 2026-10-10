/**
 * Per-target sign-in credentials, and what a script does without them.
 *
 * ## why this exists
 *
 * `oakley.ts` threw on startup when `username=`/`password=` were missing, and
 * `smoke.yml` has never written either: it builds `.env` from `host=` and
 * `api_key=` alone. So the suite's one credentialed script died at its second
 * statement in every CI run it has ever been part of — 0.7s, no browser
 * launched — and `advisory: true` turned that into a green suite with a
 * silent hole. Measured on the 2026-09-30 scheduled run:
 *
 *     --- src/akamai/sbsd/oakley ---
 *     file:///home/runner/work/examples/examples/src/akamai/sbsd/oakley.ts:53
 *     | src/akamai/sbsd/oakley | Akamai SBSD | FAIL (advisory) | 0.7s |
 *
 * A missing secret is not a failed solve and it is not a flaky target. It is
 * the same class of outcome as a banned exit IP or a spent rate-limit budget:
 * nothing a commit can fix, and nothing that should read as a regression. So
 * it gets the same treatment those have — its own exit code, reported by name
 * in the summary table, never failing the suite.
 *
 * ## the naming, and why the generic pair still works
 *
 * `username=`/`password=` is one pair for a suite that now has more than one
 * account's worth of scripts in it, and `src/loadtest.ts` reads exactly that
 * pair as pass-through credentials for whatever script it drives. So the
 * generic names stay supported and a target-specific pair wins when present:
 * `oakley_username=` beats `username=`. That lets a CI job carry oakley's
 * account without implying every other script shares it.
 *
 * ⚠ `xhrdev/dev-resources/smoke.sh` writes `EDD_USERNAME`/`EDD_PASSWORD` into
 * the generic pair, which meant oakley was signing in with CA EDD's account
 * wherever that path ran. `ca-edd.ts` reads no credentials at all — it stops
 * at the login form on purpose — so those secrets only ever reached oakley,
 * under a name that said otherwise.
 */

/**
 * Exit code for "this script needs an account and was not given one".
 *
 * 3 is a spent rate-limit budget (`#src/rate-limit.js`) and 4 is a banned exit
 * IP (`#src/datadome/ban.js`); this is the third member of that family, and
 * `dev-resources/smoke.js` keeps all three out of the failure count.
 */
export const NOT_CONFIGURED_EXIT_CODE = 5;

export type Credentials = { password: string; username: string };

/**
 * The credentials for one target, or null when none are configured.
 *
 * `target` is the env prefix, not the script path: `'oakley'` reads
 * `oakley_username=`/`oakley_password=`, then falls back to the generic
 * `username=`/`password=`. A pair is only accepted whole — a username with no
 * password is treated as absent rather than half-used, because a sign-in
 * attempt with an empty password is a failed login that looks like a solver
 * result.
 */
export const resolveCredentials = (
  target: string,
  env: Record<string, string | undefined> = process.env
): Credentials | null => {
  for (const [username, password] of [
    [env[`${target}_username`], env[`${target}_password`]],
    [env['username'], env['password']],
  ]) {
    if (username && password) return { password, username };
  }

  return null;
};
