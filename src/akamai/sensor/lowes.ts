/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sensor/lowes.ts
 * node --env-file=.env src/akamai/sensor/lowes.ts --headless
 *
 * lowes.com. Checks that the solver gets us past Akamai to the homepage.
 */
import { runSensorTarget } from '#src/akamai/sensor/target.js';

await runSensorTarget({
  lenient: true,
  settleMs: 5000,
  success: () => 'Homepage accessible',
  url: 'https://www.lowes.com/',
});
