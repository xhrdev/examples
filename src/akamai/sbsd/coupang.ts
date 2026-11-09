/**
 * Run with:
 *
 * node --env-file=.env src/akamai/sbsd/coupang.ts
 * node --env-file=.env src/akamai/sbsd/coupang.ts --headless
 *
 * coupang.com. A first visit can be served the sensor alone, but an address
 * it has seen before gets a ~440-byte "Access Denied" bootstrap carrying the
 * SBSD bundle, and the real homepage only after the carrier is answered. So it
 * runs under `attach()`, which handles either: SBSD when it is there, then
 * `_abck` to `~0~` (three rounds).
 *
 * This is the homepage only. `/np/search` and `/vp/products/...` are not
 * reached by it, and no example here does, as of 2026-11-03. What was measured
 * there with SBSD, `_abck` and the pixel all answered:
 *
 * - Akamai's challenge channel answers first, on some requests: a 200 document
 *   with `#sec-if-cpt-container` that loads a script from `.../G0xue/...`, POSTs
 *   to it (202, then 200) and reloads. It then ends in the 403 "쿠팡!" page
 *   without ever setting `sec_cpt`. Nothing in this repo answers that channel.
 * - Coupang also runs a first-party script, `customjs/sec-g/<version>/sec.min.js`,
 *   that writes `x-cp-s`, `sg_local_id` and `sg_device_token`. It compares the
 *   page against its workers (UA, languages, cores), checks natives and the
 *   WebGL renderer, and looks for captcha libraries. It is not Akamai.
 * - `ljc.coupang.com` is Coupang's analytics logger, not a bot check.
 * - sec-g reads a payload of ~120 `JG###` signals and a behavioural trace
 *   (mouse events). A `SharedWorker` used to report the real browser while the
 *   page reported the profile: Chrome 157 against 154 in the UA, client hints
 *   and `appVersion`, `platformVersion` 27.2.0 against 26.5.2, and `en-GB`
 *   languages against `en-US`. `openAkamaiSession` now launches with the
 *   profile's `--user-agent` and `--accept-lang` and `applyWorkerIdentity`
 *   overrides the worker realms, so page, dedicated worker, shared worker and
 *   iframe agree. Search was still refused in 0 of 9 trials afterwards, so that
 *   was a real inconsistency but not the whole answer.
 *
 * Re-measured 2026-11-09 on the jsdom-31 solver, from a session that had just
 * answered everything on the homepage (carrier rows, pixel body, `_abck`
 * accepted to `~0~`): `/np/search` is refused at the navigation itself, and
 * nothing about the answered channels changes it.
 *
 * - The refusal is a 3.4 KB 403 document on the FIRST request — no
 *   `#sec-if-cpt-container` interstitial, which matches the 2026-11-03 note
 *   saying the interstitial appears "on some requests": the interstitial is the
 *   first-offence path, and a session already marked goes straight to the 403.
 * - Every 403 response RESETS `_abck` to `~-1~`. Re-solving to acceptance on
 *   the denied document and reloading does not clear it; four rounds of
 *   solve-and-reload were refused identically.
 * - Driving the search through the site's own form — typing into the header
 *   search box, submitting, landing on `/np/search?component=&q=…&traceId=…
 *   &channel=user` with the trace the page itself generated — is refused with
 *   the same 403. The gate is not navigation-shape.
 * - `sec_cpt` is never set on any of these paths.
 *
 * That places the gate outside the Akamai channels this repo answers: the
 * remaining candidates are the sec-g device token (first-party, ~120 signals
 * plus a behavioural trace) and whatever the CPT interstitial would have
 * issued had it been shown. Answering either is a project of its own; the
 * homepage remains what this example can reach.
 */
import { looksDenied } from '#src/akamai/session.js';
import { runSbsdHomepage } from '#src/akamai/sbsd/homepage.js';

await runSbsdHomepage({
  ignoreHTTPSErrors: true,
  isDenied: ({ html }) => looksDenied(html),
  origin: 'https://www.coupang.com',
});
