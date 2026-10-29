import { getActions, getGlobal } from '../../global';

import type { ApiMessage } from '../../api/types';
import type { MessageListType, ThreadId } from '../../types';
import { MAIN_THREAD_ID } from '../../api/types';

import { isCorpChatId, isCorpThreadOnlyMessage } from '../ids';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import MenuItem from '../../components/ui/MenuItem';

// Corp groups and channels: any member may reply in a thread, also in channels (like channel comments)
const CORP_THREAD_CHAT_TYPES = new Set<string | undefined>(['chatTypeSuperGroup', 'chatTypeChannel']);

type OwnProps = {
  message: ApiMessage;
  threadId: ThreadId;
  messageListType: MessageListType;
  onClose: NoneToVoidFunction;
};

// Message context menu of corp groups and channels: opens the stock thread view of a message, also before its first reply
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
    || !CORP_THREAD_CHAT_TYPES.has(getGlobal().chats.byId[chatId]?.type)) {
    return undefined;
  }

  return (
    <MenuItem icon="reply" onClick={handleClick}>{lang('TeleTwinReplyInThread')}</MenuItem>
  );
};
