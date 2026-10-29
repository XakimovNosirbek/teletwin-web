// REST client of the TeleTwin corp server, ported from the PWA client (`web/src/api.ts`).
// The server URL is absolute (default `https://dtwin.uz/teletwin/`): the same build also runs on other origins.
//   REST -> <server>api/...
//   Hub  -> <server>hub

export const DEFAULT_CORP_SERVER = 'https://dtwin.uz/teletwin/';

const REQUEST_TIMEOUT = 30000;
const HTTP_NO_CONTENT = 204;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MAX = 600;

export const CORP_CHAT_KIND_GROUP = 1;
export const CORP_CHAT_KIND_CHANNEL = 2;

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
}

export interface CorpMessage {
  id: number;
  chatId: number;
  senderId: number;
  senderName: string;
  text: string;
  sentAt: string;
}

export type CorpFailureKind = 'unauthorized' | 'forbidden' | 'rejected' | 'network';

export class CorpApiError extends Error {
  kind: CorpFailureKind;

  constructor(kind: CorpFailureKind, status?: number) {
    super(status ? `${kind} ${status}` : kind);
    this.kind = kind;
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

async function request<T>(server: string, method: string, path: string, token?: string, body?: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(new URL(`api/${path}`, server).href, {
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
  if (status === HTTP_FORBIDDEN) throw new CorpApiError('forbidden', status);
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

export function logoutCorp(server: string, token: string) {
  return request<undefined>(server, 'POST', 'auth/logout', token);
}

export function fetchCorpMe(server: string, token: string) {
  return request<CorpEmployee>(server, 'GET', 'me', token);
}

export function fetchCorpChats(server: string, token: string) {
  return request<CorpChatInfo[]>(server, 'GET', 'chats', token);
}

export function fetchCorpMessages(server: string, token: string, chatId: number, afterId: number, limit: number) {
  const after = afterId > 0 ? `&afterId=${afterId}` : '';
  return request<CorpMessage[]>(server, 'GET', `chats/${chatId}/messages?limit=${limit}${after}`, token);
}

export function sendCorpMessage(server: string, token: string, chatId: number, text: string) {
  return request<CorpMessage>(server, 'POST', `chats/${chatId}/messages`, token, { text });
}
