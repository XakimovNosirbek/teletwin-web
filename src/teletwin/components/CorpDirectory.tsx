import { memo, useEffect, useState } from '../../lib/teact/teact';
import { getActions } from '../../global';

import type { CorpDirectoryChat } from '../api';

import { createSignal } from '../../util/signals';
import { CORP_CHAT_KIND_CHANNEL, fetchCorpDirectory, joinCorpChat } from '../api';
import { corpEngine } from '../engine';
import { buildCorpChatId } from '../ids';

import useDerivedState from '../../hooks/useDerivedState';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../../components/ui/Button';
import ListItem from '../../components/ui/ListItem';
import Modal from '../../components/ui/Modal';

import styles from './CorpPanels.module.scss';

const [getDirectoryOpen, setDirectoryOpen] = createSignal(false);

export { setDirectoryOpen };

// "Kanallar katalogi": public corp groups and channels I am not in, with "Qo'shilish" (`POST /chats/{id}/join`)
const CorpDirectoryModalComponent = () => {
  const lang = useLang();
  const isOpen = useDerivedState(getDirectoryOpen);
  const [chats, setChats] = useState<CorpDirectoryChat[] | undefined>();
  const [joinedIds, setJoinedIds] = useState<number[]>([]);
  const [joiningId, setJoiningId] = useState<number | undefined>();

  useEffect(() => {
    setChats(undefined);
    setJoinedIds([]);
    const credentials = corpEngine.credentials;
    if (!isOpen || !credentials) return undefined;
    let isActual = true;
    fetchCorpDirectory(credentials.server, credentials.token).then((list) => {
      if (isActual) setChats(list.filter((chat) => !chat.isMember));
    }, (err) => {
      corpEngine.handleFailure(err);
      if (isActual) setChats([]);
    });

    return () => {
      isActual = false;
    };
  }, [isOpen]);

  const handleClose = useLastCallback(() => setDirectoryOpen(false));

  const handleJoin = useLastCallback(async (chat: CorpDirectoryChat) => {
    const credentials = corpEngine.credentials;
    if (!credentials) return;
    setJoiningId(chat.id);
    try {
      await joinCorpChat(credentials.server, credentials.token, chat.id);
      setJoinedIds((ids) => [...ids, chat.id]);
      // The hub also sends `chats_changed`; loading here makes the chat appear without waiting for it
      await corpEngine.loadChats();
    } catch (err) {
      corpEngine.handleFailure(err);
      getActions().showNotification({ message: { key: 'TeleTwinErrorNetwork' } });
    } finally {
      setJoiningId(undefined);
    }
  });

  const handleOpen = useLastCallback((chat: CorpDirectoryChat) => {
    handleClose();
    getActions().openChat({ id: buildCorpChatId(chat.id), shouldReplaceHistory: true });
  });

  return (
    <Modal isOpen={isOpen} title={lang('TeleTwinDirectoryTitle')} hasCloseButton onClose={handleClose}>
      <div className={styles.list} data-corp-directory>
        {chats && !chats.length && <div className={styles.empty}>{lang('TeleTwinDirectoryEmpty')}</div>}
        {chats?.map((chat) => {
          const isJoined = joinedIds.includes(chat.id);
          const isChannel = chat.kind === CORP_CHAT_KIND_CHANNEL;
          return (
            <ListItem
              key={chat.id}
              className={styles.item}
              multiline
              icon={isChannel ? 'channel' : 'group'}
              isStatic
              rightElement={(
                <Button
                  className={styles.inlineButton}
                  size="smaller"
                  isText={isJoined}
                  isLoading={joiningId === chat.id}
                  onClick={() => (isJoined ? handleOpen(chat) : void handleJoin(chat))}
                >
                  {lang(isJoined ? 'TeleTwinOpen' : 'TeleTwinDirectoryJoin')}
                </Button>
              )}
            >
              <span className="title" dir="auto">{chat.title}</span>
              <span className="subtitle" dir="auto">
                {[
                  lang(isChannel ? 'TeleTwinDirectorySubscribers' : 'TeleTwinDirectoryMembers', {
                    count: chat.memberCount,
                  }),
                  chat.description,
                ].filter(Boolean).join(' · ')}
              </span>
            </ListItem>
          );
        })}
      </div>
    </Modal>
  );
};

export const CorpDirectoryModal = memo(CorpDirectoryModalComponent);
