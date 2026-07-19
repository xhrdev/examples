import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type FakeDataDomeFlow,
  runFakeDataDomeFlow,
} from '#test/domedata/fake-playwright.js';

const CASES: ReadonlyArray<{
  flow: FakeDataDomeFlow;
  sequence: Array<'c' | 'i'>;
}> = [
  { flow: 'i', sequence: ['i'] },
  { flow: 'c', sequence: ['c'] },
  { flow: 'i-c', sequence: ['i', 'c'] },
];

describe('DataDome browser orchestration', () => {
  for (const { flow, sequence } of CASES) {
    it(`completes ${sequence.join(' -> ')}`, async () => {
      const run = await runFakeDataDomeFlow(flow);

      assert.deepEqual(run.solverTypes, sequence);
      if (flow === 'i-c') {
        assert.equal(run.solverIr[1], '12,34,56,78,90');
      }
      assert.deepEqual(run.relayKinds, sequence);
      assert.equal(run.bodyReads.interstitial, 0);
      assert.equal(run.bodyReads.captcha, 0);
      assert.ok(run.relayValues.every((value) => value.includes('sandbox')));
      assert.equal(run.result.responseStatus, 200);
      assert.equal(run.result.url, 'https://shop.example.test/product/one');
      assert.equal(
        run.result.cookie,
        sequence.includes('c')
          ? 'accepted-captcha-cookie'
          : 'accepted-interstitial-cookie'
      );
      assert.equal(run.cleanedUp, true);
    });
  }
});
