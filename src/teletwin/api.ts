// REST client of the TeleTwin corp server (`docs/corp-api-v2.md` in the server repo).
// The server URL is absolute: the same build also runs on other origins (desktop shell, dev server).
// Served by the corp server itself at <server>web/ (https://tele.dtwin.uz/web/, legacy https://dtwin.uz/teletwin/web/)
// the default is that same server, so requests stay same-origin; anywhere else it is the production server.
//   REST -> <server>api/...
//   Hub  -> <server>hub

const PRODUCTION_CORP_SERVER = 'https://tele.dtwin.uz/';

export const DEFAULT_CORP_SERVER = typeof location !== 'undefined' && location.protocol === 'https:'
  && /\/web\/[^/]*$/.test(location.pathname)
  ? new URL('../', location.href).href
  : PRODUCTION_CORP_SERVER;

const REQUEST_TIMEOUT = 30000;
const HTTP_NO_CONTENT = 204;
const HTTP_PARTIAL_CONTENT = 206;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MAX = 600;
const RE_CONTENT_RANGE_SIZE = /\/(\d+)$/;
const RE_PENDING = /pending/i;
const RE_REJECTED = /rejected/i;

export const CORP_CHAT_KIND_GROUP = 1;
export const CORP_CHAT_KIND_CHANNEL = 2;
export const CORP_CHAT_KIND_DIRECT = 3;

export interface CorpEmployee {
  id: number;
  login: string;
  fullName: string;
}

export interface CorpLoginResponse {
  accessToken: string;
  employee: CorpEmployee;
}

export interface CorpChatInfo {
  id: number;
  title: string;
  kind: number;
  canPost: boolean;
  lastReadId?: number;
  readMaxId?: number;
  pinnedIds?: number[];
  memberCount?: number;
  isAdmin?: boolean;
  // Direct chats: the other employee
  peerId?: number | null;
  unreadMentionsCount?: number;
  // The caller's own notification setting
  notifyLevel?: CorpNotifyLevel;
  mutedUntil?: string | null;
}

export type CorpNotifyLevel = 'all' | 'mentions' | 'none';

export interface CorpPresence {
  isOnline?: boolean;
  lastSeenAt?: string | null;
}

export interface CorpStatusFields {
  statusEmoji?: string | null;
  statusText?: string | null;
  statusUntil?: string | null;
  dndUntil?: string | null;
}

export interface CorpStatusUpdate {
  emoji?: string;
  text?: string;
  until?: string;
  dndUntil?: string;
}

export interface CorpProfileFields {
  title?: string | null;
  department?: string | null;
  phone?: string | null;
  birthday?: string | null;
  // Opaque JSON object, e.g. { tz, days, from, to }
  workHours?: { days?: number[]; from?: string; to?: string; tz?: string } | null;
}

export interface CorpEmployeeInfo extends CorpPresence, CorpStatusFields, CorpProfileFields {
  id: number;
  fullName: string;
  login: string;
}

export interface CorpMember extends CorpPresence, CorpStatusFields {
  id: number;
  fullName: string;
  login: string;
  canPost?: boolean;
  isAdmin?: boolean;
}

export type CorpMediaKind = 'photo' | 'video' | 'document' | 'voice' | 'roundVideo' | 'audio' | 'sticker' | 'gif';

export interface CorpMedia {
  fileId: string;
  kind: CorpMediaKind;
  mime?: string;
  size?: number;
  fileName?: string;
  width?: number;
  height?: number;
  duration?: number;
  waveform?: string;
  thumbFileId?: string;
}

export interface CorpEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
  userId?: string;
  // `mentionName`: the mentioned employee
  employeeId?: number;
}

export interface CorpMention {
  chatId: number;
  messageId: number;
  threadRootId?: number | null;
  fromId: number;
  fromName: string;
  text: string;
  reason: string;
}

export interface CorpReaction {
  emoji: string;
  count: number;
  mine?: boolean;
  employeeIds?: number[];
}

export interface CorpForward {
  fromChatId?: number;
  fromMessageId?: number;
  senderName?: string;
  sentAt?: string;
}

export interface CorpMessage {
  id: number;
  chatId: number;
  senderId: number;
  senderName: string;
  text: string;
  sentAt: string;
  entities?: CorpEntity[];
  replyToId?: number;
  forward?: CorpForward;
  editedAt?: string;
  isDeleted?: boolean;
  media?: CorpMedia;
  reactions?: CorpReaction[];
  isPinned?: boolean;
  clientId?: string;
  poll?: CorpPoll | null;
  // Thread replies: the root message; `alsoToChannel` replies are also in the main history
  threadRootId?: number | null;
  alsoToChannel?: boolean;
  // Thread roots with at least one reply
  thread?: CorpThreadSummary | null;
}

export interface CorpThreadSummary {
  replyCount: number;
  lastReplyAt?: string | null;
  recentReplierIds?: number[];
  // The caller's read position, 0 in hub payloads
  lastReadId?: number;
}

export interface CorpThreadUpdate {
  chatId: number;
  rootId: number;
  replyCount: number;
  lastReplyAt?: string | null;
  recentReplierIds?: number[];
}

export interface CorpPollOption {
  id: number;
  text: string;
  votes: number;
  // The caller's choice; always `false` in hub payloads
  chosen?: boolean;
  // `null` for anonymous polls
  voterIds?: number[] | null;
}

export interface CorpPoll {
  id: number;
  question: string;
  isAnonymous: boolean;
  isMultiple: boolean;
  closesAt?: string | null;
  isClosed: boolean;
  totalVoters: number;
  options: CorpPollOption[];
}

export interface CorpNewPoll {
  question: string;
  options: string[];
  isAnonymous: boolean;
  isMultiple: boolean;
  closesAt?: string | null;
}

export interface CorpChanges {
  edited: CorpMessage[];
  deletedIds: number[];
  serverTime?: string;
}

export interface CorpNewMessage {
  text: string;
  entities?: CorpEntity[];
  replyToId?: number;
  fileId?: string;
  clientId?: string;
  poll?: CorpNewPoll;
  threadRootId?: number;
  alsoToChannel?: boolean;
}

export interface CorpScheduledMessage {
  id: number;
  chatId: number;
  sendAt: string;
  createdAt?: string;
  text: string;
  entities?: CorpEntity[] | null;
  replyToId?: number | null;
  fileId?: string | null;
  threadRootId?: number | null;
  alsoToChannel?: boolean;
  poll?: CorpNewPoll | null;
}

export interface CorpNewScheduledMessage extends CorpNewMessage {
  sendAt: string;
}

export interface CorpUploadResult {
  fileId: string;
  size: number;
  mime: string;
}

export interface CorpRegistration {
  fullName: string;
  login: string;
  password: string;
  deviceId: string;
  note?: string;
  telegramUserId?: string;
}

// `pending` and `declined` are the states of a self-registered account that is not approved
export type CorpFailureKind = 'unauthorized' | 'forbidden' | 'pending' | 'declined' | 'rejected' | 'tooMany'
  | 'network' | 'canceled';

export class CorpApiError extends Error {
  kind: CorpFailureKind;

  status?: number;

  constructor(kind: CorpFailureKind, status?: number) {
    super(status ? `${kind} ${status}` : kind);
    this.kind = kind;
    this.status = status;
  }
}

export function normalizeCorpServer(server: string) {
  const trimmed = server.trim() || DEFAULT_CORP_SERVER;
  const url = new URL(trimmed);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.search = '';
  url.hash = '';

  return url.href;
}

export function buildCorpHubUrl(server: string) {
  return new URL('hub', server).href;
}

export function isCorpUnauthorized(err: unknown) {
  return err instanceof CorpApiError && err.kind === 'unauthorized';
}

function buildApiUrl(server: string, path: string) {
  return new URL(`api/${path}`, server).href;
}

// A 403 on login carries the account state: a registration waiting for approval, or a rejected one
function buildForbiddenError(status: number, body: string) {
  if (RE_PENDING.test(body)) return new CorpApiError('pending', status);
  if (RE_REJECTED.test(body)) return new CorpApiError('declined', status);
  return new CorpApiError('forbidden', status);
}

async function request<T>(server: string, method: string, path: string, token?: string, body?: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(buildApiUrl(server, path), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch {
    throw new CorpApiError('network');
  } finally {
    clearTimeout(timer);
  }

  const { status } = response;
  if (status === HTTP_UNAUTHORIZED) throw new CorpApiError('unauthorized', status);
  if (status === HTTP_FORBIDDEN) throw buildForbiddenError(status, await response.text().catch(() => ''));
  if (status === HTTP_TOO_MANY_REQUESTS) throw new CorpApiError('tooMany', status);
  if (!response.ok) {
    const isRejected = status >= HTTP_CLIENT_ERROR_MIN && status < HTTP_SERVER_ERROR_MAX;
    throw new CorpApiError(isRejected ? 'rejected' : 'network', status);
  }
  if (status === HTTP_NO_CONTENT) return undefined as T;

  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function loginCorp(server: string, login: string, password: string, deviceId: string) {
  return request<CorpLoginResponse>(server, 'POST', 'auth/login', undefined, { login, password, deviceId });
}

export function registerCorp(server: string, registration: CorpRegistration) {
  return request<unknown>(server, 'POST', 'auth/register', undefined, registration);
}

export function logoutCorp(server: string, token: string) {
  return request<undefined>(server, 'POST', 'auth/logout', token);
}

export function fetchCorpMe(server: string, token: string) {
  return request<CorpEmployee>(server, 'GET', 'me', token);
}

export function fetchCorpChats(server: string, token: string) {
  return request<CorpChatInfo[]>(server, 'GET', 'chats', token);
}

export function fetchCorpEmployees(server: string, token: string) {
  return request<CorpEmployeeInfo[]>(server, 'GET', 'employees', token);
}

export function openCorpDirectChat(server: string, token: string, employeeId: number) {
  return request<CorpChatInfo>(server, 'POST', 'chats/direct', token, { employeeId });
}

export function fetchCorpUnreadMentions(server: string, token: string, chatId: number) {
  return request<CorpMessage[]>(server, 'GET', `chats/${chatId}/mentions?unread=1&limit=100`, token);
}

export function readCorpMentions(server: string, token: string, chatId: number, ids?: number[]) {
  return request<undefined>(server, 'POST', `chats/${chatId}/mentions/read`, token, ids ? { ids } : {});
}

export function fetchCorpMembers(server: string, token: string, chatId: number) {
  return request<CorpMember[]>(server, 'GET', `chats/${chatId}/members`, token);
}

// Messages of every chat I am in, newest first (main history and thread replies)
export function searchCorpMessages(server: string, token: string, query: string, limit: number) {
  const search = new URLSearchParams({ q: query, limit: String(limit) });
  return request<CorpMessage[]>(server, 'GET', `search?${search.toString()}`, token);
}

export function fetchCorpMessages(
  server: string,
  token: string,
  chatId: number,
  params: { afterId?: number; beforeId?: number; limit: number; query?: string },
) {
  const search = new URLSearchParams({ limit: String(params.limit) });
  if (params.afterId !== undefined) search.set('afterId', String(params.afterId));
  if (params.beforeId !== undefined) search.set('beforeId', String(params.beforeId));
  if (params.query) search.set('q', params.query);

  return request<CorpMessage[]>(server, 'GET', `chats/${chatId}/messages?${search.toString()}`, token);
}

export function fetchCorpThreadMessages(
  server: string,
  token: string,
  chatId: number,
  rootId: number,
  params: { afterId?: number; beforeId?: number; limit: number },
) {
  const search = new URLSearchParams({ limit: String(params.limit) });
  if (params.afterId !== undefined) search.set('afterId', String(params.afterId));
  if (params.beforeId !== undefined) search.set('beforeId', String(params.beforeId));

  return request<CorpMessage[]>(
    server, 'GET', `chats/${chatId}/threads/${rootId}/messages?${search.toString()}`, token,
  );
}

export function readCorpThread(server: string, token: string, chatId: number, rootId: number, maxId: number) {
  return request<undefined>(server, 'POST', `chats/${chatId}/threads/${rootId}/read`, token, { maxId });
}

export function fetchCorpChanges(server: string, token: string, chatId: number, since: string) {
  return request<CorpChanges>(server, 'GET', `chats/${chatId}/changes?since=${encodeURIComponent(since)}`, token);
}

export function sendCorpMessage(server: string, token: string, chatId: number, message: CorpNewMessage) {
  return request<CorpMessage>(server, 'POST', `chats/${chatId}/messages`, token, message);
}

export function forwardCorpMessages(
  server: string, token: string, chatId: number, fromChatId: number, messageIds: number[],
) {
  return request<CorpMessage[]>(server, 'POST', `chats/${chatId}/forward`, token, { fromChatId, messageIds });
}

export function editCorpMessage(
  server: string, token: string, chatId: number, messageId: number, text: string, entities?: CorpEntity[],
) {
  return request<CorpMessage>(server, 'PATCH', `chats/${chatId}/messages/${messageId}`, token, { text, entities });
}

export function deleteCorpMessages(server: string, token: string, chatId: number, ids: number[]) {
  return request<undefined>(server, 'DELETE', `chats/${chatId}/messages`, token, { ids });
}

export function setCorpReaction(server: string, token: string, chatId: number, messageId: number, emoji: string) {
  return request<CorpReaction[]>(server, 'PUT', `chats/${chatId}/messages/${messageId}/reactions`, token, { emoji });
}

export function setCorpPin(server: string, token: string, chatId: number, messageId: number, isPinned: boolean) {
  return request<undefined>(server, isPinned ? 'PUT' : 'DELETE', `chats/${chatId}/pins/${messageId}`, token);
}

export function readCorpChat(server: string, token: string, chatId: number, maxId: number) {
  return request<undefined>(server, 'POST', `chats/${chatId}/read`, token, { maxId });
}

export function sendCorpTyping(server: string, token: string, chatId: number, action: string) {
  return request<undefined>(server, 'POST', `chats/${chatId}/typing`, token, { action });
}

export function fetchCorpScheduled(server: string, token: string, chatId: number) {
  return request<CorpScheduledMessage[]>(server, 'GET', `chats/${chatId}/scheduled`, token);
}

export function createCorpScheduled(server: string, token: string, chatId: number, message: CorpNewScheduledMessage) {
  return request<CorpScheduledMessage>(server, 'POST', `chats/${chatId}/scheduled`, token, message);
}

export function editCorpScheduled(
  server: string, token: string, chatId: number, id: number,
  update: { text?: string; entities?: CorpEntity[]; sendAt?: string },
) {
  return request<CorpScheduledMessage>(server, 'PATCH', `chats/${chatId}/scheduled/${id}`, token, update);
}

export function deleteCorpScheduled(server: string, token: string, chatId: number, id: number) {
  return request<undefined>(server, 'DELETE', `chats/${chatId}/scheduled/${id}`, token);
}

export function sendCorpScheduledNow(server: string, token: string, chatId: number, id: number) {
  return request<CorpMessage>(server, 'POST', `chats/${chatId}/scheduled/${id}/send`, token);
}

export function voteCorpPoll(server: string, token: string, pollId: number, optionIds: number[]) {
  return request<CorpPoll>(server, 'PUT', `polls/${pollId}/vote`, token, { optionIds });
}

export function closeCorpPoll(server: string, token: string, pollId: number) {
  return request<CorpPoll>(server, 'POST', `polls/${pollId}/close`, token);
}

// XHR instead of `fetch`: only XHR reports upload progress
export function uploadCorpFile(
  server: string,
  token: string,
  file: Blob,
  fileName: string,
  kind: string,
  fields: Record<string, string | number | undefined>,
  onProgress?: (progress: number) => boolean | void,
) {
  return new Promise<CorpUploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file, fileName);
    form.append('kind', kind);
    Object.entries(fields).forEach(([key, value]) => {
      if (value !== undefined) form.append(key, String(value));
    });

    xhr.open('POST', buildApiUrl(server, 'files'));
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      // The callback returns `true` once the upload is canceled
      if (onProgress?.(e.loaded / e.total)) xhr.abort();
    };
    xhr.onload = () => {
      const { status } = xhr;
      if (status === HTTP_UNAUTHORIZED) {
        reject(new CorpApiError('unauthorized', status));
      } else if (status === HTTP_FORBIDDEN) {
        reject(new CorpApiError('forbidden', status));
      } else if (status < HTTP_CLIENT_ERROR_MIN) {
        try {
          resolve(JSON.parse(xhr.responseText) as CorpUploadResult);
        } catch {
          reject(new CorpApiError('network', status));
        }
      } else {
        reject(new CorpApiError('rejected', status));
      }
    };
    xhr.onerror = () => reject(new CorpApiError('network'));
    xhr.onabort = () => reject(new CorpApiError('canceled'));
    xhr.send(form);
  });
}

export async function downloadCorpFile(
  server: string, token: string, fileId: string, range?: { start: number; end: number },
) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (range) headers.Range = `bytes=${range.start}-${range.end}`;

  let response: Response;
  try {
    response = await fetch(buildApiUrl(server, `files/${encodeURIComponent(fileId)}`), { headers });
  } catch {
    throw new CorpApiError('network');
  }

  const { status } = response;
  if (status === HTTP_UNAUTHORIZED) throw new CorpApiError('unauthorized', status);
  if (!response.ok) throw new CorpApiError(status === HTTP_FORBIDDEN ? 'forbidden' : 'rejected', status);

  const mimeType = response.headers.get('Content-Type') || 'application/octet-stream';
  const contentRange = response.headers.get('Content-Range');
  const rangeSize = contentRange?.match(RE_CONTENT_RANGE_SIZE)?.[1];
  const fullSize = status === HTTP_PARTIAL_CONTENT && rangeSize
    ? Number(rangeSize)
    : Number(response.headers.get('Content-Length')) || undefined;

  return { response, mimeType, fullSize };
}

export interface CorpConfig {
  jiraBaseUrl?: string;
  jiraKeyPattern?: string;
}

export function fetchCorpConfig(server: string, token: string) {
  return request<CorpConfig>(server, 'GET', 'config', token);
}

export interface CorpJiraIssue {
  key: string;
  summary: string;
  status: string;
  // Jira category key: `new`, `indeterminate` or `done`
  statusCategory: string;
  assignee?: string | null;
  priority?: string | null;
  type?: string | null;
  url?: string;
}

export interface CorpUserGroup {
  id: number;
  handle: string;
  name: string;
  memberIds: number[];
}

export function fetchCorpGroups(server: string, token: string) {
  return request<CorpUserGroup[]>(server, 'GET', 'groups', token);
}

export function setCorpChatNotify(
  server: string, token: string, chatId: number,
  settings: { level?: CorpNotifyLevel; mutedUntil?: string; unmute?: boolean },
) {
  return request<{ notifyLevel: CorpNotifyLevel; mutedUntil?: string | null }>(
    server, 'PUT', `chats/${chatId}/notify`, token, settings,
  );
}

export interface CorpSavedItem {
  id: number;
  messageId: number;
  chatId: number;
  remindAt?: string | null;
  remindedAt?: string | null;
  doneAt?: string | null;
  createdAt: string;
  // Missing when the message was deleted since
  message?: CorpMessage | null;
}

export interface CorpReminder {
  savedId: number;
  chatId: number;
  messageId: number;
  systemChatId?: number;
  systemMessageId?: number;
}

export function fetchCorpSaved(server: string, token: string) {
  return request<CorpSavedItem[]>(server, 'GET', 'me/saved?done=0', token);
}

export function saveCorpMessage(server: string, token: string, messageId: number, remindAt?: string) {
  return request<CorpSavedItem>(server, 'POST', 'me/saved', token, { messageId, remindAt });
}

export function updateCorpSaved(
  server: string, token: string, id: number, body: { remindAt?: string; clearRemind?: boolean; done?: boolean },
) {
  return request<CorpSavedItem>(server, 'PATCH', `me/saved/${id}`, token, body);
}

export function deleteCorpSaved(server: string, token: string, id: number) {
  return request<undefined>(server, 'DELETE', `me/saved/${id}`, token);
}

export interface CorpActivityItem {
  // `mention`, `thread_reply` or `reaction`
  type: string;
  at: string;
  chatId: number;
  messageId: number;
  actorId: number;
  actorName: string;
  emoji?: string | null;
  message?: CorpMessage | null;
}

export function fetchCorpActivity(server: string, token: string, limit: number, before?: string) {
  const search = new URLSearchParams({ limit: String(limit) });
  if (before) search.set('before', before);
  return request<CorpActivityItem[]>(server, 'GET', `me/activity?${search.toString()}`, token);
}

// Employees edit only their own phone; the other profile fields are set by an admin
export function updateCorpMe(server: string, token: string, body: { phone?: string }) {
  return request<CorpEmployeeInfo>(server, 'PATCH', 'me', token, body);
}

export interface CorpDirectoryChat {
  id: number;
  title: string;
  kind: number;
  description?: string | null;
  memberCount: number;
  isMember: boolean;
}

export function fetchCorpDirectory(server: string, token: string) {
  return request<CorpDirectoryChat[]>(server, 'GET', 'chats/directory', token);
}

export function joinCorpChat(server: string, token: string, chatId: number) {
  return request<undefined>(server, 'POST', `chats/${chatId}/join`, token);
}

export function fetchCorpJiraIssue(server: string, token: string, key: string) {
  return request<CorpJiraIssue>(server, 'GET', `jira/issues/${encodeURIComponent(key)}`, token);
}

export function wakeUpCorpEmployee(
  server: string, token: string, employeeId: number, chatId?: number, force?: boolean,
) {
  return request<undefined>(server, 'POST', `employees/${employeeId}/wakeup`, token, {
    chatId, force: force || undefined,
  });
}

// Replaces the whole status: omitted fields are cleared
export function putCorpStatus(server: string, token: string, status: CorpStatusUpdate) {
  return request<CorpStatusFields>(server, 'PUT', 'me/status', token, status);
}
