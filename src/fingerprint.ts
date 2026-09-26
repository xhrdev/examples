/**
 * Run with:
 *
 * node --env-file=.env src/fingerprint.ts
 *
 * Prints what `src/mitm.ts` actually puts on the wire, on each transport,
 * against <https://tls.peet.ws>. It solves nothing — it is here so the claim
 * the rest of the repo makes about the proxy can be checked rather than
 * believed, and so a curl_cffi build that has quietly stopped impersonating
 * Chrome is one command away from being caught.
 *
 * What to look for, in order of how much a bot manager cares:
 *
 *   ja4  the TLS ClientHello. The three parts are the protocol summary, the
 *        cipher list and the extension list. `CHROME_TLS` in `src/mitm.ts`
 *        can fix the middle one from node; only a BoringSSL client fixes the
 *        third, which is why `src/impersonate.ts` exists.
 *   h2   the HTTP/2 SETTINGS frame and window, then the pseudo-header order.
 *        Chrome sends `m,a,s,p`; node sends them alphabetically, `a,m,p,s`,
 *        which no browser does.
 *   ord  the request headers in the order they went out, which is the part
 *        `CHROME_ORDER` in `src/mitm.ts` is responsible for.
 *
 * Measured here on 2026-09-25:
 *
 *   impersonate  ja4 t13d1516h2_8daaf6152771_806a8c22fdea
 *                h2  1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p
 *   undici       ja4 t13d1512h1_8daaf6152771_2c481c11c48b
 *                h2  2:0;4:262144|458753|0|a,m,p,s
 *
 * The cipher hash matches on both — that is `CHROME_TLS` doing its job. The
 * extension hash does not, and the SETTINGS and the pseudo-header order do
 * not. Those three are what the sidecar buys.
 */
import { start, type Transport } from '#src/mitm.js';

const PROBE = 'https://tls.peet.ws/api/all';

type Probe = {
  http2?: {
    akamai_fingerprint?: string;
    sent_frames?: { headers?: string[] }[];
  };
  tls: { ja3_hash: string; ja4: string };
};

const proxy = process.env['proxy'];

for (const transport of ['impersonate', 'undici'] satisfies Transport[]) {
  // `log: () => {}` because the proxy's own startup line would sit in the
  // middle of the table this prints.
  const mitm = await start({
    log: () => undefined,
    ...(proxy ? { proxy } : {}),
    transport,
  });
  try {
    const response = await mitm.fetch({
      headers: { accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
      url: PROBE,
    });
    const probe = JSON.parse(response.body) as Probe;
    const indent = ''.padEnd(12);
    console.log(`${transport.padEnd(12)}ja3: ${probe.tls.ja3_hash}`);
    console.log(`${indent}ja4: ${probe.tls.ja4}`);
    console.log(
      `${indent}h2 : ${probe.http2?.akamai_fingerprint ?? '(none — http/1.1)'}`
    );
    const sent = probe.http2?.sent_frames?.at(-1)?.headers;
    if (sent) {
      console.log(
        `${indent}ord: ${sent.map((header) => header.split(':')[0] || header.split(' ')[0]).join(' ')}`
      );
    }
  } catch (error) {
    console.log(`${transport.padEnd(12)}failed: ${(error as Error).message}`);
  } finally {
    await mitm.stop();
  }
}
