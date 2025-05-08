/* eslint-disable security/detect-non-literal-fs-filename */
import * as fs from 'node:fs';
import * as cheerio from 'cheerio';

import { __dirname } from '@test/utils';

const fixturesDir = `${__dirname}/fixtures`;
const html = fs.readFileSync(`${fixturesDir}/example.html`, 'utf-8');
const $ = cheerio.load(html);

// eslint-disable-next-line @typescript-eslint/no-floating-promises
(async () => {
  const response = $('#cm-cr-dp-review-list li').text();

  console.log({ response });
  process.exit(0);
})();
