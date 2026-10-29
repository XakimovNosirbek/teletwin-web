import { getActions, getGlobal } from '../global';

import type {
  ApiChat, ApiInputRichMessage, ApiMessage, ApiTopicWithState,
} from '../api/types';
import type { GlobalState } from '../global/types';
import type { CorpChatInfo } from './api';

import { LOCAL_MESSAGES_LIMIT } from '../config';
import { selectChatLastMessageId, selectChatMessages } from '../global/selectors';
import { getServerTime } from '../util/serverTime';
import { getRichInputAsFormatted } from '../components/ui/textInput/richText';
import {
  CORP_CHAT_KIND_CHANNEL, CORP_CHAT_KIND_GROUP, CorpApiError, isCorpUnauthorized, sendCorpMessage,
} from './api';
import { corpEngine, publishCorpMessage } from './engine';
import { getServerChatId } from './ids';

const RE_TRAILING_SPACE = /\s+$/;

let localMessageCounter = 0;

// Replaces `fetchMessages` for corp chats: the whole loaded history is already in global state, so the slice is cut
// locally with the semantics of `messages.getHistory` (`offsetId` excluded, negative `addOffset` reaches newer ids)
export function fetchCorpViewportMessages(
  global: GlobalState, chatId: string, offsetId: number | undefined, addOffset: number | undefined, limit: number,
) {
  const byId = selectChatMessages(global, chatId) || {};
  const ids = Object.keys(byId).map(Number).filter(Number.isInteger).sort((a, b) => b - a);
  let start = offsetId ? ids.findIndex((id) => id < offsetId) : 0;
  if (start === -1) start = ids.length;
  start = Math.max(0, start + (addOffset || 0));

  const sliceIds = ids.slice(start, start + limit);
  if (start + limit >= ids.length) corpEngine.loadOlder(getServerChatId(chatId));

  return {
    messages: sliceIds.map((id) => byId[id]),
    count: ids.length,
    topics: [] as ApiTopicWithState[],
  };
}

// Replaces `sendMessage` for corp chats: text only, posted to the TeleTwin server, never to Telegram
export function sendCorpText(chatId: string, payload: { text?: string; richMessage?: ApiInputRichMessage }) {
  const credentials = corpEngine.credentials;
  const raw = payload.text ?? (payload.richMessage ? getRichInputAsFormatted(payload.richMessage)?.text : undefined);
  const text = raw?.replace(RE_TRAILING_SPACE, '');
  if (!credentials || !text?.trim()) return;

  const global = getGlobal();
  const lastId = Math.floor(selectChatLastMessageId(global, chatId) || 0);
  const localId = lastId + (++localMessageCounter / LOCAL_MESSAGES_LIMIT);
  const message: ApiMessage = {
    id: localId,
    chatId,
    date: getServerTime(),
    isOutgoing: true,
    senderId: global.currentUserId,
    content: { text: { text } },
    sendingState: 'messageSendingStatePending',
  };
  const actions = getActions();
  actions.apiUpdate({
    '@type': 'newMessage', chatId, id: localId, message,
  });

  void postCorpText(chatId, localId, text);
}

async function postCorpText(chatId: string, localId: number, text: string) {
  const credentials = corpEngine.credentials!;
  const serverChatId = getServerChatId(chatId);

  try {
    const dto = await sendCorpMessage(credentials.server, credentials.token, serverChatId, text);
    if (corpEngine.credentials?.token !== credentials.token) return;

    // Both paths turn the pending bubble into the real message unless the hub echo already did (dedupe by id)
    if (corpEngine.hasSession) {
      corpEngine.applyLive(dto, localId);
    } else {
      const chat = getGlobal().chats.byId[chatId];
      if (chat) publishCorpMessage(dto, buildCorpChatInfo(serverChatId, chat), credentials.employee.id, localId);
    }
  } catch (err) {
    if (corpEngine.credentials?.token !== credentials.token) return;
    if (isCorpUnauthorized(err)) {
      corpEngine.revoke();
      return;
    }

    getActions().apiUpdate({
      '@type': 'updateMessageSendFailed', chatId, localId, error: err instanceof Error ? err.message : 'network',
    });
    // A 403 means the posting rights changed
    if (err instanceof CorpApiError && err.kind === 'forbidden') void corpEngine.loadChats();
  }
}

function buildCorpChatInfo(serverChatId: number, chat: ApiChat): CorpChatInfo {
  return {
    id: serverChatId,
    title: chat.title,
    kind: chat.type === 'chatTypeChannel' ? CORP_CHAT_KIND_CHANNEL : CORP_CHAT_KIND_GROUP,
    canPost: true,
  };
}
