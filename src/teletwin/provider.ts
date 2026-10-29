// Answers Telegram API calls that reference corp chats from the TeleTwin server. `callApi` routes a call here when its
// arguments reference a corp entity (see `guard.ts`); each method returns what the GramJS method of the same name
// returns and emits the same `apiUpdate`s, so stock actions and components work unchanged.
// Methods missing here stay blocked: corp data never reaches the GramJS worker.
import { getActions, getGlobal, setGlobal } from '../global';

import type { MethodArgs, Methods } from '../api/gramjs/methods/types';
import type {
  ApiAttachment, ApiChat, ApiChatMember, ApiMessage, ApiMessageEntity, ApiMessagePoll, ApiNewPoll, ApiOnProgress,
  ApiPeer, ApiReaction, ApiSendMessageAction, ApiSticker, ApiVideo, MediaContent,
} from '../api/types';
import type { ForwardMessagesParams, SendMessageParams } from '../types';
import type {
  CorpMediaKind, CorpMessage, CorpNewPoll, CorpScheduledMessage,
} from './api';
import { MAIN_THREAD_ID } from '../api/types';

import {
  GIF_MIME_TYPE, LOCAL_MESSAGES_LIMIT, SUPPORTED_AUDIO_CONTENT_TYPES, SUPPORTED_PHOTO_CONTENT_TYPES,
  SUPPORTED_VIDEO_CONTENT_TYPES,
} from '../config';
import { getMediaHash } from '../global/helpers/messageMedia';
import { updateUsers } from '../global/reducers';
import {
  selectChatLastMessageId, selectChatMessage, selectPinnedIds, selectPollFromMessage,
} from '../global/selectors';
import { selectMessageDownloadableMedia } from '../global/selectors/media';
import buildUploadingMedia from '../util/buildUploadingMedia';
import { getMessageKey } from '../util/keys/messageKey';
import { getServerTime } from '../util/serverTime';
import { getRichInputAsFormatted } from '../components/ui/textInput/richText';
import {
  closeCorpPoll, CorpApiError, createCorpScheduled, deleteCorpMessages, deleteCorpScheduled, editCorpMessage,
  editCorpScheduled, fetchCorpMembers, fetchCorpMessages, fetchCorpScheduled, fetchCorpUnreadMentions,
  forwardCorpMessages, readCorpChat, readCorpMentions, sendCorpMessage, sendCorpScheduledNow, sendCorpTyping,
  setCorpPin, setCorpReaction, uploadCorpFile, voteCorpPoll,
} from './api';
import { corpEngine } from './engine';
import {
  buildCorpUserId, getCorpPollServerId, getServerChatId, isCorpChatId,
} from './ids';
import { downloadCorpMedia, fetchMediaBlob } from './media';
import {
  buildCorpEntities, buildCorpScheduledMessage, buildCorpText, buildCorpUser, encodeWaveform,
} from './state';

const SEARCH_LIMIT_MAX = 200;
const RE_TRAILING_SPACE = /\s+$/;
const TYPING_ACTIONS: Partial<Record<ApiSendMessageAction['type'], string>> = {
  typing: 'typing',
  recordAudio: 'recordVoice',
  recordRound: 'recordRound',
  chooseSticker: 'chooseSticker',
};

type CorpMethods = {
  [K in keyof Methods]?: (...args: MethodArgs<K>) => Promise<unknown>;
};

let localMessageCounter = 0;

export const corpMethods: CorpMethods = {
  fetchMessages,
  fetchMessage,
  fetchMessagesById,
  fetchPinnedMessages,
  sendMessage,
  forwardMessages,
  editMessage,
  deleteMessages,
  sendReaction,
  pinMessage,
  unpinAllMessages,
  markMessageListRead,
  markMessagesRead,
  fetchUnreadMentions,
  sendMessageAction,
  searchMessagesInChat,
  fetchFullChat,
  fetchMembers,
  sendPollVote,
  closePoll,
  loadPollOptionResults,
  fetchScheduledHistory,
  sendScheduledMessages,
  rescheduleMessage,
  deleteScheduledMessages,
  downloadMedia: downloadCorpMedia,
};

export function callCorpMethod(fnName: string, args: unknown[]) {
  const method = corpMethods[fnName as keyof Methods] as ((...methodArgs: unknown[]) => Promise<unknown>) | undefined;
  if (!method || !corpEngine.credentials) return undefined;

  return method(...args).catch((err: unknown) => {
    corpEngine.handleFailure(err);
    throw err;
  });
}

// ---- history ----

async function fetchMessages({
  chat, offsetId, addOffset, limit,
}: { chat: ApiChat; offsetId?: number; addOffset?: number; limit: number }) {
  const serverChatId = getServerChatId(chat.id);
  const credentials = corpEngine.credentials!;
  const newerCount = offsetId ? Math.min(limit, Math.max(0, -(addOffset ?? 0))) : 0;
  const olderCount = limit - newerCount;

  const [older, newer] = await Promise.all([
    olderCount > 0 ? fetchCorpMessages(credentials.server, credentials.token, serverChatId, {
      beforeId: offsetId, limit: olderCount,
    }) : [],
    newerCount > 0 ? fetchCorpMessages(credentials.server, credentials.token, serverChatId, {
      afterId: offsetId! - 1, limit: newerCount,
    }) : [],
  ]);
  const list = [...older, ...newer];
  corpEngine.mergeFetched(serverChatId, list, offsetId);

  return {
    messages: buildMessages(list),
    users: [],
    chats: [],
    count: list.length,
    topics: [],
  };
}

async function fetchMessage({ chat, messageId }: { chat: ApiChat; messageId: number }) {
  const message = (await fetchCorpMessagesByIds(chat, [messageId]))[0];
  return message ? { message } : undefined;
}

function fetchMessagesById({ chat, messageIds }: { chat: ApiChat; messageIds: number[] }) {
  return fetchCorpMessagesByIds(chat, messageIds);
}

async function fetchPinnedMessages({ chat }: { chat: ApiChat; threadId: unknown }) {
  const serverChatId = getServerChatId(chat.id);
  const pinnedIds = corpEngine.getChatInfo(serverChatId)?.pinnedIds
    || selectPinnedIds(getGlobal(), chat.id, MAIN_THREAD_ID) || [];

  return { messages: await fetchCorpMessagesByIds(chat, pinnedIds) };
}

// The API has no "by id" lookup: `afterId = id - 1, limit = 1` returns the message itself when it exists
async function fetchCorpMessagesByIds(chat: ApiChat, messageIds: number[]) {
  const serverChatId = getServerChatId(chat.id);
  const credentials = corpEngine.credentials!;
  const cached = corpEngine.getCachedMessages(serverChatId) || [];

  const list = await Promise.all(messageIds.map(async (id) => {
    const known = cached.find((dto) => dto.id === id);
    if (known) return known;
    const [dto] = await fetchCorpMessages(credentials.server, credentials.token, serverChatId, {
      afterId: id - 1, limit: 1,
    });
    return dto?.id === id ? dto : undefined;
  }));

  return buildMessages(list.filter(Boolean));
}

async function searchMessagesInChat({
  peer, query, type, offsetId, limit,
}: { peer: ApiPeer; query?: string; type?: string; offsetId?: number; limit: number }) {
  const isTextSearch = !type || type === 'text';
  if (!isTextSearch || !query) {
    return {
      messages: [], topics: [], userStatusesById: {}, totalCount: 0,
    };
  }

  const credentials = corpEngine.credentials!;
  const list = await fetchCorpMessages(credentials.server, credentials.token, getServerChatId(peer.id), {
    beforeId: offsetId || undefined, limit: Math.min(limit, SEARCH_LIMIT_MAX), query,
  });
  const messages = buildMessages(list).reverse();

  return {
    messages,
    topics: [],
    userStatusesById: {},
    totalCount: messages.length < limit ? messages.length : messages.length + 1,
    nextOffsetId: messages.length >= limit ? messages[messages.length - 1].id : undefined,
  };
}

function buildMessages(list: CorpMessage[]) {
  corpEngine.publishEntities(list);
  return list.map((dto) => corpEngine.buildMessage(dto)).filter(Boolean);
}

// ---- sending ----

async function sendMessage(params: SendMessageParams, onProgress?: ApiOnProgress) {
  const { chat } = params;
  if (!chat || params.todo || params.contact || params.story) {
    return undefined;
  }
  if (params.scheduledAt) return scheduleMessage(chat, params, params.scheduledAt);
  if (params.poll) return sendPoll(chat, params.poll, params);

  const { text, entities } = getOutgoingText(params);
  const media = getOutgoingMedia(params);
  if (!text && !media) return undefined;

  const localMessage = buildLocalMessage(chat, params, text, entities, media);
  const actions = getActions();
  actions.apiUpdate({
    '@type': 'newMessage', chatId: chat.id, id: localMessage.id, message: localMessage, wasDrafted: params.wasDrafted,
  });

  const clientId = `web-${Date.now().toString(36)}-${localMessage.id}`;
  corpEngine.registerPending(clientId, localMessage.id);
  const credentials = corpEngine.credentials!;
  const serverChatId = getServerChatId(chat.id);

  try {
    const patchedOnProgress = onProgress && ((progress: number) => {
      if (onProgress.isCanceled) return true;
      onProgress(progress, getMessageKey(localMessage));
      return false;
    });
    const fileId = await uploadOutgoingMedia(params, patchedOnProgress);
    const dto = await sendCorpMessage(credentials.server, credentials.token, serverChatId, {
      text: text || '',
      entities: buildCorpEntities(entities),
      replyToId: params.replyInfo?.type === 'message' ? params.replyInfo.replyToMsgId : undefined,
      fileId,
      clientId,
    });
    if (corpEngine.credentials?.token !== credentials.token) return undefined;
    corpEngine.applyLive(dto, localMessage.id);
    return localMessage;
  } catch (err) {
    corpEngine.forgetPending(clientId);
    if (corpEngine.credentials?.token !== credentials.token) return undefined;
    if (!(err instanceof CorpApiError && err.kind === 'canceled')) {
      actions.apiUpdate({
        '@type': 'updateMessageSendFailed',
        chatId: chat.id,
        localId: localMessage.id,
        error: err instanceof Error ? err.message : 'network',
      });
    }
    // A 403 means the posting rights changed
    if (err instanceof CorpApiError && err.kind === 'forbidden') void corpEngine.loadChats();
    corpEngine.handleFailure(err);
    return undefined;
  }
}

// No pending bubble: a poll appears once the server has it
async function sendPoll(chat: ApiChat, poll: ApiNewPoll, params: SendMessageParams) {
  const credentials = corpEngine.credentials!;
  const dto = await sendCorpMessage(credentials.server, credentials.token, getServerChatId(chat.id), {
    text: '',
    replyToId: params.replyInfo?.type === 'message' ? params.replyInfo.replyToMsgId : undefined,
    poll: buildCorpNewPoll(poll),
    clientId: `web-${Date.now().toString(36)}-poll`,
  });
  corpEngine.applyLive(dto);
  return corpEngine.buildMessage(dto);
}

// The server keeps scheduled messages; the bubble appears in the scheduled list once it has them
async function scheduleMessage(chat: ApiChat, params: SendMessageParams, scheduledAt: number) {
  const { text, entities } = getOutgoingText(params);
  const hasMedia = Boolean(getOutgoingMedia(params));
  if (!text && !hasMedia && !params.poll) return undefined;

  const credentials = corpEngine.credentials!;
  const fileId = hasMedia ? await uploadOutgoingMedia(params) : undefined;
  const { replyToId, threadRootId } = getOutgoingReply(params);
  const dto = await createCorpScheduled(credentials.server, credentials.token, getServerChatId(chat.id), {
    sendAt: new Date(scheduledAt * 1000).toISOString(),
    text: text || '',
    entities: buildCorpEntities(entities),
    replyToId,
    threadRootId,
    fileId,
    poll: params.poll ? buildCorpNewPoll(params.poll) : undefined,
  });

  const message = buildScheduled(chat, dto);
  getActions().apiUpdate({
    '@type': 'newScheduledMessage', chatId: chat.id, id: message.id, message, wasDrafted: params.wasDrafted,
  });
  return message;
}

function buildScheduled(chat: ApiChat, dto: CorpScheduledMessage) {
  return buildCorpScheduledMessage(dto, chat.id, getGlobal().currentUserId!, corpEngine.linkRule);
}

// Inside a thread the stock reply info names the thread root as `replyToTopId`
function getOutgoingReply(params: SendMessageParams) {
  const replyInfo = params.replyInfo?.type === 'message' ? params.replyInfo : undefined;
  const threadRootId = replyInfo?.replyToTopId || undefined;
  const replyToMsgId = replyInfo?.replyToMsgId;

  return { threadRootId, replyToId: replyToMsgId && replyToMsgId !== threadRootId ? replyToMsgId : undefined };
}

function buildCorpNewPoll({ summary }: ApiNewPoll): CorpNewPoll {
  return {
    question: summary.question.text,
    options: summary.answers.map(({ text }) => text.text),
    isAnonymous: !summary.isPublic,
    isMultiple: Boolean(summary.isMultipleChoice),
    closesAt: summary.closeDate ? new Date(summary.closeDate * 1000).toISOString() : undefined,
  };
}

function getOutgoingText(params: SendMessageParams) {
  const formatted = params.richMessage ? getRichInputAsFormatted(params.richMessage) : undefined;
  const rawText = formatted?.text ?? params.text;
  const text = rawText?.replace(RE_TRAILING_SPACE, '');
  const rawEntities = formatted?.entities ?? params.entities;
  const entities = text ? rawEntities?.filter((entity) => entity.offset + entity.length <= text.length) : undefined;

  return { text: text?.trim() ? text : undefined, entities };
}

type OutgoingMedia = { content: MediaContent; kind: CorpMediaKind };

function getOutgoingMedia({ attachment, sticker, gif }: SendMessageParams): OutgoingMedia | undefined {
  if (sticker) return { content: { sticker }, kind: 'sticker' };
  if (gif) return { content: { video: gif }, kind: 'gif' };
  if (!attachment) return undefined;
  if (attachment.gif) return { content: { video: attachment.gif }, kind: 'gif' };

  return { content: buildUploadingMedia(attachment), kind: getAttachmentKind(attachment) };
}

function getAttachmentKind(attachment: ApiAttachment): CorpMediaKind {
  const {
    mimeType, quick, voice, isRoundVideo, shouldSendAsFile,
  } = attachment;
  if (shouldSendAsFile) return 'document';
  if (voice) return 'voice';
  if (isRoundVideo) return 'roundVideo';
  if (quick && SUPPORTED_PHOTO_CONTENT_TYPES.has(mimeType)) return 'photo';
  if (quick && SUPPORTED_VIDEO_CONTENT_TYPES.has(mimeType)) return mimeType === GIF_MIME_TYPE ? 'photo' : 'video';
  if (SUPPORTED_AUDIO_CONTENT_TYPES.has(mimeType)) return 'audio';
  return 'document';
}

function buildLocalMessage(
  chat: ApiChat,
  params: SendMessageParams,
  text: string | undefined,
  entities: ApiMessageEntity[] | undefined,
  media: OutgoingMedia | undefined,
): ApiMessage {
  const global = getGlobal();
  const lastId = Math.floor(params.lastMessageId || selectChatLastMessageId(global, chat.id) || 0);
  const replyToMsgId = params.replyInfo?.type === 'message' ? params.replyInfo.replyToMsgId : undefined;

  return {
    id: lastId + (++localMessageCounter / LOCAL_MESSAGES_LIMIT),
    chatId: chat.id,
    date: getServerTime(),
    isOutgoing: true,
    senderId: global.currentUserId,
    content: {
      text: text ? buildCorpText(text, buildCorpEntities(entities), corpEngine.linkRule) : undefined,
      ...media?.content,
    },
    replyInfo: replyToMsgId ? { type: 'message', replyToMsgId } : undefined,
    groupedId: params.groupedId,
    isForwardingAllowed: true,
    sendingState: 'messageSendingStatePending',
  };
}

async function uploadOutgoingMedia(params: SendMessageParams, onProgress?: (progress: number) => boolean) {
  const { attachment, sticker, gif } = params;
  if (sticker) return uploadTelegramSticker(sticker, onProgress);
  const telegramGif = gif || attachment?.gif;
  if (telegramGif) return uploadTelegramGif(telegramGif, onProgress);
  if (!attachment) return undefined;

  const kind = getAttachmentKind(attachment);
  const credentials = corpEngine.credentials!;
  const blob = attachment.blob || await (await fetch(attachment.blobUrl)).blob();
  const thumbFileId = attachment.previewBlobUrl && (kind === 'video' || kind === 'roundVideo')
    ? await uploadBlobUrl(attachment.previewBlobUrl, 'thumb.jpg')
    : undefined;
  const { quick, voice, audio } = attachment;

  const result = await uploadCorpFile(credentials.server, credentials.token, blob, attachment.filename, kind, {
    width: quick?.width,
    height: quick?.height,
    duration: voice?.duration ?? audio?.duration ?? quick?.duration,
    waveform: voice ? encodeWaveform(voice.waveform) : undefined,
    thumbFileId,
  }, onProgress);

  return result.fileId;
}

async function uploadBlobUrl(blobUrl: string, fileName: string) {
  const credentials = corpEngine.credentials!;
  const blob = await (await fetch(blobUrl)).blob();
  const result = await uploadCorpFile(credentials.server, credentials.token, blob, fileName, 'photo', {});
  return result.fileId;
}

async function uploadTelegramSticker(sticker: ApiSticker, onProgress?: (progress: number) => boolean) {
  const blob = await fetchMediaBlob(getMediaHash(sticker, 'inline')!);
  if (!blob) throw new CorpApiError('network');
  const credentials = corpEngine.credentials!;
  const extension = sticker.isLottie ? 'tgs' : sticker.isVideo ? 'webm' : 'webp';
  const result = await uploadCorpFile(credentials.server, credentials.token, blob, `sticker.${extension}`, 'sticker', {
    width: sticker.width,
    height: sticker.height,
  }, onProgress);
  return result.fileId;
}

async function uploadTelegramGif(gif: ApiVideo, onProgress?: (progress: number) => boolean) {
  const blob = await fetchMediaBlob(getMediaHash(gif, 'download')!);
  if (!blob) throw new CorpApiError('network');
  const credentials = corpEngine.credentials!;
  const result = await uploadCorpFile(credentials.server, credentials.token, blob, gif.fileName || 'gif.mp4', 'gif', {
    width: gif.width,
    height: gif.height,
    duration: gif.duration,
  }, onProgress);
  return result.fileId;
}

// Forwarding inside the corp server keeps the origin; Telegram messages enter as copies with their media
// re-uploaded. Corp messages never leave for Telegram.
async function forwardMessages(params: ForwardMessagesParams) {
  const { fromChat, toChat, messages } = params;
  const actions = getActions();
  if (!isCorpChatId(toChat.id)) {
    Object.values(getGlobal().byTabId).forEach(({ id: tabId }) => {
      actions.showNotification({ message: { key: 'TeleTwinForwardOutBlocked' }, tabId });
    });
    return;
  }

  const credentials = corpEngine.credentials!;
  const serverChatId = getServerChatId(toChat.id);
  if (isCorpChatId(fromChat.id)) {
    const list = await forwardCorpMessages(
      credentials.server, credentials.token, serverChatId, getServerChatId(fromChat.id), messages.map(({ id }) => id),
    );
    list.forEach((dto) => corpEngine.applyLive(dto));
    return;
  }

  for (const message of messages) {
    await sendMessage({
      chat: toChat,
      text: message.content.text?.text,
      entities: message.content.text?.entities,
      attachment: await buildForwardAttachment(message),
      sticker: message.content.sticker,
    });
  }
}

async function buildForwardAttachment(message: ApiMessage): Promise<ApiAttachment | undefined> {
  if (message.content.sticker) return undefined;
  const media = selectMessageDownloadableMedia(getGlobal(), message);
  if (!media) return undefined;

  const blob = await fetchMediaBlob(getMediaHash(media, 'download')!);
  if (!blob) return undefined;
  const { photo, video, voice, audio } = message.content;
  const mimeType = blob.type || ('mimeType' in media ? media.mimeType : '') || 'application/octet-stream';
  const fileName = 'fileName' in media && media.fileName ? media.fileName : `file.${mimeType.split('/')[1] || 'bin'}`;
  const photoSize = photo?.sizes[photo.sizes.length - 1];
  const width = photoSize?.width ?? video?.width;
  const height = photoSize?.height ?? video?.height;

  return {
    blob,
    blobUrl: URL.createObjectURL(blob),
    filename: fileName,
    mimeType,
    size: blob.size,
    uniqueId: `${message.chatId}-${message.id}`,
    quick: (photo || video) && width && height ? { width, height, duration: video?.duration } : undefined,
    voice: voice ? { duration: voice.duration, waveform: voice.waveform || [] } : undefined,
    audio: audio ? { duration: audio.duration, title: audio.title, performer: audio.performer } : undefined,
    isRoundVideo: video?.isRound,
  };
}

async function editMessage({
  chat, message, text, entities, attachment,
}: { chat: ApiChat; message: ApiMessage; text: string; entities?: ApiMessageEntity[]; attachment?: ApiAttachment }) {
  if (attachment) return;
  const actions = getActions();
  const credentials = corpEngine.credentials!;
  const corpEntities = buildCorpEntities(entities);

  if (message.isScheduled) {
    const dto = await editCorpScheduled(credentials.server, credentials.token, getServerChatId(chat.id), message.id, {
      text, entities: corpEntities,
    });
    actions.apiUpdate({
      '@type': 'updateScheduledMessage',
      chatId: chat.id,
      id: message.id,
      message: buildScheduled(chat, dto),
      isFull: true,
    });
    return;
  }

  actions.apiUpdate({
    '@type': 'updateMessage',
    chatId: chat.id,
    id: message.id,
    message: {
      content: { ...message.content, text: text ? buildCorpText(text, corpEntities, corpEngine.linkRule) : undefined },
    },
  });

  try {
    const dto = await editCorpMessage(
      credentials.server, credentials.token, getServerChatId(chat.id), message.id, text, corpEntities,
    );
    corpEngine.applyEdited(dto);
  } catch (err) {
    actions.apiUpdate({
      '@type': 'updateMessage', chatId: chat.id, id: message.id, message, isFull: true,
    });
    throw err;
  }
}

async function deleteMessages({ chat, messageIds }: { chat: ApiChat; messageIds: number[] }) {
  const credentials = corpEngine.credentials!;
  const serverChatId = getServerChatId(chat.id);
  await deleteCorpMessages(credentials.server, credentials.token, serverChatId, messageIds);
  corpEngine.applyDeleted(serverChatId, messageIds);
}

// ---- reactions, pins, read state, typing ----

async function sendReaction({
  chat, messageId, reactions,
}: { chat: ApiChat; messageId: number; reactions?: ApiReaction[] }) {
  // The corp server keeps one emoji reaction per employee: the latest choice wins
  const reaction = reactions?.filter((item) => item.type === 'emoji').pop();
  const credentials = corpEngine.credentials!;
  const serverChatId = getServerChatId(chat.id);
  const result = await setCorpReaction(
    credentials.server, credentials.token, serverChatId, messageId, reaction?.type === 'emoji' ? reaction.emoticon : '',
  );
  corpEngine.applyReactions(serverChatId, messageId, result);

  return true;
}

async function pinMessage({ chat, messageId, isUnpin }: { chat: ApiChat; messageId: number; isUnpin: boolean }) {
  const credentials = corpEngine.credentials!;
  await setCorpPin(credentials.server, credentials.token, getServerChatId(chat.id), messageId, !isUnpin);
  getActions().apiUpdate({
    '@type': 'updatePinnedIds', chatId: chat.id, messageIds: [messageId], isPinned: !isUnpin,
  });
}

async function unpinAllMessages({ chat }: { chat: ApiChat }) {
  const credentials = corpEngine.credentials!;
  const serverChatId = getServerChatId(chat.id);
  const pinnedIds = selectPinnedIds(getGlobal(), chat.id, MAIN_THREAD_ID) || [];
  await Promise.all(pinnedIds.map((id) => setCorpPin(credentials.server, credentials.token, serverChatId, id, false)));
}

async function markMessageListRead({ chat, maxId }: { chat: ApiChat; threadId: unknown; maxId?: number }) {
  if (!maxId || !Number.isInteger(maxId)) return;
  const credentials = corpEngine.credentials!;
  await readCorpChat(credentials.server, credentials.token, getServerChatId(chat.id), maxId);
}

// Stock code marks mentions read through `markMessagesRead` once they are seen
async function markMessagesRead({ chat, messageIds }: { chat: ApiChat; messageIds: number[] }) {
  const credentials = corpEngine.credentials!;
  await readCorpMentions(credentials.server, credentials.token, getServerChatId(chat.id), messageIds);
}

async function fetchUnreadMentions({ chat, threadId }: { chat: ApiChat; threadId?: unknown }) {
  if (threadId) return { messages: [], topics: [], totalCount: 0 };
  const credentials = corpEngine.credentials!;
  const list = await fetchCorpUnreadMentions(credentials.server, credentials.token, getServerChatId(chat.id));
  const messages = list
    .map((dto) => corpEngine.buildMessage(dto))
    .filter(Boolean)
    .map((message) => ({ ...message, hasUnreadMention: true }));

  return { messages, topics: [], totalCount: messages.length };
}

async function sendMessageAction({ peer, action }: { peer: ApiPeer; action: ApiSendMessageAction }) {
  const corpAction = TYPING_ACTIONS[action.type];
  if (!corpAction || !isCorpChatId(peer.id)) return undefined;
  const credentials = corpEngine.credentials!;
  await sendCorpTyping(credentials.server, credentials.token, getServerChatId(peer.id), corpAction);
  return true;
}

// ---- scheduled messages ----

async function fetchScheduledHistory({ chat }: { chat: ApiChat }) {
  const credentials = corpEngine.credentials!;
  const list = await fetchCorpScheduled(credentials.server, credentials.token, getServerChatId(chat.id));
  return { messages: list.map((dto) => buildScheduled(chat, dto)) };
}

async function sendScheduledMessages({ chat, ids }: { chat: ApiChat; ids: number[] }) {
  const credentials = corpEngine.credentials!;
  const serverChatId = getServerChatId(chat.id);
  const sent = await Promise.all(ids.map((id) => (
    sendCorpScheduledNow(credentials.server, credentials.token, serverChatId, id)
  )));
  getActions().apiUpdate({
    '@type': 'deleteScheduledMessages', chatId: chat.id, ids, newIds: sent.map(({ id }) => id),
  });
  sent.forEach((dto) => corpEngine.applyLive(dto));
}

async function rescheduleMessage({
  chat, message, scheduledAt,
}: { chat: ApiChat; message: ApiMessage; scheduledAt: number }) {
  const credentials = corpEngine.credentials!;
  const dto = await editCorpScheduled(credentials.server, credentials.token, getServerChatId(chat.id), message.id, {
    sendAt: new Date(scheduledAt * 1000).toISOString(),
  });
  getActions().apiUpdate({
    '@type': 'updateScheduledMessage',
    chatId: chat.id,
    id: message.id,
    message: buildScheduled(chat, dto),
    isFull: true,
  });
}

async function deleteScheduledMessages({ chat, messageIds }: { chat: ApiChat; messageIds: number[] }) {
  const credentials = corpEngine.credentials!;
  const serverChatId = getServerChatId(chat.id);
  await Promise.all(messageIds.map((id) => (
    deleteCorpScheduled(credentials.server, credentials.token, serverChatId, id)
  )));
  getActions().apiUpdate({ '@type': 'deleteScheduledMessages', chatId: chat.id, ids: messageIds });
}

// ---- polls ----

async function sendPollVote({ chat, messageId, options }: { chat: ApiChat; messageId: number; options: string[] }) {
  const pollId = getMessagePollServerId(chat, messageId);
  if (!pollId) return;
  const credentials = corpEngine.credentials!;
  const poll = await voteCorpPoll(credentials.server, credentials.token, pollId, options.map(Number));
  corpEngine.applyPoll(getServerChatId(chat.id), messageId, poll);
}

async function closePoll({ chat, messageId, poll }: { chat: ApiChat; messageId: number; poll: ApiMessagePoll }) {
  const pollId = getCorpPollServerId(poll.summary.id);
  if (!pollId) return;
  const credentials = corpEngine.credentials!;
  const result = await closeCorpPoll(credentials.server, credentials.token, pollId);
  corpEngine.applyPoll(getServerChatId(chat.id), messageId, result);
}

// Voters of a public poll are already in the poll results
function loadPollOptionResults({
  chat, messageId, option,
}: { chat: ApiChat; messageId: number; option?: string; offset?: string; limit?: number }) {
  const message = selectChatMessage(getGlobal(), chat.id, messageId);
  const poll = message && selectPollFromMessage(getGlobal(), message);
  const serverId = poll && getCorpPollServerId(poll.summary.id);
  const cached = serverId ? findCachedPoll(chat, messageId) : undefined;
  const corpOption = cached?.options.find(({ id }) => String(id) === option);
  const ownId = corpEngine.employeeId;
  const votes = (corpOption?.voterIds || []).map((id) => ({
    peerId: id === ownId ? getGlobal().currentUserId! : buildCorpUserId(id),
    date: 0,
  }));

  return Promise.resolve({ count: votes.length, votes, nextOffset: undefined });
}

function findCachedPoll(chat: ApiChat, messageId: number) {
  return corpEngine.getCachedMessages(getServerChatId(chat.id))?.find(({ id }) => id === messageId)?.poll || undefined;
}

function getMessagePollServerId(chat: ApiChat, messageId: number) {
  const message = selectChatMessage(getGlobal(), chat.id, messageId);
  const poll = message && selectPollFromMessage(getGlobal(), message);
  return poll ? getCorpPollServerId(poll.summary.id) : undefined;
}

// ---- chat info ----

async function fetchFullChat(chat: ApiChat) {
  const serverChatId = getServerChatId(chat.id);
  const credentials = corpEngine.credentials!;
  const [members, scheduled] = await Promise.all([
    loadMembers(chat),
    // The scheduled list button of the composer depends on it
    fetchCorpScheduled(credentials.server, credentials.token, serverChatId).catch(() => undefined),
  ]);
  const info = corpEngine.getChatInfo(serverChatId);

  return {
    fullInfo: {
      canViewMembers: true,
      members,
      adminMembersById: Object.fromEntries(members.filter((member) => member.isAdmin).map((member) => [
        member.userId, member,
      ])),
      enabledReactions: { type: 'all' as const },
      hasScheduledMessages: scheduled ? scheduled.length > 0 : undefined,
    },
    chats: [],
    userStatusesById: {},
    membersCount: info?.memberCount ?? members.length,
  };
}

async function fetchMembers({ chat, offset }: { chat: ApiChat; offset?: number }) {
  if (offset) return { members: [], userStatusesById: {} };

  return { members: await loadMembers(chat), userStatusesById: {} };
}

async function loadMembers(chat: ApiChat): Promise<ApiChatMember[]> {
  const credentials = corpEngine.credentials!;
  const list = await fetchCorpMembers(credentials.server, credentials.token, getServerChatId(chat.id));
  let global = getGlobal();
  const ownId = credentials.employee.id;
  const users = Object.fromEntries(list.filter(({ id }) => id !== ownId).map(({ id, fullName }) => [
    buildCorpUserId(id), buildCorpUser(id, fullName),
  ]));
  global = updateUsers(global, users);
  setGlobal(global);
  list.forEach((member) => corpEngine.applyPresence({ ...member, employeeId: member.id }));

  return list.map(({ id, isAdmin }) => ({
    userId: id === ownId ? global.currentUserId! : buildCorpUserId(id),
    isAdmin: isAdmin || undefined,
    adminRights: isAdmin ? { deleteMessages: true, pinMessages: true, editMessages: true } : undefined,
  }));
}
