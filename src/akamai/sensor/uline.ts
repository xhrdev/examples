/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sensor/uline.ts
 * node --env-file=.env src/akamai/sensor/uline.ts --headless
 *
 * uline.com. Sensor-only, and strict like finnair.ts: success is `_abck`
 * accepted (three rounds), not merely the homepage rendering.
 */
import { runSensorTarget } from '#src/akamai/sensor/target.js';

await runSensorTarget({
  settleMs: 5000,
  success: (page) => `Akamai solved, reached ${new URL(page.url()).pathname}`,
  url: 'https://www.uline.com/',
});
