import type {
  ApiChat, ApiChatBannedRights, ApiChatFolder, ApiFormattedText, ApiMessage, ApiMessageEntity, ApiReactions, ApiUser,
  MediaContent,
} from '../api/types';
import type { GlobalState } from '../global/types';
import type {
  CorpChatInfo, CorpEmployee, CorpEntity, CorpMedia, CorpMessage, CorpReaction,
} from './api';
import { ApiMessageEntityTypes, MAIN_THREAD_ID } from '../api/types';

import { ALL_FOLDER_ID } from '../config';
import {
  addChatListIds,
  addChatMessagesById,
  updateChatLastMessageId,
  updateChats,
  updateListedIds,
  updateUsers,
} from '../global/reducers';
import { replaceThreadLocalStateParam, updateThreadInfo, updateThreadReadState } from '../global/reducers/threads';
import { selectChatLastMessageId, selectChatMessages } from '../global/selectors';
import { selectThread, selectThreadReadState } from '../global/selectors/threads';
import { omit } from '../util/iteratees';
import { CORP_CHAT_KIND_CHANNEL } from './api';
import {
  buildCorpChatId, buildCorpMediaId, buildCorpUserId, CORP_FOLDER_ID, isCorpChatId, isCorpPeerId, isCorpUserId,
} from './ids';

const MS_IN_SECOND = 1000;
const FOLDER_EMOTICON = '💼';
const ENTITY_TYPE_PREFIX = 'MessageEntity';
const LOTTIE_MIME = 'application/x-tgsticker';
const VIDEO_STICKER_MIME = 'video/webm';
const STICKER_SIZE = 512;
const DEFAULT_MIME = 'application/octet-stream';
const MAX_BYTE = 255;

// Features the corp server has no counterpart for
const UNSUPPORTED_RIGHTS: ApiChatBannedRights = {
  sendGames: true,
  sendInline: true,
  sendPolls: true,
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

export function buildCorpChat(info: CorpChatInfo): ApiChat {
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

export function buildCorpMessage(
  dto: CorpMessage, chat: CorpChatInfo, employeeId: number, telegramUserId: string, linkRule?: CorpLinkRule,
): ApiMessage {
  const isOwn = dto.senderId === employeeId;
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
      text: dto.text ? buildCorpText(dto.text, dto.entities, linkRule) : undefined,
      ...(dto.media && buildCorpMediaContent(dto.media)),
    },
    replyInfo: dto.replyToId ? { type: 'message', replyToMsgId: dto.replyToId } : undefined,
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
    ?.filter((entity) => entity.type !== ApiMessageEntityTypes.CustomEmoji)
    .map((entity) => {
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
    type, offset, length, url, language,
  }) => ({
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

  chats.forEach((chat) => {
    const list = messagesByChat[chat.id];
    if (list) {
      global = applyCorpHistory(global, chat, list, employee.id, telegramUserId, readMarks[chat.id], linkRule);
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
  employeeId: number,
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
    const unreadCount = list.filter((dto) => dto.id > lastRead && dto.senderId !== employeeId).length;
    global = updateThreadReadState(global, chatId, MAIN_THREAD_ID, {
      lastReadInboxMessageId: lastRead,
      lastReadOutboxMessageId: chat.readMaxId,
      unreadCount,
    });
    if (chat.pinnedIds?.length) {
      global = replaceThreadLocalStateParam(
        global, chatId, MAIN_THREAD_ID, 'pinnedIds', chat.pinnedIds.slice().sort((a, b) => b - a),
      );
    }
  }

  if (missing.length) {
    const newById: Record<number, ApiMessage> = {};
    missing.forEach((dto) => {
      newById[dto.id] = buildCorpMessage(dto, chat, employeeId, telegramUserId, linkRule);
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
