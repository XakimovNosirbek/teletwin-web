import { CHANNEL_ID_BASE } from '../config';

// Corp entities use the bare MTProto id range [2^48 - 2^32, 2^48), the same range as the desktop fork
// (`Corp::kCorpBase` in `corp_ids.h`). Telegram ids are far below it, so a corp id never collides with a real one.
//   Corp chat (channel)  server chat id N -> `-(10^12 + 2^48 - 2^32 + N)`, e.g. N = 1 -> `-282470681743361`
//   Corp sender (user)   employee id E    -> `2^48 - 2^32 + E`,             e.g. E = 1 -> `281470681743361`
const CORP_BARE_BASE = 2 ** 48 - 2 ** 32;
const CORP_BARE_END = 2 ** 48;
const CHANNEL_BASE = Number(CHANNEL_ID_BASE);
const CORP_ID_LENGTH = 15;
const RE_DIGITS = /^\d+$/;

// Telegram folder ids are 2..255, so the corp folder id stays local-only (same value as `Corp::kCorpFilterId`)
export const CORP_FOLDER_ID = 0x40000000;

// Direct chats render as private chats with the other employee, so their chat id is that employee's user id
const directPeerByChat = new Map<number, number>();
const directChatByPeer = new Map<number, number>();

export function registerCorpDirectChat(serverChatId: number, peerEmployeeId: number) {
  directPeerByChat.set(serverChatId, peerEmployeeId);
  directChatByPeer.set(peerEmployeeId, serverChatId);
}

export function getCorpDirectChatId(peerEmployeeId: number) {
  return directChatByPeer.get(peerEmployeeId);
}

export function buildCorpChatId(serverChatId: number) {
  const peerEmployeeId = directPeerByChat.get(serverChatId);
  if (peerEmployeeId !== undefined) return buildCorpUserId(peerEmployeeId);

  return `-${CHANNEL_BASE + CORP_BARE_BASE + serverChatId}`;
}

export function buildCorpUserId(employeeId: number) {
  return String(CORP_BARE_BASE + employeeId);
}

export function getServerChatId(corpChatId: string) {
  if (isCorpUserIdValue(corpChatId)) return directChatByPeer.get(getEmployeeId(corpChatId)) ?? 0;

  return Number(corpChatId.slice(1)) - CHANNEL_BASE - CORP_BARE_BASE;
}

// Group and channel ids, and employee ids used as the id of a direct chat
export function isCorpChatId(id?: string): id is string {
  if (isCorpUserIdValue(id)) return true;
  if (id?.length !== CORP_ID_LENGTH + 1 || id[0] !== '-') return false;
  const digits = id.slice(1);
  if (!RE_DIGITS.test(digits)) return false;

  return isCorpBare(Number(digits) - CHANNEL_BASE);
}

export function isCorpUserId(id?: string): id is string {
  return isCorpUserIdValue(id);
}

function isCorpUserIdValue(id?: string) {
  if (id?.length !== CORP_ID_LENGTH || !RE_DIGITS.test(id)) return false;

  return isCorpBare(Number(id));
}

export function isCorpPeerId(id?: string): id is string {
  return isCorpChatId(id) || isCorpUserId(id);
}

export function isCorpBare(value: number) {
  return value >= CORP_BARE_BASE && value < CORP_BARE_END;
}

export function isCorpFolderId(folderId?: number) {
  return folderId === CORP_FOLDER_ID;
}

// Corp media ids carry the server file ids: `teletwin-corp:<fileId>` or `teletwin-corp:<fileId>~<thumbFileId>`.
// Stock helpers turn them into media hashes such as `phototeletwin-corp:f_1?size=x` or `documentteletwin-corp:f_1`,
// which the provider downloads from the corp server instead of Telegram.
const CORP_MEDIA_PREFIX = 'teletwin-corp:';
const CORP_THUMB_SEPARATOR = '~';
const RE_CORP_MEDIA_HASH = /^(?:progressive\/)?(?:photo|document)teletwin-corp:([^?~]+)(?:~([^?]+))?(?:\?(.*))?$/;

export function buildCorpMediaId(fileId: string, thumbFileId?: string) {
  return `${CORP_MEDIA_PREFIX}${fileId}${thumbFileId ? `${CORP_THUMB_SEPARATOR}${thumbFileId}` : ''}`;
}

export function hasCorpMediaReference(value: string) {
  return value.includes(CORP_MEDIA_PREFIX);
}

export function parseCorpMediaHash(hash: string) {
  const match = hash.match(RE_CORP_MEDIA_HASH);
  if (!match) return undefined;

  return { fileId: match[1], thumbFileId: match[2] as string | undefined, query: match[3] || '' };
}

// Mention tooltip entries for `@all` and `@here`: employee ids no real employee gets
export const CORP_MENTION_ALL_ID = buildCorpUserId(2 ** 32 - 1);
export const CORP_MENTION_HERE_ID = buildCorpUserId(2 ** 32 - 2);

export function isCorpMentionKeywordId(userId: string) {
  return userId === CORP_MENTION_ALL_ID || userId === CORP_MENTION_HERE_ID;
}

export function getEmployeeId(corpUserId: string) {
  return Number(corpUserId) - CORP_BARE_BASE;
}

// A corp thread reply that is not in the main history: the server keeps threads apart, unlike Telegram supergroups
// where every reply is also a main history message. Corp messages carry `replyToTopId` only for such replies.
export function isCorpThreadOnlyMessage(message: { chatId: string; replyInfo?: { type: string } }) {
  return isCorpChatId(message.chatId) && message.replyInfo?.type === 'message'
    && Boolean((message.replyInfo as { replyToTopId?: number }).replyToTopId);
}

// Corp polls live in the same `pollById` store as Telegram ones, under ids Telegram never uses
const CORP_POLL_PREFIX = 'teletwin-corp-poll:';

export function buildCorpPollId(serverPollId: number) {
  return `${CORP_POLL_PREFIX}${serverPollId}`;
}

export function getCorpPollServerId(pollId: string) {
  return pollId.startsWith(CORP_POLL_PREFIX) ? Number(pollId.slice(CORP_POLL_PREFIX.length)) : undefined;
}
