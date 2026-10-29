import { memo } from '../../lib/teact/teact';

import CorpDirectPicker from './CorpDirectPicker';
import CorpGate from './CorpGate';
import CorpJiraCard from './CorpJiraCard';
import { CorpDndWakeUpConfirm, CorpStatusModal } from './CorpStatus';
import { CorpWakeUpPicker } from './CorpWakeUp';

// Corp overlays mounted once in `Main`: the mandatory login gate, the wake-up and direct chat pickers and the issue card
const CorpRoot = () => {
  return (
    <>
      <CorpGate />
      <CorpWakeUpPicker />
      <CorpDirectPicker />
      <CorpJiraCard />
      <CorpStatusModal />
      <CorpDndWakeUpConfirm />
    </>
  );
};

export default memo(CorpRoot);
