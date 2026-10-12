/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sbsd/magazineluiza.ts
 * node --env-file=.env src/akamai/sbsd/magazineluiza.ts --headless
 *
 * magazineluiza.com.br. A blocked request gets the retailer's own branded
 * Akamai deny page rather than Akamai's default template, but it is the same
 * edge-level bot-manager response underneath.
 */
import { runSbsdHomepage } from '#src/akamai/sbsd/homepage.js';

await runSbsdHomepage({
  ignoreHTTPSErrors: true,
  isDenied: ({ title }) => /não é possível acessar a página/iu.test(title),
  locale: 'pt-BR',
  origin: 'https://www.magazineluiza.com.br',
  timezoneId: 'America/Sao_Paulo',
});
