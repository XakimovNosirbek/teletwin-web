import { CORP_FOLDER_ID, isCorpBare, isCorpPeerId } from './ids';

// Corp chats, senders and the corp folder exist only on the TeleTwin server. Every call to the Telegram API
// passes through `callApi`/`callApiLocal` (`src/api/gramjs/worker/connector.ts`), where this guard drops any call
// whose arguments reference a corp entity anywhere, at any depth.
const MAX_DEPTH = 8;
const FOLDER_METHOD_RE = /Folder|Chatlist/;

let blockedCount = 0;

export type GuardResult = { isBlocked: true } | { isBlocked: false; args: unknown[] };

export function guardApiCall(fnName: string, args: unknown[]): GuardResult {
  if (fnName === 'sortChatFolders' && Array.isArray(args[0]) && args[0].includes(CORP_FOLDER_ID)) {
    // Reordering keeps working for Telegram folders, the local corp folder is left out
    return { isBlocked: false, args: [args[0].filter((id) => id !== CORP_FOLDER_ID), ...args.slice(1)] };
  }

  const isFolderMethod = FOLDER_METHOD_RE.test(fnName);
  if (!hasCorpReference(args, isFolderMethod, 0, new WeakSet())) {
    return { isBlocked: false, args };
  }

  blockedCount++;
  // eslint-disable-next-line no-console
  console.warn(`[TeleTwin] Blocked Telegram API call \`${fnName}\`: it references a corp chat`);

  return { isBlocked: true };
}

export function getBlockedApiCallsCount() {
  return blockedCount;
}

function hasCorpReference(value: unknown, isFolderMethod: boolean, depth: number, seen: WeakSet<object>): boolean {
  switch (typeof value) {
    case 'string':
      return isCorpPeerId(value);
    case 'number':
      return isCorpBare(value) || (isFolderMethod && value === CORP_FOLDER_ID);
    case 'bigint':
      return isCorpBare(Number(value));
    case 'object':
      break;
    default:
      return false;
  }

  if (!value || depth > MAX_DEPTH || seen.has(value) || !isPlainContainer(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => hasCorpReference(item, isFolderMethod, depth + 1, seen));
  }

  return Object.values(value).some((item) => hasCorpReference(item, isFolderMethod, depth + 1, seen));
}

function isPlainContainer(value: object) {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);

  return !proto || proto === Object.prototype;
}
