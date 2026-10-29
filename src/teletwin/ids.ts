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

export function buildCorpChatId(serverChatId: number) {
  return `-${CHANNEL_BASE + CORP_BARE_BASE + serverChatId}`;
}

export function buildCorpUserId(employeeId: number) {
  return String(CORP_BARE_BASE + employeeId);
}

export function getServerChatId(corpChatId: string) {
  return Number(corpChatId.slice(1)) - CHANNEL_BASE - CORP_BARE_BASE;
}

export function isCorpChatId(id?: string): id is string {
  if (id?.length !== CORP_ID_LENGTH + 1 || id[0] !== '-') return false;
  const digits = id.slice(1);
  if (!RE_DIGITS.test(digits)) return false;

  return isCorpBare(Number(digits) - CHANNEL_BASE);
}

export function isCorpUserId(id?: string): id is string {
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
