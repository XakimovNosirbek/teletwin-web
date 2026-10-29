import { memo, useEffect, useState } from '../../lib/teact/teact';

import { putCorpStatus } from '../api';
import { corpEngine } from '../engine';
import { getEmployeeId, isCorpMentionKeywordId, isCorpUserId } from '../ids';
import { wakeUpEmployee } from '../index';
import {
  buildCorpStatus, getActiveCorpStatus, getCorpStatuses, getDndWakeUp, getStatusModalOpen, setCorpStatus,
  setDndWakeUp, setStatusModalOpen,
} from '../status';

import useDerivedState from '../../hooks/useDerivedState';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../../components/ui/Button';
import Checkbox from '../../components/ui/Checkbox';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import InputText from '../../components/ui/InputText';
import Modal from '../../components/ui/Modal';
import RadioGroup from '../../components/ui/RadioGroup';

import styles from './CorpStatus.module.scss';

const DEFAULT_EMOJI = '💬';
const HOUR = 60 * 60 * 1000;
const DAYS_IN_WEEK = 7;
const MAX_TEXT_LENGTH = 100;
const MAX_EMOJI_LENGTH = 32;
const DATE_TIME_LOCAL_LENGTH = 16;

type UntilOption = 'hour' | 'today' | 'week' | 'custom' | 'never';

// Custom status and "do not disturb" of a corp employee, next to the name in headers, profiles and member lists
export const CorpStatusBadge = ({ peerId }: { peerId?: string }) => {
  const lang = useLang();
  // Re-renders on status changes
  useDerivedState(getCorpStatuses);
  if (!peerId || !isCorpUserId(peerId) || isCorpMentionKeywordId(peerId)) return undefined;
  const status = getActiveCorpStatus(getEmployeeId(peerId));
  if (!status) return undefined;

  const title = [status.emoji, status.text, status.isDnd ? `(${lang('TeleTwinStatusDnd')})` : undefined]
    .filter(Boolean).join(' ');

  return (
    <span className={styles.badge} title={title} data-corp-status>
      {status.isDnd && <span className={styles.dnd}>⛔</span>}
      {status.emoji && <span>{status.emoji}</span>}
      {status.text && <span className={styles.text}>{status.text}</span>}
    </span>
  );
};

function getUntil(option: UntilOption, custom: string) {
  const now = new Date();
  switch (option) {
    case 'hour':
      return new Date(now.getTime() + HOUR);
    case 'today':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59);
    case 'week': {
      const daysToSunday = (DAYS_IN_WEEK - now.getDay()) % DAYS_IN_WEEK;
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToSunday, 23, 59);
    }
    case 'custom':
      return custom ? new Date(custom) : undefined;
    default:
      return undefined;
  }
}

function toLocalInputValue(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, DATE_TIME_LOCAL_LENGTH);
}

// "Holatim": emoji, text, until and "do not disturb" -> `PUT /me/status`
const CorpStatusModalComponent = () => {
  const lang = useLang();
  const isOpen = useDerivedState(getStatusModalOpen);
  const [emoji, setEmoji] = useState(DEFAULT_EMOJI);
  const [text, setText] = useState('');
  const [untilOption, setUntilOption] = useState<UntilOption>('today');
  const [customUntil, setCustomUntil] = useState('');
  const [isDnd, setIsDnd] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const ownId = corpEngine.employeeId;
    const current = ownId ? getActiveCorpStatus(ownId) : undefined;
    setEmoji(current?.emoji || DEFAULT_EMOJI);
    setText(current?.text || '');
    setIsDnd(Boolean(current?.isDnd));
    setUntilOption('today');
    setCustomUntil(toLocalInputValue(new Date(Date.now() + HOUR)));
  }, [isOpen]);

  const handleClose = useLastCallback(() => setStatusModalOpen(false));

  const save = useLastCallback(async (isClear: boolean) => {
    const credentials = corpEngine.credentials;
    if (!credentials) return;
    const until = getUntil(untilOption, customUntil);
    if (!isClear && until && until.getTime() <= Date.now()) return;
    const untilIso = until?.toISOString();
    const hasStatus = !isClear && Boolean(text.trim() || emoji.trim());

    setIsSaving(true);
    try {
      const profile = await putCorpStatus(credentials.server, credentials.token, isClear ? {} : {
        emoji: hasStatus ? emoji.trim() || undefined : undefined,
        text: hasStatus ? text.trim() || undefined : undefined,
        until: hasStatus ? untilIso : undefined,
        dndUntil: isDnd ? untilIso || getUntil('week', '')!.toISOString() : undefined,
      });
      setCorpStatus(credentials.employee.id, buildCorpStatus(profile));
      handleClose();
    } catch (err) {
      corpEngine.handleFailure(err);
    } finally {
      setIsSaving(false);
    }
  });

  const untilOptions = (['hour', 'today', 'week', 'custom', 'never'] as const).map((value) => ({
    value,
    label: lang(({
      hour: 'TeleTwinStatusUntilHour',
      today: 'TeleTwinStatusUntilToday',
      week: 'TeleTwinStatusUntilWeek',
      custom: 'TeleTwinStatusUntilCustom',
      never: 'TeleTwinStatusUntilNever',
    } as const)[value]),
  }));

  return (
    <Modal isOpen={isOpen} title={lang('TeleTwinMyStatus')} hasCloseButton onClose={handleClose}>
      <div className={styles.form} data-corp-status-modal>
        <div className={styles.row}>
          <InputText
            id="teletwin-status-emoji"
            className={styles.emoji}
            label={lang('TeleTwinStatusEmoji')}
            value={emoji}
            maxLength={MAX_EMOJI_LENGTH}
            onChange={(e) => setEmoji(e.currentTarget.value)}
          />
          <InputText
            id="teletwin-status-text"
            label={lang('TeleTwinStatusText')}
            value={text}
            maxLength={MAX_TEXT_LENGTH}
            onChange={(e) => setText(e.currentTarget.value)}
          />
        </div>
        <div className={styles.caption}>{lang('TeleTwinStatusUntil')}</div>
        <RadioGroup
          name="teletwin-status-until"
          options={untilOptions}
          selected={untilOption}
          onChange={(value) => setUntilOption(value as UntilOption)}
        />
        {untilOption === 'custom' && (
          <input
            id="teletwin-status-custom"
            className={styles.dateInput}
            type="datetime-local"
            value={customUntil}
            onChange={(e) => setCustomUntil(e.currentTarget.value)}
          />
        )}
        <Checkbox
          id="teletwin-status-dnd"
          label={`⛔ ${lang('TeleTwinStatusDnd')}`}
          checked={isDnd}
          onCheck={setIsDnd}
        />
        <div className={styles.buttons}>
          <Button isText onClick={() => void save(true)} disabled={isSaving}>
            {lang('TeleTwinStatusClear')}
          </Button>
          <Button onClick={() => void save(false)} isLoading={isSaving}>
            {lang('TeleTwinStatusSave')}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export const CorpStatusModal = memo(CorpStatusModalComponent);

// Wake-up of someone in "do not disturb": the server answered 409, the caller may insist
const CorpDndWakeUpConfirmComponent = () => {
  const lang = useLang();
  const pending = useDerivedState(getDndWakeUp);

  const handleClose = useLastCallback(() => setDndWakeUp(undefined));
  const handleConfirm = useLastCallback(() => {
    const target = getDndWakeUp();
    setDndWakeUp(undefined);
    if (target) void wakeUpEmployee(target.employeeId, target.serverChatId, target.name, true);
  });

  return (
    <ConfirmDialog
      isOpen={Boolean(pending)}
      title={lang('TeleTwinWakeUp')}
      text={pending ? lang('TeleTwinWakeUpDnd', { name: pending.name }) : undefined}
      confirmLabel={lang('TeleTwinWakeUpAnyway')}
      confirmHandler={handleConfirm}
      onClose={handleClose}
    />
  );
};

export const CorpDndWakeUpConfirm = memo(CorpDndWakeUpConfirmComponent);
