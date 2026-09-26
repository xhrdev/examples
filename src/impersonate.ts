/**
 * This is a helper library, not a script. It owns the `py-src/impersonate.py`
 * sidecar and gives `src/mitm.ts` one function: make this request, and look
 * like Chrome doing it.
 *
 * ## why a sidecar and not a node client
 *
 * `src/mitm.ts` exists because DataDome bans Lightpanda on its TLS stack
 * alone, before any JavaScript runs. Re-originating through undici with
 * Chrome's cipher suites and curve order moved that problem without ending
 * it, and the file said so: a JA3/JA4 hash also covers the extension list,
 * the extension order and the GREASE values, and node's TLS bindings expose
 * none of the three. One layer up it was worse — undici stayed on http/1.1
 * on purpose, because node's HTTP/2 SETTINGS frames are not Chrome's either
 * and Akamai reads those, so the choice was between two wrong fingerprints.
 *
 * Getting this right needs a client built on BoringSSL. The two that exist
 * are curl-impersonate and utls; curl-impersonate ships as a pip wheel with
 * the BoringSSL build inside it, so it costs `pip install curl_cffi` and a
 * subprocess rather than a Go toolchain and a build step. This repo already
 * has a venv and a `requirements.txt`, so that is the one this uses.
 *
 * Measured against tls.peet.ws, same headers, same machine:
 *
 *   undici with Chrome's ciphers   ja4 t13d…, negotiated http/1.1, so there
 *                                  is no h2 fingerprint to compare at all
 *   this                           ja4 t13d1516h2_8daaf6152771_806a8c22fdea
 *                                  h2  1:65536;2:0;4:6291456;6:262144|
 *                                      15663105|0|m,a,s,p
 *
 * Both of which are Chrome's, exactly, including the `m,a,s,p` pseudo-header
 * order that is one of the cheapest tells there is.
 *
 * ## the version it claims
 *
 * The impersonation target is picked from what the installed build actually
 * supports, preferring the one matching `PROFILE.chromeVersion` and falling
 * back to the newest Chrome it has. A hard-coded `chrome131` here would go
 * stale against `src/profile.ts` silently, which is the exact failure mode
 * that file warns about: solves that stop being accepted with nothing naming
 * the version as the cause.
 *
 * The build does not have to carry the same Chrome as the profile — the
 * hello has been byte-identical across recent Chrome majors, and the version
 * a site reads is the one in `user-agent`, which `src/mitm.ts` sets. A build
 * several majors behind is still Chrome on the wire; it is a mismatch worth
 * logging, not one worth failing on.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROFILE } from '#src/profile.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'py-src', 'impersonate.py');
/**
 * Importing curl_cffi pulls in the bundled BoringSSL build, which is not
 * instant on a cold page cache. This only has to be longer than that.
 */
const READY_TIMEOUT_MS = 20_000;

/** `[name, value]` pairs, because order matters out and `set-cookie` repeats back. */
export type HeaderPairs = [string, string][];

export type ImpersonateResponse = {
  body: Buffer;
  headers: HeaderPairs;
  status: number;
};

export type Impersonator = {
  /**
   * Make one request. Headers go out in the order given — that order is part
   * of the fingerprint, so the caller assembles it, not this.
   */
  request: (
    // eslint-disable-next-line no-unused-vars -- function-type parameter
    request: {
      body?: Buffer;
      headers: HeaderPairs;
      method: string;
      proxy?: string;
      timeoutMs?: number;
      url: string;
    }
  ) => Promise<ImpersonateResponse>;
  stop: () => Promise<void>;
  /** The curl-impersonate target in use, e.g. `chrome150`. */
  target: string;
};

/**
 * The interpreter to run the sidecar with. The repo's venv first, because
 * that is where `make install` puts curl_cffi; `$PYTHON` for anyone who keeps
 * their environment elsewhere; `python3` last, which works if curl_cffi
 * happens to be installed globally and fails loudly if it is not.
 */
const interpreter = (): string => {
  const fromEnv = process.env['PYTHON'];
  if (fromEnv) return fromEnv;
  for (const candidate of [
    path.join(ROOT, 'venv', 'bin', 'python'),
    path.join(ROOT, 'venv', 'Scripts', 'python.exe'),
  ]) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- both candidates are built from this file's own location
    if (existsSync(candidate)) return candidate;
  }
  return 'python3';
};

/**
 * Prefer the profile's own Chrome, then the newest Chrome the build has.
 * Sorted numerically: `chrome99` sorts after `chrome150` as a string, and
 * picking Chrome 99's hello in 2026 would be its own fingerprint.
 */
const pickTarget = (available: string[]): string => {
  const exact = `chrome${PROFILE.chromeVersion}`;
  if (available.includes(exact)) return exact;
  const versioned = available
    .map((name) => ({ name, version: /^chrome(\d+)$/.exec(name)?.[1] }))
    .filter((entry) => entry.version !== undefined)
    .sort((a, b) => Number(b.version) - Number(a.version));
  const newest = versioned[0]?.name;
  if (!newest) {
    throw new Error(
      `the curl_cffi build supports no Chrome targets: ${available.join(', ')}`
    );
  }
  return newest;
};

/** Start the sidecar. Resolves once it has printed the port it is serving on. */
export const start = async (
  options: {
    // eslint-disable-next-line no-unused-vars -- function-type parameter
    log?: (message: string) => void;
  } = {}
): Promise<Impersonator> => {
  const { log } = options;
  const child: ChildProcess = spawn(interpreter(), [SCRIPT, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // stderr is kept whole rather than streamed, so a python traceback arrives
  // as the reason the start failed instead of as interleaved noise.
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += String(chunk);
  });

  const handshake = await new Promise<{ impersonate: string[]; port: number }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(
          new Error(
            `py-src/impersonate.py printed no port within ${READY_TIMEOUT_MS}ms${stderr ? `: ${stderr.trim()}` : ''}`
          )
        );
      }, READY_TIMEOUT_MS);
      let stdout = '';
      const fail = (message: string): void => {
        clearTimeout(timer);
        child.kill('SIGTERM');
        reject(new Error(message));
      };
      child.once('error', (error) =>
        fail(
          `could not run ${interpreter()}: ${error.message} — install the venv with: make install`
        )
      );
      child.once('exit', (code) =>
        fail(
          `py-src/impersonate.py exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}` +
            ' — install it with: ./venv/bin/pip install -r requirements.txt'
        )
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += String(chunk);
        const line = stdout.split('\n')[0];
        if (line === undefined || !stdout.includes('\n')) return;
        clearTimeout(timer);
        try {
          const message = JSON.parse(line) as {
            error?: string;
            impersonate?: string[];
            port?: number;
          };
          if (message.error || message.port === undefined) {
            fail(`py-src/impersonate.py: ${message.error ?? 'no port'}`);
            return;
          }
          resolve({
            impersonate: message.impersonate ?? [],
            port: message.port,
          });
        } catch {
          fail(`py-src/impersonate.py said something unexpected: ${line}`);
        }
      });
    }
  );

  // The handshake listeners are one-shot rejections; past this point an exit
  // is a dead sidecar, and the next request is where that has to surface.
  child.removeAllListeners('exit');
  child.removeAllListeners('error');
  let exited: string | undefined;
  child.once('exit', (code) => {
    exited = `py-src/impersonate.py exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`;
  });
  child.once('error', (error) => {
    exited = `py-src/impersonate.py: ${error.message}`;
  });

  const target = pickTarget(handshake.impersonate);
  if (target !== `chrome${PROFILE.chromeVersion}` && log) {
    log(
      `impersonate: this curl_cffi build has no chrome${PROFILE.chromeVersion}, using ${target} — ` +
        'the hello is the same shape; the version sites read is the user agent'
    );
  }
  const endpoint = `http://127.0.0.1:${handshake.port}/request`;

  return {
    request: async (request) => {
      if (exited) throw new Error(exited);
      const response = await fetch(endpoint, {
        body: JSON.stringify({
          ...(request.body
            ? { bodyBase64: request.body.toString('base64') }
            : {}),
          headers: request.headers,
          impersonate: target,
          method: request.method,
          ...(request.proxy ? { proxy: request.proxy } : {}),
          ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
          url: request.url,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        // The sidecar enforces the real deadline; this only has to outlast it
        // so a slow upstream is reported as itself rather than as a dead
        // sidecar.
        signal: AbortSignal.timeout((request.timeoutMs ?? 30_000) + 5_000),
      });
      const payload = (await response.json()) as {
        bodyBase64?: string;
        error?: string;
        headers?: HeaderPairs;
        status?: number;
      };
      if (!response.ok || payload.status === undefined) {
        throw new Error(
          payload.error ?? `impersonate: HTTP ${response.status}`
        );
      }
      return {
        body: Buffer.from(payload.bodyBase64 ?? '', 'base64'),
        headers: payload.headers ?? [],
        status: payload.status,
      };
    },
    stop: async (): Promise<void> => {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 2_000).unref();
      });
    },
    target,
  };
};
