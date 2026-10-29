import type { IDimensions } from '../types';

import { requestMutation } from '../lib/fasterdom/fasterdom';
import { IS_ANDROID, IS_IOS } from './browser/windowEnvironment';
import { throttle } from './schedulers';

const WINDOW_ORIENTATION_CHANGE_THROTTLE_MS = 100;
const WINDOW_RESIZE_THROTTLE_MS = 250;

let initialHeight = window.innerHeight;
let appliedVh: number | undefined;
let pendingVh: number | undefined;
let currentWindowSize = updateSizes();

// Android shrinks the layout viewport when the keyboard opens, and may do it more than once (a suggestion
// strip or toolbar appearing). Every step must reach `--vh` by the next frame to keep the composer above
// the keyboard; a trailing throttle call could leave it covered for 250 ms, so `setVh` coalesces instead.
const handleResize = IS_ANDROID ? () => {
  currentWindowSize = updateSizes();
} : throttle(() => {
  currentWindowSize = updateSizes();
}, WINDOW_RESIZE_THROTTLE_MS, true);

const handleOrientationChange = throttle(() => {
  initialHeight = window.innerHeight;
  handleResize();
}, WINDOW_ORIENTATION_CHANGE_THROTTLE_MS, false);

window.addEventListener('orientationchange', handleOrientationChange);
if (IS_IOS) {
  window.visualViewport!.addEventListener('resize', handleResize);
} else {
  window.addEventListener('resize', handleResize);
}

export function updateSizes(): IDimensions {
  let height: number;
  if (IS_IOS) {
    height = window.visualViewport!.height + window.visualViewport!.pageTop;
  } else {
    height = window.innerHeight;
  }

  setVh(height * 0.01);

  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function setVh(vh: number) {
  if (!IS_ANDROID) {
    requestMutation(() => {
      document.documentElement.style.setProperty('--vh', `${vh}px`);
    });
    return;
  }

  // `--vh` lives on <html>, so every write restyles the whole document:
  // write at most once per frame, and only when the value changed.
  if (vh === (pendingVh ?? appliedVh)) return;
  const isScheduled = pendingVh !== undefined;
  pendingVh = vh;
  if (isScheduled) return;

  requestMutation(() => {
    const nextVh = pendingVh!;
    pendingVh = undefined;
    if (nextVh === appliedVh) return;
    appliedVh = nextVh;
    document.documentElement.style.setProperty('--vh', `${nextVh}px`);
  });
}

const windowSize = {
  get: () => currentWindowSize,
  getIsKeyboardVisible: () => initialHeight > currentWindowSize.height,
};

export default windowSize;
