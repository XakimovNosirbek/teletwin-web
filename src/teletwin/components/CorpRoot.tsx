import { memo } from '../../lib/teact/teact';

import CorpGate from './CorpGate';
import { CorpWakeUpPicker } from './CorpWakeUp';

// Corp overlays mounted once in `Main`: the mandatory login gate and the wake-up member picker
const CorpRoot = () => {
  return (
    <>
      <CorpGate />
      <CorpWakeUpPicker />
    </>
  );
};

export default memo(CorpRoot);
