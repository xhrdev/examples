/**
 * DataDome's endpoints, plus the shared browser identity re-exported for the
 * files that already import it from here.
 *
 * The identity itself moved to `src/profile.ts` so the Akamai examples and the
 * MCP server can share it — it was never DataDome-specific, and keeping it
 * under `datadome/` is why the Akamai scripts ended up carrying their own copy
 * and drifting two major versions behind. Re-exported rather than relocated
 * outright so `import { PROFILE } from '#src/datadome/profile.js'` keeps
 * working across the client examples.
 */

export { PROFILE, PROFILE_ID } from '#src/profile.js';

export const GEO_HOST = 'geo.captcha-delivery.com';
export const GEO_ORIGIN: string = `https://${GEO_HOST}`;
