/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sensor/ca-edd.ts
 * node --env-file=.env src/akamai/sensor/ca-edd.ts --headless
 *
 * Checks that the solver gets us past Akamai to the real login page — it does
 * not sign in. Signing in would exercise CA EDD's own auth, not the solver,
 * and risks the account (lockout, rate limits) for no extra signal.
 */
import { runSensorTarget } from '#src/akamai/sensor/target.js';

await runSensorTarget({
  settleMs: 7000,
  success: () => 'Login page accessible',
  url: 'https://eddservices.edd.ca.gov/tap/secure/eservices',
});
