import { memo, useEffect, useState } from '../../lib/teact/teact';

import type { ApiMessage } from '../../api/types';
import type { CorpSavedItem } from '../api';

import { corpEngine } from '../engine';
import { getServerChatId, isCorpChatId } from '../ids';
import {
  findCorpSavedItem, getCorpSavedItems, getReminderTarget, getSavedModalOpen, loadCorpSaved, markCorpSavedDone,
  openCorpMessage, removeCorpSavedItem, saveCorpMessageItem, setReminderTarget, setSavedModalOpen,
} from '../saved';

import useDerivedState from '../../hooks/useDerivedState';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../../components/ui/Button';
import ListItem from '../../components/ui/ListItem';
import MenuItem from '../../components/ui/MenuItem';
import Modal from '../../components/ui/Modal';

import styles from './CorpPanels.module.scss';

const MINUTE = 60 * 1000;
const PREVIEW_LENGTH = 140;
const DATE_TIME_LOCAL_LENGTH = 16;
const TOMORROW_HOUR = 9;

type ReminderOption = 'min20' | 'hour1' | 'hour3' | 'tomorrow';

const REMINDER_OPTIONS: { value: ReminderOption; key: 'TeleTwinRemind20m' | 'TeleTwinRemind1h' | 'TeleTwinRemind3h'
  | 'TeleTwinRemindTomorrow'; }[] = [
  { value: 'min20', key: 'TeleTwinRemind20m' },
  { value: 'hour1', key: 'TeleTwinRemind1h' },
  { value: 'hour3', key: 'TeleTwinRemind3h' },
  { value: 'tomorrow', key: 'TeleTwinRemindTomorrow' },
];

function getReminderTime(option: ReminderOption) {
  const now = new Date();
  switch (option) {
    case 'min20':
      return new Date(now.getTime() + 20 * MINUTE);
    case 'hour1':
      return new Date(now.getTime() + 60 * MINUTE);
    case 'hour3':
      return new Date(now.getTime() + 180 * MINUTE);
    default:
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, TOMORROW_HOUR, 0);
  }
}

export function formatShortDateTime(date: Date) {
  return date.toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function toLocalInputValue(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * MINUTE).toISOString().slice(0, DATE_TIME_LOCAL_LENGTH);
}

// Saved corp messages are main history or thread messages with server ids
function isSavableMessage(message: ApiMessage) {
  return isCorpChatId(message.chatId) && !message.isScheduled && Number.isInteger(message.id) && message.id > 0;
}

type MenuProps = { message: ApiMessage; onClose: NoneToVoidFunction };

// Message context menu: "Saqlash" / "Saqlanganlardan olib tashlash" and "Eslatma qo'yish"
export const CorpSaveMessageItems = ({ message, onClose }: MenuProps) => {
  const lang = useLang();
  useDerivedState(getCorpSavedItems);

  const handleSave = useLastCallback(() => {
    onClose();
    const saved = findCorpSavedItem(getServerChatId(message.chatId), message.id);
    if (saved) {
      void removeCorpSavedItem(saved.id);
    } else {
      void saveCorpMessageItem(message.id);
    }
  });

  const handleRemind = useLastCallback(() => {
    onClose();
    setReminderTarget({ chatId: getServerChatId(message.chatId), messageId: message.id });
  });

  if (!isSavableMessage(message)) return undefined;
  const isSaved = Boolean(findCorpSavedItem(getServerChatId(message.chatId), message.id));

  return (
    <>
      <MenuItem icon={isSaved ? 'saved-messages-filled' : 'saved-messages'} onClick={handleSave}>
        {lang(isSaved ? 'TeleTwinUnsave' : 'TeleTwinSave')}
      </MenuItem>
      <MenuItem icon="schedule" onClick={handleRemind}>{lang('TeleTwinRemind')}</MenuItem>
    </>
  );
};

// "Eslatma qo'yish": 20 min / 1 h / 3 h / tomorrow 09:00 / custom
const CorpReminderPickerComponent = () => {
  const lang = useLang();
  const target = useDerivedState(getReminderTarget);
  const [custom, setCustom] = useState('');

  useEffect(() => {
    if (target) setCustom(toLocalInputValue(new Date(Date.now() + 60 * MINUTE)));
  }, [target]);

  const handleClose = useLastCallback(() => setReminderTarget(undefined));
  const remindAt = useLastCallback((date: Date) => {
    const current = getReminderTarget();
    setReminderTarget(undefined);
    if (current && date.getTime() > Date.now()) void saveCorpMessageItem(current.messageId, date);
  });

  const customDate = custom ? new Date(custom) : undefined;
  const isCustomValid = Boolean(customDate && !Number.isNaN(customDate.getTime()));

  return (
    <Modal isOpen={Boolean(target)} title={lang('TeleTwinRemind')} hasCloseButton onClose={handleClose}>
      <div data-corp-reminder-picker>
        {REMINDER_OPTIONS.map(({ value, key }) => (
          <ListItem key={value} icon="schedule" onClick={() => remindAt(getReminderTime(value))}>
            {lang(key)}
          </ListItem>
        ))}
        <div className={styles.customRow}>
          <input
            id="teletwin-reminder-custom"
            className={styles.dateInput}
            type="datetime-local"
            value={custom}
            onChange={(e) => setCustom(e.currentTarget.value)}
          />
          <Button className={styles.inlineButton} disabled={!isCustomValid} onClick={() => remindAt(customDate!)}>
            {lang('TeleTwinRemindCustom')}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export const CorpReminderPicker = memo(CorpReminderPickerComponent);

function getItemPreview(item: CorpSavedItem, lang: ReturnType<typeof useLang>) {
  const message = item.message;
  if (!message) return lang('TeleTwinSavedDeleted');
  const text = message.text || (message.media ? `📎 ${message.media.fileName || ''}` : '');
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text;
}

// "Saqlanganlar": saved corp messages with their reminders, click jumps to the message
const CorpSavedModalComponent = () => {
  const lang = useLang();
  const isOpen = useDerivedState(getSavedModalOpen);
  const items = useDerivedState(getCorpSavedItems);

  useEffect(() => {
    if (isOpen) void loadCorpSaved();
  }, [isOpen]);

  const handleClose = useLastCallback(() => setSavedModalOpen(false));
  const handleOpen = useLastCallback((item: CorpSavedItem) => {
    if (!item.message) return;
    handleClose();
    openCorpMessage(item.chatId, item.messageId, item.message.threadRootId);
  });

  return (
    <Modal isOpen={isOpen} title={lang('TeleTwinSavedTitle')} hasCloseButton onClose={handleClose}>
      <div className={styles.list} data-corp-saved-list>
        {items && !items.length && <div className={styles.empty}>{lang('TeleTwinSavedEmpty')}</div>}
        {items?.map((item) => {
          const chatTitle = corpEngine.getChatInfo(item.chatId)?.title || '';
          const remindAt = item.remindAt && !item.remindedAt ? new Date(item.remindAt) : undefined;
          return (
            <ListItem
              key={item.id}
              className={styles.item}
              multiline
              icon={remindAt ? 'schedule' : 'saved-messages'}
              secondaryIcon="close"
              onSecondaryIconClick={() => void (remindAt ? markCorpSavedDone(item.id) : removeCorpSavedItem(item.id))}
              onClick={() => handleOpen(item)}
            >
              <span className="title">
                {[item.message?.senderName, chatTitle].filter(Boolean).join(' · ')}
              </span>
              <span className="subtitle" dir="auto">
                {remindAt && `⏰ ${formatShortDateTime(remindAt)} · `}
                {getItemPreview(item, lang)}
              </span>
            </ListItem>
          );
        })}
      </div>
    </Modal>
  );
};

export const CorpSavedModal = memo(CorpSavedModalComponent);
