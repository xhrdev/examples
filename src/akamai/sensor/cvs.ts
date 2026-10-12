/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sensor/cvs.ts
 * node --env-file=.env src/akamai/sensor/cvs.ts --headless
 *
 * cvs.com. Sensor-only: the homepage sets `bm_s`/`bm_so`/`bm_sz`/`_abck`, and
 * no SBSD carrier was ever seen alongside them. Like lowes.ts, the homepage
 * does not always hold `_abck` at `~-1~` against you — a plain Chrome can
 * render it with the cookie still unaccepted — so the check below is the page
 * itself, not the cookie.
 */
import { runSensorTarget } from '#src/akamai/sensor/target.js';

await runSensorTarget({
  lenient: true,
  settleMs: 5000,
  success: () => 'Homepage accessible',
  url: 'https://www.cvs.com/',
});
