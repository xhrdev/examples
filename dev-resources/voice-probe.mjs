/**
 * Which browser on this machine can see speech-synthesis voices.
 *
 * The Akamai SBSD lane sends `speechSynthesis.getVoices()` counts as part of
 * the realm snapshot, and the sandbox refuses a ledger for a desktop Chrome
 * that reports none — correctly, because no such browser exists. On a
 * developer's machine this is invisible; a CI runner has no speech engine
 * unless one is installed, and a *confined* browser may not reach it even
 * then. That distinction is the whole reason this script exists: it is the one
 * environmental difference the SBSD channel notices, and it is not otherwise
 * visible in a failing log.
 *
 * Prints one line per candidate browser. Never fails the job — it is a
 * measurement, not a gate.
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const CANDIDATES = [
  { launch: { channel: 'chrome' }, name: 'chrome (channel)' },
  {
    launch: { executablePath: '/snap/bin/chromium' },
    name: 'chromium (snap)',
    path: '/snap/bin/chromium',
  },
  {
    launch: { executablePath: '/usr/bin/chromium-browser' },
    name: 'chromium (apt)',
    path: '/usr/bin/chromium-browser',
  },
];

for (const candidate of CANDIDATES) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed list above
  if (candidate.path && !fs.existsSync(candidate.path)) {
    console.log(`${candidate.name}: not installed`);
    continue;
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: false, ...candidate.launch });
    const page = await browser.newPage();
    // Voices populate a few hundred ms after a real document, not on
    // about:blank, so this has to load something and then wait.
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    /* eslint-disable no-undef -- this body runs in the page, not in node */
    const counts = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const read = () => {
            const voices = speechSynthesis.getVoices();
            return {
              local: voices.filter((v) => v.localService).length,
              total: voices.length,
            };
          };
          // The first call is what asks the platform for the list; it answers
          // empty and fires voiceschanged once the list arrives. Reading once
          // and reporting the answer says "no voices" on a machine with 180.
          const first = read();
          if (first.total > 0) return resolve(first);
          const timer = setTimeout(() => resolve(read()), 5000);
          speechSynthesis.onvoiceschanged = () => {
            clearTimeout(timer);
            resolve(read());
          };
        })
    );
    /* eslint-enable no-undef */
    console.log(
      `${candidate.name}: total=${counts.total} local=${counts.local}` +
        `${counts.total === 0 ? '  <-- SBSD will be refused' : ''}`
    );
  } catch (error) {
    console.log(
      `${candidate.name}: launch failed — ${error.message.split('\n')[0]}`
    );
  } finally {
    await browser?.close();
  }
}
