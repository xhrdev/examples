/*
 * run this script:

npm run repl
npm run repl:watch

 * A scratchpad for poking at this repo's helpers without writing a file.
 * Everything below is preloaded into the REPL context:
 *
 *   pinSession, toLaunchProxy, toUrl   src/proxy.ts
 *   parseBlockPage, challengeDocumentUrl, navigationHeaders, ...
 *                                      src/datadome/challenge.ts
 *   fetch, ProxyAgent                  undici
 *   proxy                              your pinned .env proxy
 *   get(url, opts)                     GET through that proxy, returns text
 *
 * For example:
 *
 *   > pinSession('http://u:pw@la.residential.rayobyte.com:8000')
 *   > parseBlockPage(await get('https://www.grainger.com/'))
 */
const repl = require('node:repl');
const path = require('node:path');

const root = path.join(__dirname, '..');

async function main() {
  // The repo is ESM and TypeScript, so pull the helpers in dynamically.
  const [proxyHelpers, challenge, undici] = await Promise.all([
    import(path.join(root, 'src/proxy.ts')),
    import(path.join(root, 'src/datadome/challenge.ts')),
    import('undici'),
  ]);

  const configured = process.env.proxy;
  const proxy = configured ? proxyHelpers.pinSession(configured).url : undefined;

  const get = async (url, opts = {}) => {
    const res = await undici.fetch(url, {
      headers: challenge.navigationHeaders(),
      ...(proxy ? { dispatcher: new undici.ProxyAgent(proxy) } : {}),
      ...opts,
    });
    console.log(`HTTP ${res.status}`);
    return res.text();
  };

  console.log(
    `xhr.dev examples REPL — proxy ${proxy ? 'pinned from .env' : 'NOT SET (run with --env-file=.env)'}`
  );
  console.log('helpers: pinSession, parseBlockPage, get(url), fetch, ProxyAgent\n');

  const server = repl.start({ prompt: '> ' });
  Object.assign(server.context, proxyHelpers, challenge, {
    ProxyAgent: undici.ProxyAgent,
    fetch: undici.fetch,
    get,
    proxy,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
