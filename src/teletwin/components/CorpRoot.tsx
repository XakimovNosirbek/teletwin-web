import { memo } from '../../lib/teact/teact';

import CorpDirectPicker from './CorpDirectPicker';
import CorpGate from './CorpGate';
import { CorpWakeUpPicker } from './CorpWakeUp';

// Corp overlays mounted once in `Main`: the mandatory login gate and the wake-up and direct chat pickers
const CorpRoot = () => {
  return (
    <>
      <CorpGate />
      <CorpWakeUpPicker />
      <CorpDirectPicker />
    </>
  );
};

export default memo(CorpRoot);
