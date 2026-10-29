import type {
  ApiChat, ApiChatBannedRights, ApiChatFolder, ApiFormattedText, ApiMessage, ApiMessageEntity, ApiMessagePoll,
  ApiMessageThreadInfo, ApiPeerNotifySettings, ApiPollResult, ApiReactions, ApiUser, ApiUserStatus, MediaContent,
} from '../api/types';
import type { GlobalState } from '../global/types';
import type {
  CorpChatInfo, CorpEmployee, CorpEntity, CorpMedia, CorpMessage, CorpPoll, CorpPresence, CorpReaction,
  CorpScheduledMessage,
} from './api';
import { ApiMessageEntityTypes, MAIN_THREAD_ID } from '../api/types';

import { ALL_FOLDER_ID } from '../config';
import {
  addChatListIds,
  addChatMessagesById,
  addNotifyExceptions,
  updateChatLastMessageId,
  updateChats,
  updateListedIds,
  updatePoll,
  updateUsers,
} from '../global/reducers';
import { replaceThreadLocalStateParam, updateThreadInfo, updateThreadReadState } from '../global/reducers/threads';
import { selectChatLastMessageId, selectChatMessages, selectPoll } from '../global/selectors';
import { selectThread, selectThreadInfo, selectThreadReadState } from '../global/selectors/threads';
import { omit } from '../util/iteratees';
import { CORP_CHAT_KIND_CHANNEL, CORP_CHAT_KIND_DIRECT } from './api';
import {
  buildCorpChatId, buildCorpGroupMentionId, buildCorpMediaId, buildCorpPollId, buildCorpUserId, CORP_FOLDER_ID,
  CORP_MENTION_ALL_ID, CORP_MENTION_HERE_ID, getCorpGroupMentions, getEmployeeId, isCorpChatId, isCorpMentionKeywordId,
  isCorpPeerId, isCorpUserId,
} from './ids';

const MS_IN_SECOND = 1000;
const FOLDER_EMOTICON = '💼';
const GROUP_MENTION_EMOTICON = '👥';
const ENTITY_TYPE_PREFIX = 'MessageEntity';
const LOTTIE_MIME = 'application/x-tgsticker';
const VIDEO_STICKER_MIME = 'video/webm';
const STICKER_SIZE = 512;
const DEFAULT_MIME = 'application/octet-stream';
const MAX_BYTE = 255;
const RE_REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;
// Online employees stay online until a hub `presence` event says otherwise
const ONLINE_EXPIRES = 24 * 60 * 60;

// Features the corp server has no counterpart for
const UNSUPPORTED_RIGHTS: ApiChatBannedRights = {
  sendGames: true,
  sendInline: true,
  changeInfo: true,
  inviteUsers: true,
  manageTopics: true,
};
const READ_ONLY_RIGHTS: ApiChatBannedRights = {
  ...UNSUPPORTED_RIGHTS,
  sendMessages: true,
  sendPlain: true,
  sendMedia: true,
  sendStickers: true,
  sendGifs: true,
  embedLinks: true,
  sendPhotos: true,
  sendVideos: true,
  sendRoundvideos: true,
  sendAudios: true,
  sendVoices: true,
  sendDocs: true,
  sendPolls: true,
};

export interface CorpSnapshot {
  telegramUserId: string;
  employee: CorpEmployee;
  chats: CorpChatInfo[];
  // Ascending by id; only chats whose history is loaded
  messagesByChat: Record<number, CorpMessage[]>;
  readMarks: Record<number, number>;
  folderTitle: string;
  linkRule?: CorpLinkRule;
}

export interface CorpLinkRule {
  baseUrl: string;
  pattern: RegExp;
}

export function isCorpDirectChat(info: CorpChatInfo): info is CorpChatInfo & { peerId: number } {
  return info.kind === CORP_CHAT_KIND_DIRECT && typeof info.peerId === 'number';
}

export function buildCorpChat(info: CorpChatInfo): ApiChat {
  if (isCorpDirectChat(info)) {
    return {
      id: buildCorpUserId(info.peerId),
      type: 'chatTypePrivate',
      title: info.title,
      isMin: false,
    };
  }

  const isChannel = info.kind === CORP_CHAT_KIND_CHANNEL;
  const canPostInChannel = isChannel && (info.canPost || info.isAdmin);

  return {
    id: buildCorpChatId(info.id),
    type: isChannel ? 'chatTypeChannel' : 'chatTypeSuperGroup',
    title: info.title,
    isMin: false,
    membersCount: info.memberCount,
    areSignaturesShown: isChannel || undefined,
    adminRights: info.isAdmin || canPostInChannel ? {
      postMessages: canPostInChannel || undefined,
      editMessages: info.isAdmin || undefined,
      deleteMessages: info.isAdmin || undefined,
      pinMessages: info.isAdmin || undefined,
    } : undefined,
    defaultBannedRights: !isChannel ? (info.canPost ? UNSUPPORTED_RIGHTS : READ_ONLY_RIGHTS) : undefined,
  };
}

// Stock mute = the corp level `mentions` (plain messages are silent, mentions still alert) or a timed mute;
// `none` silences everything, the server then sends no mention events either
export const CORP_MUTED_FOREVER = 2 ** 31 - 1;

export function getCorpChatMutedUntil(chat: Pick<CorpChatInfo, 'notifyLevel' | 'mutedUntil'>) {
  if (chat.notifyLevel === 'mentions' || chat.notifyLevel === 'none') return CORP_MUTED_FOREVER;
  const mutedUntil = chat.mutedUntil ? parseCorpDate(chat.mutedUntil) : 0;
  return mutedUntil > Date.now() / MS_IN_SECOND ? mutedUntil : 0;
}

export function buildCorpUser(employeeId: number, fullName: string): ApiUser {
  const name = fullName.trim();
  const space = name.indexOf(' ');

  return {
    id: buildCorpUserId(employeeId),
    isMin: false,
    type: 'userTypeRegular',
    firstName: space > 0 ? name.slice(0, space) : name,
    lastName: space > 0 ? name.slice(space + 1) : undefined,
    phoneNumber: '',
    noStatus: true,
  };
}

export function buildCorpUserStatus(presence: CorpPresence): ApiUserStatus | undefined {
  const now = Math.floor(Date.now() / MS_IN_SECOND);
  if (presence.isOnline) return { type: 'userStatusOnline', expires: now + ONLINE_EXPIRES };
  if (presence.lastSeenAt) return { type: 'userStatusOffline', wasOnline: parseCorpDate(presence.lastSeenAt) };
  if (presence.isOnline === false) return { type: 'userStatusRecently' };

  return undefined;
}

export function buildCorpMessage(
  dto: CorpMessage, chat: CorpChatInfo, employeeId: number, telegramUserId: string, linkRule?: CorpLinkRule,
  login?: string,
): ApiMessage {
  const isOwn = dto.senderId === employeeId;
  const hasUnreadMention = !isOwn && dto.id > (chat.lastReadId ?? 0) && isCorpMentionOf(dto, employeeId, login);
  const isChannel = chat.kind === CORP_CHAT_KIND_CHANNEL;
  const chatId = buildCorpChatId(chat.id);

  return {
    id: dto.id,
    chatId,
    date: parseCorpDate(dto.sentAt),
    isOutgoing: isOwn,
    // Own messages carry the Telegram user id, so stock code treats them as outgoing (no unread, "You:" previews)
    senderId: isOwn ? telegramUserId : (isChannel ? chatId : buildCorpUserId(dto.senderId)),
    postAuthorTitle: isChannel ? dto.senderName : undefined,
    content: {
      // A poll message carries its question as text for v1 clients
      text: dto.text && !dto.poll ? buildCorpText(dto.text, dto.entities, linkRule) : undefined,
      ...(dto.media && buildCorpMediaContent(dto.media)),
      pollId: dto.poll ? buildCorpPollId(dto.poll.id) : undefined,
    },
    replyInfo: buildCorpReplyInfo(dto),
    forwardInfo: dto.forward ? {
      date: parseCorpDate(dto.forward.sentAt || dto.sentAt),
      isChannelPost: false,
      hiddenUserName: dto.forward.senderName || dto.senderName,
    } : undefined,
    isEdited: dto.editedAt ? true : undefined,
    editDate: dto.editedAt ? parseCorpDate(dto.editedAt) : undefined,
    isPinned: dto.isPinned || undefined,
    reactions: dto.reactions?.length ? buildCorpReactions(dto.reactions, employeeId) : undefined,
    isForwardingAllowed: true,
    hasUnreadMention: hasUnreadMention || undefined,
    // Mentions alert even in a muted chat, unless notifications of the chat are off entirely
    isMentioned: (!isOwn && chat.notifyLevel !== 'none' && isCorpMentionOf(dto, employeeId, login)) || undefined,
  };
}

// Own messages waiting for their time on the server. An attached file shows as the stock document placeholder.
export function buildCorpScheduledMessage(
  dto: CorpScheduledMessage, chatId: string, telegramUserId: string, linkRule?: CorpLinkRule,
): ApiMessage {
  const replyToMsgId = dto.replyToId || dto.threadRootId || undefined;
  const text = dto.text || dto.poll?.question;

  return {
    id: dto.id,
    chatId,
    date: parseCorpDate(dto.sendAt),
    isOutgoing: true,
    senderId: telegramUserId,
    content: {
      text: text ? buildCorpText(text, dto.entities || undefined, linkRule) : undefined,
      document: dto.fileId ? {
        mediaType: 'document', id: buildCorpMediaId(dto.fileId), fileName: dto.fileId, size: 0, mimeType: DEFAULT_MIME,
      } : undefined,
    },
    replyInfo: replyToMsgId ? {
      type: 'message',
      replyToMsgId,
      replyToTopId: dto.threadRootId && !dto.alsoToChannel ? dto.threadRootId : undefined,
    } : undefined,
    isScheduled: true,
  };
}

function buildCorpReplyInfo(dto: CorpMessage): ApiMessage['replyInfo'] {
  const replyToMsgId = dto.replyToId || dto.threadRootId || undefined;
  if (!replyToMsgId) return undefined;

  return {
    type: 'message',
    replyToMsgId,
    replyToTopId: dto.threadRootId && !dto.alsoToChannel ? dto.threadRootId : undefined,
  };
}

// Group thread roots: the stock "N replies" counter of the message and the thread view
export function buildCorpThreadInfo(
  dto: Pick<CorpMessage, 'id' | 'thread'>, chatId: string, employeeId: number, telegramUserId: string,
): ApiMessageThreadInfo {
  return buildCorpThreadInfoFrom(chatId, dto.id, dto.thread?.replyCount ?? 0, dto.thread?.recentReplierIds,
    employeeId, telegramUserId);
}

export function buildCorpThreadInfoFrom(
  chatId: string, rootId: number, replyCount: number, recentReplierIds: number[] | undefined, employeeId: number,
  telegramUserId: string,
): ApiMessageThreadInfo {
  return {
    isCommentsInfo: false,
    chatId,
    threadId: rootId,
    messagesCount: replyCount,
    recentReplierIds: recentReplierIds?.map((id) => (id === employeeId ? telegramUserId : buildCorpUserId(id))),
  };
}

// `chosen` is per caller and always `false` in hub payloads: public polls name the voters, anonymous ones keep
// the choice already known
export function buildCorpPoll(
  poll: CorpPoll, employeeId: number, telegramUserId: string, isCreator: boolean, current?: ApiMessagePoll,
  isFromHub?: boolean,
): ApiMessagePoll {
  const toPeerId = (id: number) => (id === employeeId ? telegramUserId : buildCorpUserId(id));
  const resultByOption: Record<string, ApiPollResult> = {};
  poll.options.forEach(({
    id, votes, chosen, voterIds,
  }) => {
    const option = String(id);
    const isChosen = voterIds ? voterIds.includes(employeeId)
      : isFromHub ? current?.results.resultByOption?.[option]?.isChosen : chosen;
    resultByOption[option] = {
      option,
      votersCount: votes,
      isChosen: isChosen || undefined,
      recentVoterIds: voterIds?.slice(0, 3).map(toPeerId),
    };
  });
  const recentVoterIds = poll.isAnonymous ? undefined
    : [...new Set(poll.options.flatMap(({ voterIds }) => voterIds || []))].slice(0, 3).map(toPeerId);

  return {
    mediaType: 'poll',
    summary: {
      id: buildCorpPollId(poll.id),
      hash: '0',
      isClosed: poll.isClosed || undefined,
      isPublic: !poll.isAnonymous || undefined,
      isMultipleChoice: poll.isMultiple || undefined,
      isCreator: isCreator || current?.summary.isCreator || undefined,
      question: { text: poll.question },
      answers: poll.options.map(({ id, text }) => ({ text: { text }, option: String(id) })),
      closeDate: poll.closesAt ? parseCorpDate(poll.closesAt) : undefined,
    },
    results: {
      resultByOption,
      totalVoters: poll.totalVoters,
      recentVoterIds,
    },
  };
}

// The same sources the server counts: a `mentionName` entity, `@login`, `@all` and `@here`
function isCorpMentionOf(dto: CorpMessage, employeeId: number, login?: string) {
  if (dto.entities?.some((entity) => entity.type === 'mentionName'
    && (entity.employeeId ?? Number(entity.userId)) === employeeId)) {
    return true;
  }
  if (!dto.text?.includes('@')) return false;

  const names = ['all', 'here', ...(login ? [login.replace(RE_REGEXP_SPECIAL, '\\$&')] : [])];
  return new RegExp(`(?:^|[^\\w@])@(?:${names.join('|')})(?![a-z0-9])`, 'i').test(dto.text);
}

// Tooltip entries that insert `@all` and `@here`
export function buildCorpMentionKeywordUsers(): Record<string, ApiUser> {
  return {
    [CORP_MENTION_ALL_ID]: buildMentionKeywordUser(CORP_MENTION_ALL_ID, 'all'),
    [CORP_MENTION_HERE_ID]: buildMentionKeywordUser(CORP_MENTION_HERE_ID, 'here'),
  };
}

// Tooltip entries of user groups: inserted as plain `@handle`, the server expands them to the members
export function buildCorpGroupMentionUsers(): Record<string, ApiUser> {
  return Object.fromEntries(getCorpGroupMentions().map(({ id, handle, name }) => {
    const userId = buildCorpGroupMentionId(id);
    return [userId, buildMentionKeywordUser(userId, handle, `${GROUP_MENTION_EMOTICON} ${name}`)];
  }));
}

function buildMentionKeywordUser(id: string, keyword: string, title = `@${keyword}`): ApiUser {
  return {
    id,
    isMin: false,
    type: 'userTypeRegular',
    firstName: title,
    usernames: [{ username: keyword, isActive: true, isEditable: false }],
    phoneNumber: '',
    noStatus: true,
  };
}

export function parseCorpDate(value: string) {
  return Math.floor(new Date(value).getTime() / MS_IN_SECOND);
}

export function buildCorpReactions(reactions: CorpReaction[], employeeId: number): ApiReactions {
  return {
    canSeeList: false,
    results: reactions.filter(({ count }) => count > 0).map(({
      emoji, count, mine, employeeIds,
    }) => ({
      reaction: { type: 'emoji', emoticon: emoji },
      count,
      chosenOrder: (employeeIds ? employeeIds.includes(employeeId) : mine) ? 0 : undefined,
    })),
  };
}

// Server entities plus issue-tracker links for keys outside existing entities
export function buildCorpText(text: string, corpEntities?: CorpEntity[], linkRule?: CorpLinkRule): ApiFormattedText {
  const entities = corpEntities?.length ? buildApiEntities(corpEntities) : [];
  if (linkRule) {
    const pattern = new RegExp(linkRule.pattern.source, linkRule.pattern.flags.includes('g')
      ? linkRule.pattern.flags : `${linkRule.pattern.flags}g`);
    const existing = entities.slice();
    for (const match of text.matchAll(pattern)) {
      const offset = match.index;
      const { length } = match[0];
      if (!length) continue;
      const isCovered = existing.some((entity) => offset < entity.offset + entity.length
        && entity.offset < offset + length);
      if (isCovered) continue;
      entities.push({
        type: ApiMessageEntityTypes.TextUrl, offset, length, url: `${linkRule.baseUrl}${match[0]}`,
      });
    }
    entities.sort((a, b) => a.offset - b.offset);
  }

  return { text, entities: entities.length ? entities : undefined };
}

function buildCorpMediaContent(media: CorpMedia): MediaContent {
  const id = buildCorpMediaId(media.fileId, media.thumbFileId);
  const mimeType = media.mime || DEFAULT_MIME;
  const size = media.size || 0;
  const fileName = media.fileName || media.fileId;
  const duration = media.duration || 0;
  const { width, height } = media;

  switch (media.kind) {
    case 'photo':
      return {
        photo: {
          mediaType: 'photo',
          id,
          date: 0,
          sizes: width && height ? [{ type: 'x', width, height }] : [],
        },
      };
    case 'video':
    case 'roundVideo':
    case 'gif':
      return {
        video: {
          mediaType: 'video',
          id,
          mimeType,
          duration,
          fileName,
          width,
          height,
          size,
          supportsStreaming: true,
          isRound: media.kind === 'roundVideo' || undefined,
          isGif: media.kind === 'gif' || undefined,
          noSound: media.kind === 'gif' || undefined,
        },
      };
    case 'voice':
      return {
        voice: {
          mediaType: 'voice',
          id,
          duration,
          size,
          waveform: media.waveform ? decodeWaveform(media.waveform) : undefined,
        },
      };
    case 'audio':
      return {
        audio: {
          mediaType: 'audio',
          id,
          size,
          mimeType,
          fileName,
          duration,
        },
      };
    case 'sticker':
      return {
        sticker: {
          mediaType: 'sticker',
          id,
          stickerSetInfo: { isMissing: true },
          isLottie: mimeType === LOTTIE_MIME,
          isVideo: mimeType === VIDEO_STICKER_MIME,
          width: width || STICKER_SIZE,
          height: height || STICKER_SIZE,
        },
      };
    default:
      return {
        document: {
          mediaType: 'document',
          id,
          fileName,
          size,
          mimeType,
        },
      };
  }
}

// Entities are stored Telegram-style: `MessageEntityBold` <-> `bold`. Custom emoji are Telegram documents and stay out.
export function buildCorpEntities(entities?: ApiMessageEntity[]): CorpEntity[] | undefined {
  const result = entities
    // Plain `@name` stays text (the server finds `@login`, `@all`, `@here` itself); Telegram users are not employees
    ?.filter((entity) => entity.type !== ApiMessageEntityTypes.CustomEmoji
      && entity.type !== ApiMessageEntityTypes.Mention
      && (entity.type !== ApiMessageEntityTypes.MentionName
        || (isCorpUserId(entity.userId) && !isCorpMentionKeywordId(entity.userId))))
    .map((entity): CorpEntity => {
      if (entity.type === ApiMessageEntityTypes.MentionName) {
        return {
          type: 'mentionName', offset: entity.offset, length: entity.length, employeeId: getEmployeeId(entity.userId),
        };
      }

      const name = entity.type.slice(ENTITY_TYPE_PREFIX.length);
      return {
        type: name.charAt(0).toLowerCase() + name.slice(1),
        offset: entity.offset,
        length: entity.length,
        url: 'url' in entity ? entity.url : undefined,
        language: 'language' in entity ? entity.language : undefined,
      };
    });

  return result?.length ? result : undefined;
}

function buildApiEntities(entities: CorpEntity[]): ApiMessageEntity[] {
  return entities.map(({
    type, offset, length, url, language, employeeId, userId,
  }) => (type === 'mentionName' ? {
    type: ApiMessageEntityTypes.MentionName,
    offset,
    length,
    userId: buildCorpUserId(employeeId ?? Number(userId)),
  } : {
    type: `${ENTITY_TYPE_PREFIX}${type.charAt(0).toUpperCase()}${type.slice(1)}` as ApiMessageEntityTypes,
    offset,
    length,
    url,
    language,
  }) as ApiMessageEntity);
}

// Voice waveforms travel as base64 of one byte per sample
export function encodeWaveform(waveform: number[]) {
  return btoa(String.fromCharCode(...waveform.map((value) => Math.max(0, Math.min(MAX_BYTE, Math.round(value))))));
}

function decodeWaveform(value: string) {
  try {
    return Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export function buildCorpFolder(chats: CorpChatInfo[], title: string): ApiChatFolder {
  return {
    id: CORP_FOLDER_ID,
    title: { text: title },
    emoticon: FOLDER_EMOTICON,
    includedChatIds: chats.map((chat) => buildCorpChatId(chat.id)),
    excludedChatIds: [],
  };
}

export function applyCorpSnapshot<T extends GlobalState>(global: T, snapshot: CorpSnapshot): T {
  const {
    telegramUserId, employee, chats, messagesByChat, readMarks, folderTitle, linkRule,
  } = snapshot;

  const usersById: Record<string, ApiUser> = {};
  Object.values(messagesByChat).forEach((list) => {
    list.forEach((dto) => {
      if (dto.senderId === employee.id) return;
      const userId = buildCorpUserId(dto.senderId);
      if (!global.users.byId[userId] && !usersById[userId]) {
        usersById[userId] = buildCorpUser(dto.senderId, dto.senderName);
      }
    });
  });
  if (!global.users.byId[CORP_MENTION_ALL_ID]) Object.assign(usersById, buildCorpMentionKeywordUsers());
  Object.entries(buildCorpGroupMentionUsers()).forEach(([userId, user]) => {
    if (global.users.byId[userId]?.firstName !== user.firstName) usersById[userId] = user;
  });
  chats.forEach((chat) => {
    if (isCorpDirectChat(chat) && !global.users.byId[buildCorpUserId(chat.peerId)]) {
      usersById[buildCorpUserId(chat.peerId)] = buildCorpUser(chat.peerId, chat.title);
    }
  });
  if (Object.keys(usersById).length) {
    global = updateUsers(global, usersById);
  }

  const missingChats = chats.filter((chat) => !global.chats.byId[buildCorpChatId(chat.id)]);
  if (missingChats.length) {
    const chatsById: Record<string, ApiChat> = {};
    missingChats.forEach((chat) => {
      chatsById[buildCorpChatId(chat.id)] = buildCorpChat(chat);
    });
    global = updateChats(global, chatsById);
  }

  const chatIds = chats.map((chat) => buildCorpChatId(chat.id));
  if (global.chats.listIds.active) {
    global = addChatListIds(global, 'active', chatIds);
  }

  global = applyCorpFolder(global, chats, folderTitle);

  // The Telegram chat list load replaces all notify exceptions: the corp mute state is put back
  const notifyExceptions = chats.reduce((result: Record<string, ApiPeerNotifySettings>, chat) => {
    const chatId = buildCorpChatId(chat.id);
    const mutedUntil = getCorpChatMutedUntil(chat);
    if ((global.chats.notifyExceptionById?.[chatId]?.mutedUntil ?? 0) !== mutedUntil) result[chatId] = { mutedUntil };
    return result;
  }, {});
  if (Object.keys(notifyExceptions).length) global = addNotifyExceptions(global, notifyExceptions);

  chats.forEach((chat) => {
    const list = messagesByChat[chat.id];
    if (list) {
      global = applyCorpHistory(global, chat, list, employee, telegramUserId, readMarks[chat.id], linkRule);
    }
  });

  return global;
}

function applyCorpFolder<T extends GlobalState>(global: T, chats: CorpChatInfo[], title: string): T {
  const { byId, orderedIds } = global.chatFolders;
  const folder = buildCorpFolder(chats, title);
  const current = byId[CORP_FOLDER_ID];
  const isFolderCurrent = current?.title.text === folder.title.text
    && current.includedChatIds.join() === folder.includedChatIds.join();
  const hasOrder = orderedIds?.includes(CORP_FOLDER_ID);
  if (isFolderCurrent && hasOrder) return global;

  return {
    ...global,
    chatFolders: {
      ...global.chatFolders,
      byId: isFolderCurrent ? byId : { ...byId, [CORP_FOLDER_ID]: folder },
      // Appended last, so the index-based active folder tab of the user does not shift
      orderedIds: hasOrder ? orderedIds : [...(orderedIds || [ALL_FOLDER_ID]), CORP_FOLDER_ID],
    },
  };
}

function applyCorpHistory<T extends GlobalState>(
  global: T,
  chat: CorpChatInfo,
  list: CorpMessage[],
  employee: CorpEmployee,
  telegramUserId: string,
  readMark: number | undefined,
  linkRule: CorpLinkRule | undefined,
): T {
  const chatId = buildCorpChatId(chat.id);
  const byId = selectChatMessages(global, chatId);
  const missing = list.filter((dto) => !byId?.[dto.id]);
  const lastId = list.length ? list[list.length - 1].id : 0;
  const hasThread = Boolean(selectThread(global, chatId, MAIN_THREAD_ID));

  if (!hasThread) {
    global = updateThreadInfo(global, {
      isCommentsInfo: false,
      chatId,
      threadId: MAIN_THREAD_ID,
      lastMessageId: lastId || undefined,
    });

    const lastRead = Math.max(readMark ?? 0, chat.lastReadId ?? 0) || lastId;
    const unreadCount = list.filter((dto) => dto.id > lastRead && dto.senderId !== employee.id).length;
    global = updateThreadReadState(global, chatId, MAIN_THREAD_ID, {
      lastReadInboxMessageId: lastRead,
      lastReadOutboxMessageId: chat.readMaxId,
      unreadCount,
      unreadMentionsCount: chat.unreadMentionsCount || undefined,
    });
    if (chat.pinnedIds?.length) {
      global = replaceThreadLocalStateParam(
        global, chatId, MAIN_THREAD_ID, 'pinnedIds', chat.pinnedIds.slice().sort((a, b) => b - a),
      );
    }
  }

  list.forEach((dto) => {
    const threadInfo = selectThreadInfo(global, chatId, dto.id);
    if (dto.thread && threadInfo?.messagesCount !== dto.thread.replyCount) {
      global = updateThreadInfo(global, buildCorpThreadInfo(dto, chatId, employee.id, telegramUserId));
    }
    if (!dto.poll || selectPoll(global, buildCorpPollId(dto.poll.id))) return;
    const poll = buildCorpPoll(dto.poll, employee.id, telegramUserId, dto.senderId === employee.id);
    global = updatePoll(global, poll.summary.id, poll);
  });

  if (missing.length) {
    const newById: Record<number, ApiMessage> = {};
    missing.forEach((dto) => {
      newById[dto.id] = buildCorpMessage(dto, chat, employee.id, telegramUserId, linkRule, employee.login);
    });
    global = addChatMessagesById(global, chatId, newById);
  }

  global = updateListedIds(global, chatId, MAIN_THREAD_ID, list.map((dto) => dto.id));

  const currentLastId = selectChatLastMessageId(global, chatId);
  if (lastId && (!currentLastId || currentLastId < lastId)) {
    global = updateChatLastMessageId(global, chatId, lastId);
  }

  return global;
}

// Cheap check run on every global change: Telegram list/folder/message syncs replace whole sections of state
export function isCorpSnapshotApplied(global: GlobalState, snapshot: CorpSnapshot) {
  const { byId: foldersById, orderedIds } = global.chatFolders;
  if (!foldersById[CORP_FOLDER_ID] || !orderedIds?.includes(CORP_FOLDER_ID)) return false;

  const activeIds = global.chats.listIds.active;

  return snapshot.chats.every((chat) => {
    const chatId = buildCorpChatId(chat.id);
    if (!global.chats.byId[chatId]) return false;
    if (activeIds && !activeIds.includes(chatId)) return false;
    if ((global.chats.notifyExceptionById?.[chatId]?.mutedUntil ?? 0) !== getCorpChatMutedUntil(chat)) return false;

    const list = snapshot.messagesByChat[chat.id];
    if (!list) return true;
    if (!selectThreadReadState(global, chatId, MAIN_THREAD_ID)) return false;
    if (!list.length) return true;

    const lastId = list[list.length - 1].id;
    return Boolean(selectChatMessages(global, chatId)?.[lastId]) && Boolean(selectChatLastMessageId(global, chatId));
  });
}

export function hasCorpData(global: GlobalState) {
  return Boolean(global.chatFolders.byId[CORP_FOLDER_ID]) || Object.keys(global.chats.byId).some(isCorpChatId);
}

// Removes corp chats, senders, messages and the folder. Pure: also used to strip the persisted cache.
export function removeCorpData<T extends GlobalState>(global: T, onlyChatIds?: string[]): T {
  const isRemovedChat = onlyChatIds ? (id: string) => onlyChatIds.includes(id) : isCorpChatId;
  const isRemovedPeer = onlyChatIds ? isRemovedChat : isCorpPeerId;
  const chatIds = Object.keys(global.chats.byId).filter(isRemovedChat);
  const userIds = onlyChatIds ? [] : Object.keys(global.users.byId).filter(isCorpUserId);
  const messageChatIds = Object.keys(global.messages.byChatId).filter(isRemovedChat);
  const keepPeer = (id: string) => !isRemovedPeer(id);
  const { chats, users, chatFolders } = global;
  const corpFolder = chatFolders.byId[CORP_FOLDER_ID];

  global = {
    ...global,
    chats: {
      ...chats,
      byId: omit(chats.byId, chatIds),
      fullInfoById: omit(chats.fullInfoById, chatIds),
      notifyExceptionById: omit(chats.notifyExceptionById, chatIds),
      topicsInfoById: omit(chats.topicsInfoById, chatIds),
      listIds: {
        active: chats.listIds.active?.filter(keepPeer),
        archived: chats.listIds.archived?.filter(keepPeer),
        saved: chats.listIds.saved?.filter(keepPeer),
      },
      orderedPinnedIds: {
        active: chats.orderedPinnedIds.active?.filter(keepPeer),
        archived: chats.orderedPinnedIds.archived?.filter(keepPeer),
        saved: chats.orderedPinnedIds.saved?.filter(keepPeer),
      },
      lastMessageIds: {
        ...chats.lastMessageIds,
        all: chats.lastMessageIds.all && omit(chats.lastMessageIds.all, chatIds),
      },
    },
    users: {
      ...users,
      byId: omit(users.byId, userIds),
      statusesById: omit(users.statusesById, userIds),
      fullInfoById: omit(users.fullInfoById, userIds),
    },
    messages: {
      ...global.messages,
      byChatId: omit(global.messages.byChatId, messageChatIds),
    },
    recentlyFoundChatIds: global.recentlyFoundChatIds?.filter(keepPeer),
    topPeerCategories: removeCorpTopPeers(global.topPeerCategories, keepPeer),
  };

  if (corpFolder) {
    global = {
      ...global,
      chatFolders: onlyChatIds ? {
        ...chatFolders,
        byId: {
          ...chatFolders.byId,
          [CORP_FOLDER_ID]: {
            ...corpFolder,
            includedChatIds: corpFolder.includedChatIds.filter(keepPeer),
          },
        },
      } : {
        ...chatFolders,
        byId: omit(chatFolders.byId, [CORP_FOLDER_ID]),
        orderedIds: chatFolders.orderedIds?.filter((id) => id !== CORP_FOLDER_ID),
      },
    };
  }

  return global;
}

function removeCorpTopPeers(
  categories: GlobalState['topPeerCategories'], keepPeer: (id: string) => boolean,
): GlobalState['topPeerCategories'] {
  const hasCorpPeers = Object.values(categories).some((category) => category?.peerIds.some((id) => !keepPeer(id)));
  if (!hasCorpPeers) return categories;

  const result: GlobalState['topPeerCategories'] = {};
  (Object.keys(categories) as (keyof GlobalState['topPeerCategories'])[]).forEach((key) => {
    const category = categories[key]!;
    result[key] = { ...category, peerIds: category.peerIds.filter(keepPeer) };
  });

  return result;
}
