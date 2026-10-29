import { memo, useEffect } from '../../lib/teact/teact';

import type { IconName } from '../../types/icons';
import type { CorpActivityItem } from '../api';

import buildClassName from '../../util/buildClassName';
import {
  getActivityModalOpen, getActivitySeenAt, getCorpActivity, isCorpActivityUnread, loadCorpActivity,
  markCorpActivityRead, setActivityModalOpen,
} from '../activity';
import { corpEngine } from '../engine';
import { openCorpMessage } from '../saved';

import useDerivedState from '../../hooks/useDerivedState';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../../components/ui/Button';
import ListItem from '../../components/ui/ListItem';
import Modal from '../../components/ui/Modal';
import { formatShortDateTime } from './CorpSaved';

import styles from './CorpPanels.module.scss';

const PREVIEW_LENGTH = 120;

const ICONS: Record<string, IconName> = {
  mention: 'mention',
  thread_reply: 'comments',
  reaction: 'heart',
};

function getTitle(item: CorpActivityItem, lang: ReturnType<typeof useLang>) {
  const chatTitle = corpEngine.getChatInfo(item.chatId)?.title || '';
  const name = item.actorName;
  switch (item.type) {
    case 'mention':
      return lang('TeleTwinActivityMention', { name, chat: chatTitle });
    case 'thread_reply':
      return lang('TeleTwinActivityThreadReply', { name, chat: chatTitle });
    case 'reaction':
      return lang('TeleTwinActivityReaction', { name, chat: chatTitle, emoji: item.emoji || '' });
    default:
      return `${name} · ${chatTitle}`;
  }
}

// "Faollik": mentions, replies in my threads and reactions to my messages, newest first; click jumps to the message
const CorpActivityModalComponent = () => {
  const lang = useLang();
  const isOpen = useDerivedState(getActivityModalOpen);
  const items = useDerivedState(getCorpActivity);
  const seenAt = useDerivedState(getActivitySeenAt);

  useEffect(() => {
    if (isOpen) void loadCorpActivity();
  }, [isOpen]);

  const handleClose = useLastCallback(() => setActivityModalOpen(false));
  const handleOpen = useLastCallback((item: CorpActivityItem) => {
    handleClose();
    markCorpActivityRead();
    openCorpMessage(item.chatId, item.messageId, item.message?.threadRootId);
  });

  const hasUnread = Boolean(items?.some((item) => isCorpActivityUnread(item, seenAt)));

  return (
    <Modal isOpen={isOpen} title={lang('TeleTwinActivityTitle')} hasCloseButton onClose={handleClose}>
      <div className={styles.toolbar}>
        <Button isText size="smaller" disabled={!hasUnread} onClick={markCorpActivityRead}>
          {lang('TeleTwinActivityMarkRead')}
        </Button>
      </div>
      <div className={styles.list} data-corp-activity-list>
        {items && !items.length && <div className={styles.empty}>{lang('TeleTwinActivityEmpty')}</div>}
        {items?.map((item) => {
          const text = item.message?.text || '';
          const isUnread = isCorpActivityUnread(item, seenAt);
          return (
            <ListItem
              key={`${item.type}-${item.chatId}-${item.messageId}-${item.actorId}-${item.at}`}
              className={buildClassName(styles.item, isUnread && styles.unread)}
              multiline
              icon={ICONS[item.type] || 'message'}
              onClick={() => handleOpen(item)}
            >
              <span className="title">{getTitle(item, lang)}</span>
              <span className="subtitle" dir="auto">
                {`${formatShortDateTime(new Date(item.at))} · `}
                {text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text}
              </span>
            </ListItem>
          );
        })}
      </div>
    </Modal>
  );
};

export const CorpActivityModal = memo(CorpActivityModalComponent);
