/**
 * Telling Akamai's two scripts apart.
 *
 * On a property that runs both channels, the SBSD bundle and the `_abck`
 * sensor script are served from paths of the same shape, under the same random
 * per-property prefix, and neither one names the channel:
 *
 *   /bJ21n/Qp/tw/aIDx/2p3gpz0/OmOtbQafzih3w1k7/fQUZPAE/Q01H/JFVIT0YB
 *   /bJ21n/Qp/tw/aIDx/2p3gpz0/hQOtbQafzi/K0ciPAE/NQdp/VyRmPU8Y?v=<uuid>
 *
 * Both are ~500 KiB of obfuscation and both mention `bmak`, so size and
 * content do not separate them either. The `v=` does: on the bundle it is a
 * UUID that seeds the bundle's codec, not a version. Ordinary cache-busters
 * (`?v=3.5.6`, `?v=202606.2.0`) do not look like that, and every site ships
 * dozens of those.
 *
 * Getting this wrong is quiet. A sensor session opened against the bundle's
 * path posts happily and is answered `200` with an empty body — rather than
 * the sensor's `201` — and `_abck` simply never leaves `~-1~`.
 */

/** The bundle's cache-buster: a UUID, not a version. */
const BUNDLE_NONCE =
  /[?&]v=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;

/** Where properties that follow the convention serve it. */
const WELL_KNOWN_SBSD = '/.well-known/sbsd';

/** Either signature is enough to call a script the SBSD bundle. */
export const isSbsdBundle = (url: URL): boolean =>
  url.pathname.startsWith(WELL_KNOWN_SBSD) || BUNDLE_NONCE.test(url.search);
