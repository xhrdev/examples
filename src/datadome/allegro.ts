/**
 * Run with:
 *
 * node --env-file=.env src/datadome/allegro.ts
 * node --env-file=.env src/datadome/allegro.ts --headless
 * node --env-file=.env src/datadome/allegro.ts --screenshot
 */
import { runBrowserTarget } from '#src/datadome/browser-target.js';

await runBrowserTarget({
  name: 'allegro',
  url: 'https://allegro.pl/oferta/bukiet-roz-roze-sztuczne-kwiaty-jak-zywe-prezent-walentynki-piekne-mydlane-16842279548',
});
