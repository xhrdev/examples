import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCaptchaLayout,
  type CaptchaLayoutMeasurement,
} from '#src/datadome/captcha-layout.js';

const viewport = { height: 814, width: 1512 };
const handle = { bottom: 468.5, left: 634.25, right: 694.25, top: 428.5 };

const measurement = (
  overrides: Partial<CaptchaLayoutMeasurement> = {}
): CaptchaLayoutMeasurement => ({
  handle,
  scroll: { x: 0, y: 0 },
  settledHandle: { ...handle },
  viewport,
  ...overrides,
});

describe('dd captcha layout', () => {
  it('builds the handle quad in frame viewport css px', () => {
    assert.deepEqual(buildCaptchaLayout(measurement(), viewport), {
      coordinateSpace: 'captcha-frame-viewport-css-px',
      handleQuad: {
        ll: { x: 634.25, y: 468.5 },
        lr: { x: 694.25, y: 468.5 },
        ul: { x: 634.25, y: 428.5 },
        ur: { x: 694.25, y: 428.5 },
      },
      version: 1,
      viewport,
    });
  });

  it('accepts a handle touching the viewport edges', () => {
    const edge = { bottom: 814, left: 0, right: 1512, top: 0 };
    assert.ok(
      buildCaptchaLayout(
        measurement({ handle: edge, settledHandle: { ...edge } }),
        viewport
      )
    );
  });

  it('sends nothing when the viewport differs from the js_profile one', () => {
    assert.equal(
      buildCaptchaLayout(measurement(), { height: 814, width: 1511 }),
      undefined
    );
    assert.equal(
      buildCaptchaLayout(measurement(), { height: 815, width: 1512 }),
      undefined
    );
  });

  it('sends nothing for an implausible viewport', () => {
    for (const bad of [
      { height: 100, width: 1512 },
      { height: 814, width: 100 },
      { height: 814, width: 32_769 },
      { height: Number.NaN, width: 1512 },
    ]) {
      assert.equal(
        buildCaptchaLayout(measurement({ viewport: bad }), bad),
        undefined
      );
    }
  });

  it('sends nothing when the frame is scrolled', () => {
    assert.equal(
      buildCaptchaLayout(measurement({ scroll: { x: 0, y: 12 } }), viewport),
      undefined
    );
    assert.equal(
      buildCaptchaLayout(measurement({ scroll: { x: 3, y: 0 } }), viewport),
      undefined
    );
  });

  it('sends nothing when the handle moved while settling', () => {
    assert.equal(
      buildCaptchaLayout(
        measurement({ settledHandle: { ...handle, left: 640, right: 700 } }),
        viewport
      ),
      undefined
    );
  });

  it('sends nothing for a degenerate or out-of-viewport handle', () => {
    for (const box of [
      { ...handle, right: handle.left },
      { ...handle, bottom: handle.top },
      { bottom: 1, left: 10, right: 10.4, top: 0 },
      { ...handle, left: -1 },
      { ...handle, top: -0.5 },
      { ...handle, right: 1513 },
      { ...handle, bottom: 815 },
      { ...handle, right: Number.POSITIVE_INFINITY },
    ]) {
      assert.equal(
        buildCaptchaLayout(
          measurement({ handle: box, settledHandle: { ...box } }),
          viewport
        ),
        undefined
      );
    }
  });
});
