import { useEffect, useMemo, useState } from '../../lib/teact/teact';

import { IS_ANDROID } from '../../util/browser/windowEnvironment';
import { throttle } from '../../util/schedulers';
import windowSize from '../../util/windowSize';
import useDebouncedCallback from '../useDebouncedCallback';

const THROTTLE = 250;

export default function useWindowSize() {
  const { width: initialWidth, height: initialHeight } = windowSize.get();
  const [width, setWidth] = useState(initialWidth);
  const [height, setHeight] = useState(initialHeight);
  const [isResizing, setIsResizing] = useState(false);
  const setIsResizingDebounced = useDebouncedCallback(setIsResizing, [setIsResizing], THROTTLE, true);

  useEffect(() => {
    let lastWidth = window.innerWidth;

    const throttledSetIsResizing = throttle(() => {
      setIsResizing(true);
    }, THROTTLE, true);

    const throttledSetSize = throttle(() => {
      const { width: newWidth, height: newHeight } = windowSize.get();
      setWidth(newWidth);
      setHeight(newHeight);
      setIsResizingDebounced(false);
    }, THROTTLE, false);

    // On Android a height-only resize is the keyboard opening or closing: report the final height once,
    // without the `isResizing` true -> false round trip that re-renders every subscriber twice more.
    const throttledSetHeight = throttle(() => {
      setHeight(windowSize.get().height);
    }, THROTTLE, false);

    const handleResize = () => {
      const newWidth = window.innerWidth;
      if (IS_ANDROID && newWidth === lastWidth) {
        throttledSetHeight();
        return;
      }

      lastWidth = newWidth;
      throttledSetIsResizing();
      throttledSetSize();
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [setIsResizingDebounced]);

  return useMemo(() => ({ width, height, isResizing }), [height, isResizing, width]);
}
