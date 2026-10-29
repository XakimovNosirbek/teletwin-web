import { getActions, getGlobal } from '../../global';

import type { ApiMessage } from '../../api/types';
import type { MessageListType, ThreadId } from '../../types';
import { MAIN_THREAD_ID } from '../../api/types';

import { isCorpChatId, isCorpThreadOnlyMessage } from '../ids';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import MenuItem from '../../components/ui/MenuItem';

type OwnProps = {
  message: ApiMessage;
  threadId: ThreadId;
  messageListType: MessageListType;
  onClose: NoneToVoidFunction;
};

// Message context menu of corp groups: opens the stock thread view of a message, also before its first reply
export const CorpReplyInThreadItem = ({
  message, threadId, messageListType, onClose,
}: OwnProps) => {
  const lang = useLang();
  const { chatId, id } = message;

  const handleClick = useLastCallback(() => {
    onClose();
    getActions().openThread({ chatId, threadId: id });
  });

  if (!isCorpChatId(chatId) || messageListType !== 'thread' || threadId !== MAIN_THREAD_ID
    || message.isScheduled || !Number.isInteger(id) || isCorpThreadOnlyMessage(message)
    || getGlobal().chats.byId[chatId]?.type !== 'chatTypeSuperGroup') {
    return undefined;
  }

  return (
    <MenuItem icon="reply" onClick={handleClick}>{lang('TeleTwinReplyInThread')}</MenuItem>
  );
};
