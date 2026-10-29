import {
  CORP_FOLDER_ID, hasCorpMediaReference, isCorpBare, isCorpPeerId,
} from './ids';
import { callCorpMethod } from './provider';

// Corp chats, senders, media and the corp folder exist only on the TeleTwin server. Every call to the Telegram API
// passes through `callApi`/`callApiLocal` (`src/api/gramjs/worker/connector.ts`), where this router sends any call
// whose arguments reference a corp entity, at any depth, to the corp provider. Calls the provider does not implement
// are dropped: they never reach the GramJS worker.
const MAX_DEPTH = 8;
const FOLDER_METHOD_RE = /Folder|Chatlist/;

let routedCount = 0;
let blockedCount = 0;

export type RouteResult = { kind: 'telegram'; args: unknown[] }
  | { kind: 'corp'; promise: Promise<unknown> }
  | { kind: 'blocked' };

export function routeApiCall(fnName: string, args: unknown[]): RouteResult {
  if (fnName === 'sortChatFolders' && Array.isArray(args[0]) && args[0].includes(CORP_FOLDER_ID)) {
    // Reordering keeps working for Telegram folders, the local corp folder is left out
    return { kind: 'telegram', args: [args[0].filter((id) => id !== CORP_FOLDER_ID), ...args.slice(1)] };
  }

  const isFolderMethod = FOLDER_METHOD_RE.test(fnName);
  if (!hasCorpReference(args, isFolderMethod, 0, new WeakSet())) {
    return { kind: 'telegram', args };
  }

  const promise = callCorpMethod(fnName, args);
  if (promise) {
    routedCount++;
    return { kind: 'corp', promise };
  }

  blockedCount++;
  // eslint-disable-next-line no-console
  console.warn(`[TeleTwin] Blocked Telegram API call \`${fnName}\`: it references a corp chat`);

  return { kind: 'blocked' };
}

export function getApiRouteCounts() {
  return { routed: routedCount, blocked: blockedCount };
}

function hasCorpReference(value: unknown, isFolderMethod: boolean, depth: number, seen: WeakSet<object>): boolean {
  switch (typeof value) {
    case 'string':
      return isCorpPeerId(value) || hasCorpMediaReference(value);
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
