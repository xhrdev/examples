/*
 * Runs from `postinstall`. Downloads the Lightpanda binary that
 * src/lightpanda.ts spawns — see that file for what it is and why the examples
 * use it. There is no npm package for it, only a ~70MB release asset per
 * platform, so it lands in target/ (gitignored) rather than node_modules/.
 *
 * Nothing here is fatal. Lightpanda is only needed by the two `:lightpanda`
 * examples, so a platform without a release asset, or a machine with no network,
 * should still end up with a working install of everything else. The two
 * scripts that do need it fail with a clear message on their own.
 *
 * CI and Docker both install with `--ignore-scripts`, so this does not run
 * there — it is a convenience for a local checkout.
 */
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE =
  'https://github.com/lightpanda-io/browser/releases/latest/download';

// The release publishes one asset per platform, named by the Zig target triple.
const ASSETS = {
  'darwin:arm64': 'lightpanda-aarch64-macos',
  'darwin:x64': 'lightpanda-x86_64-macos',
  'linux:arm64': 'lightpanda-aarch64-linux',
  'linux:x64': 'lightpanda-x86_64-linux',
};

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'target', 'lightpanda');

async function main() {
  if (await stat(target).catch(() => null)) {
    console.log(`lightpanda: already at ${path.relative(root, target)}`);
    return;
  }

  const asset = ASSETS[`${process.platform}:${process.arch}`];
  if (!asset) {
    console.log(
      `lightpanda: no release for ${process.platform}/${process.arch} — skipping`
    );
    return;
  }

  const url = `${RELEASE}/${asset}`;
  console.log(`lightpanda: downloading ${asset}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} -> HTTP ${response.status}`);
  }

  // Download to a temporary name and rename it into place, so an interrupted
  // download cannot leave a truncated binary behind that the check above would
  // then treat as already installed.
  const partial = `${target}.download`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(partial, response.body);
    await chmod(partial, 0o755);
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }

  console.log(`lightpanda: installed to ${path.relative(root, target)}`);
}

try {
  await main();
} catch (error) {
  console.warn(`lightpanda: skipped (${error.message})`);
}
