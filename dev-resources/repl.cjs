/*
 * run this script:

npm run repl
npm run repl:watch

 * A playground for exploring a live DataDome challenge by hand. It sets up
 * the same axios client as src/datadome/grainger-axios.ts — proxied, with a
 * cookie jar — and drops you into a REPL with the pieces in scope, so you can
 * walk the flow one request at a time and poke at whatever comes back.
 *
 *   > const html = await get()                 // 1. trip the challenge
 *   > const dd = parseBlockPage(html)          //    read the dd object
 *   > const doc = await get(challengeDocumentUrl(dd, target))
 *   > const prepared = await solve(dd, doc)    // 3. ask xhr.dev
 *   > const cookie = await submit(prepared)    // 4. send it yourself
 *   > pageTitle(await get())                   //    should be the real page
 *
 * In scope: target, client, jar, get, solve, submit, plus everything from
 * src/datadome/challenge.ts and src/proxy.ts.
 */
const repl = require('node:repl');
const path = require('node:path');

const root = path.join(__dirname, '..');

async function main() {
  // The repo is ESM and TypeScript, so pull everything in dynamically. These
  // are awaited one at a time on purpose: importing them together trips
  // ERR_REQUIRE_ESM_RACE_CONDITION, since some of these packages require()
  // a shared dependency that is still mid-load.
  const { pinSession } = await import(path.join(root, 'src/proxy.ts'));
  const challenge = await import(path.join(root, 'src/datadome/challenge.ts'));
  const axiosMod = await import('axios');
  const cookieSupport = await import('axios-cookiejar-support');
  const cookieAgent = await import('http-cookie-agent/http');
  const hpa = await import('https-proxy-agent');
  const tough = await import('tough-cookie');

  const axios = axiosMod.default;
  const target = process.argv[2] || 'https://www.grainger.com/';
  const solverHost = process.env.host;
  const solverUrl = solverHost ? `http://${solverHost}:3000` : undefined;

  // proxy= is optional here too: unset, everything goes out from this box.
  const proxy = process.env.proxy ? pinSession(process.env.proxy).url : undefined;

  // Same client as grainger-axios.ts: the jar lives in the agent.
  const HttpsProxyCookieAgent = cookieAgent.createCookieAgent(hpa.HttpsProxyAgent);
  const jar = new tough.CookieJar();
  const client = cookieSupport.wrapper(
    axios.create({
      httpsAgent: proxy
        ? new HttpsProxyCookieAgent(proxy, { cookies: { jar } })
        : new cookieAgent.HttpsCookieAgent({ cookies: { jar } }),
      proxy: false,
      validateStatus: () => true,
    })
  );

  /** GET through the proxy. Defaults to the target page. */
  const get = async (url = target, headers) => {
    const res = await client.get(url, {
      headers: headers ?? challenge.navigationHeaders(),
      responseType: 'text',
    });
    console.log(`HTTP ${res.status} (${res.data.length} bytes)`);
    return res.data;
  };

  /** POST the challenge to xhr.dev and get a prepared submission back. */
  const solve = async (dd, documentHtml) => {
    const res = await axios.post(
      challenge.solveEndpoint(solverUrl),
      challenge.solveRequestBody({
        dd,
        documentHtml,
        documentUrl: challenge.challengeDocumentUrl(dd, target),
        proxy,
        targetUrl: target,
      }),
      {
        headers: {
          'content-type': 'application/json',
          ...(process.env.api_key
            ? { 'x-api-key': process.env.api_key }
            : {}),
        },
        validateStatus: () => true,
      }
    );
    console.log(`HTTP ${res.status}`);
    return res.data;
  };

  /** Send the prepared submission yourself, and return the clearance cookie. */
  const submit = async (prepared) => {
    const res = await client.request({
      ...(prepared.body === undefined ? {} : { data: prepared.body }),
      headers: challenge.submissionHeaders(prepared),
      method: prepared.body === undefined ? 'GET' : 'POST',
      responseType: 'text',
      url: prepared.url,
    });
    console.log(`HTTP ${res.status}`);
    const cookie = challenge.readClearanceCookie(res.data);
    await jar.setCookie(`datadome=${cookie}`, new URL(target).origin);
    return cookie;
  };

  console.log(`xhr.dev playground — target ${target}`);
  console.log(`  proxy  ${proxy ? proxy.replace(/:[^:@]*@/, ':***@') : 'none (direct)'}`);
  console.log(`  solver ${solverUrl ?? 'NOT SET (set host= in .env)'}`);
  console.log('  try:   const dd = parseBlockPage(await get())\n');

  const server = repl.start({ prompt: '> ' });
  Object.assign(server.context, challenge, {
    axios,
    client,
    get,
    jar,
    pinSession,
    proxy,
    solve,
    solverUrl,
    submit,
    target,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
