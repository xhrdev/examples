export const CAPTCHA_HANDLE_SELECTOR = '#captcha__element div.slider';
export const CAPTCHA_LAYOUT_SETTLE_MS = 100;
export const CAPTCHA_LAYOUT_TIMEOUT_MS = 5_000;

const MAX_VIEWPORT_DIMENSION_PX = 32_768;
const MIN_HANDLE_AREA_PX_SQUARED = 0.5;
const MIN_VIEWPORT_DIMENSION_PX = 100;

export type CaptchaLayout = {
  coordinateSpace: 'captcha-frame-viewport-css-px';
  handleQuad: {
    ll: Point;
    lr: Point;
    ul: Point;
    ur: Point;
  };
  version: 1;
  viewport: Viewport;
};

export type CaptchaLayoutMeasurement = {
  handle: HandleBox;
  scroll: { x: number; y: number };
  settledHandle: HandleBox;
  viewport: Viewport;
};

type HandleBox = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

type Point = { x: number; y: number };

type Viewport = { height: number; width: number };

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const sameBox = (first: HandleBox, second: HandleBox): boolean =>
  first.bottom === second.bottom &&
  first.left === second.left &&
  first.right === second.right &&
  first.top === second.top;

export const buildCaptchaLayout = (
  measurement: CaptchaLayoutMeasurement,
  expectedViewport: Viewport
): CaptchaLayout | undefined => {
  const { handle, scroll, settledHandle, viewport } = measurement;
  const { height, width } = viewport;
  if (
    !isFiniteNumber(width) ||
    !isFiniteNumber(height) ||
    width <= MIN_VIEWPORT_DIMENSION_PX ||
    height <= MIN_VIEWPORT_DIMENSION_PX ||
    width > MAX_VIEWPORT_DIMENSION_PX ||
    height > MAX_VIEWPORT_DIMENSION_PX ||
    width !== expectedViewport.width ||
    height !== expectedViewport.height ||
    scroll.x !== 0 ||
    scroll.y !== 0
  ) {
    return undefined;
  }

  const { bottom, left, right, top } = handle;
  if (
    ![bottom, left, right, top].every(isFiniteNumber) ||
    !sameBox(handle, settledHandle) ||
    left < 0 ||
    top < 0 ||
    right > width ||
    bottom > height ||
    right <= left ||
    bottom <= top ||
    (right - left) * (bottom - top) <= MIN_HANDLE_AREA_PX_SQUARED
  ) {
    return undefined;
  }

  return {
    coordinateSpace: 'captcha-frame-viewport-css-px',
    handleQuad: {
      ll: { x: left, y: bottom },
      lr: { x: right, y: bottom },
      ul: { x: left, y: top },
      ur: { x: right, y: top },
    },
    version: 1,
    viewport: { height, width },
  };
};
