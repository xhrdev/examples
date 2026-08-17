/**
 * Turning `host=` from .env into a solver URL.
 *
 * `host=` accepts two forms:
 *
 *   host=10.0.0.5            -> http://10.0.0.5:3000
 *   host=https://trial.xhr.dev -> https://trial.xhr.dev
 *
 * The bare form is what a self-hosted container looks like: plain HTTP on
 * :3000 inside your own network, which is the deployment the README describes
 * and the default this repo has always used.
 *
 * The full-URL form exists because the hosted trial box sits behind a reverse
 * proxy with TLS, and reaching it by hostname over plain :3000 would put your
 * API key and the clearance cookies it returns on the wire in cleartext. If
 * you are pointing at anything across the public internet, give it a scheme.
 */

const SOLVER_PORT = 3000;

/** Matches a URL that already carries its own scheme, e.g. `https://…`. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Base URL for the solver's HTTP API, e.g. `https://trial.xhr.dev`.
 *
 * Any trailing slash is stripped so callers can join paths with `new URL()`
 * without doubling up.
 */
export const solverBaseUrl = (host: string): string =>
  HAS_SCHEME.test(host)
    ? host.replace(/\/+$/, '')
    : `http://${host}:${SOLVER_PORT}`;

/**
 * WebSocket URL for the Akamai streaming session.
 *
 * The scheme follows the base URL, so a TLS solver gets `wss://` and a plain
 * one gets `ws://` — sending `ws://` to a TLS listener fails to connect, and
 * the reverse sends the session in the clear.
 */
export const solverWsUrl = (host: string, path: string): string =>
  `${solverBaseUrl(host).replace(/^http/, 'ws')}${path}`;
