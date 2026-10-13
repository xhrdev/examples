/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sensor/finnair.ts
 * node --env-file=.env src/akamai/sensor/finnair.ts --headless
 *
 * finnair.com. Sensor-only: no SBSD bundle on the homepage, and `_abck`
 * reaches `~0~` in three rounds. The check waits for that acceptance rather
 * than for the page, which renders whether or not the cookie was accepted.
 */
import { runSensorTarget } from '#src/akamai/sensor/target.js';

await runSensorTarget({
  settleMs: 5000,
  success: (page) => `Akamai solved, reached ${new URL(page.url()).pathname}`,
  url: 'https://www.finnair.com/',
});
