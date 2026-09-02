/**
 * Whether this machine can run the SBSD examples at all.
 *
 * The realm snapshot carries `speechSynthesis.getVoices()` counts, and the
 * sandbox refuses a ledger for a desktop Chrome that reports none — correctly,
 * because no such browser exists. That makes a speech engine a hard
 * prerequisite rather than a detail, and it is one a headless CI runner does
 * not meet: installing `speech-dispatcher`, using an unconfined Chrome and
 * giving the daemon a D-Bus session were all tried on a GitHub runner, and the
 * count stayed at zero through every one of them.
 *
 * So the examples distinguish "this environment cannot run me" from "the solve
 * failed", rather than reporting the first as the second. A run that exits
 * with `NO_VOICES_EXIT_CODE` has proved nothing about the solver either way.
 *
 * Deliberately not done: sending the counts a desktop *would* have. Inventing
 * a reading the page cannot back up is the identity mismatch this whole
 * channel punishes, and it would turn a loud environment problem into a silent
 * `~-1~` somewhere else.
 */
import type { Page } from 'playwright-core';

/**
 * Distinct from 1 (generic failure), 2 (access denied), 3 (rate limited) and
 * 4 (banned), so the smoke suite can report it as an environment gap.
 */
export const NO_VOICES_EXIT_CODE = 5;

/** Thrown before a solve is attempted, not after one fails. */
export class NoVoicesError extends Error {
  constructor() {
    super(
      'this machine reports no speech-synthesis voices, which the SBSD ' +
        'channel requires — the examples need a desktop browser with a ' +
        'working speech engine, not a headless runner'
    );
    this.name = 'NoVoicesError';
  }
}

/**
 * Read the voice count off a live page.
 *
 * The first `getVoices()` call is what asks the platform for the list and it
 * answers empty, firing `voiceschanged` when the real list arrives. Reading
 * once and believing the answer reports "no voices" on a machine with 180 —
 * so this waits for the event, with a bound for the machines where it never
 * comes because there is nothing to load.
 */
export const countVoices = async (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const read = (): number => speechSynthesis.getVoices().length;
        const first = read();
        if (first > 0) return resolve(first);
        const timer = setTimeout(() => {
          resolve(read());
        }, 5000);
        speechSynthesis.onvoiceschanged = () => {
          clearTimeout(timer);
          resolve(read());
        };
      })
  );

/** Throws `NoVoicesError` if this machine cannot run the SBSD examples. */
export const requireVoices = async (page: Page): Promise<void> => {
  if ((await countVoices(page)) === 0) throw new NoVoicesError();
};
