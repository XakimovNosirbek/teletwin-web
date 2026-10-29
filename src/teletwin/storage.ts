import type { CorpEmployee } from './api';

// Corp credentials are kept per Telegram account: `teletwin.corp.<telegramUserId>`.
// Read marks: `teletwin.read.<telegramUserId>.<employeeId>` -> { [serverChatId]: lastReadMessageId }.
const CREDENTIALS_PREFIX = 'teletwin.corp.';
const READ_PREFIX = 'teletwin.read.';
const DEVICE_KEY = 'teletwin.device';
// A registration waiting for approval: kept in `sessionStorage` only, it holds the chosen password
const PENDING_PREFIX = 'teletwin.pending.';
const DEVICE_ID_BYTES = 12;
const HEX_RADIX = 16;

export interface CorpCredentials {
  server: string;
  token: string;
  employee: CorpEmployee;
}

export interface PendingRegistration {
  server: string;
  login: string;
  password: string;
}

export function loadPendingRegistration(telegramUserId: string): PendingRegistration | undefined {
  try {
    const raw = sessionStorage.getItem(`${PENDING_PREFIX}${telegramUserId}`);
    const parsed = raw ? JSON.parse(raw) as PendingRegistration : undefined;
    return parsed?.server && parsed.login && parsed.password ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function savePendingRegistration(telegramUserId: string, pending: PendingRegistration) {
  try {
    sessionStorage.setItem(`${PENDING_PREFIX}${telegramUserId}`, JSON.stringify(pending));
  } catch {
    // Blocked storage: the waiting screen lasts until reload
  }
}

export function removePendingRegistration(telegramUserId: string) {
  try {
    sessionStorage.removeItem(`${PENDING_PREFIX}${telegramUserId}`);
  } catch {
    // Blocked storage has nothing to remove
  }
}

export function buildCredentialsKey(telegramUserId: string) {
  return `${CREDENTIALS_PREFIX}${telegramUserId}`;
}

export function loadCredentials(telegramUserId: string): CorpCredentials | undefined {
  const raw = readItem(buildCredentialsKey(telegramUserId));
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as CorpCredentials;
    return parsed?.token && parsed.server && parsed.employee ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function saveCredentials(telegramUserId: string, credentials: CorpCredentials) {
  writeItem(buildCredentialsKey(telegramUserId), JSON.stringify(credentials));
}

export function removeCredentials(telegramUserId: string) {
  removeItem(buildCredentialsKey(telegramUserId));
  const prefix = `${READ_PREFIX}${telegramUserId}.`;
  listKeys().filter((key) => key.startsWith(prefix)).forEach(removeItem);
}

export function loadReadMarks(telegramUserId: string, employeeId: number): Record<number, number> {
  try {
    return JSON.parse(readItem(`${READ_PREFIX}${telegramUserId}.${employeeId}`) || '{}') as Record<number, number>;
  } catch {
    return {};
  }
}

export function saveReadMarks(telegramUserId: string, employeeId: number, marks: Record<number, number>) {
  writeItem(`${READ_PREFIX}${telegramUserId}.${employeeId}`, JSON.stringify(marks));
}

export function getDeviceId() {
  let id = readItem(DEVICE_KEY);
  if (!id) {
    const random = crypto.getRandomValues(new Uint8Array(DEVICE_ID_BYTES));
    id = `web-${Array.from(random, (b) => b.toString(HEX_RADIX).padStart(2, '0')).join('')}`;
    writeItem(DEVICE_KEY, id);
  }

  return id;
}

function readItem(key: string) {
  try {
    return localStorage.getItem(key) || undefined;
  } catch {
    return undefined;
  }
}

function writeItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Blocked storage: the corp session lives in memory until reload
  }
}

function removeItem(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Blocked storage has nothing to remove
  }
}

function listKeys() {
  try {
    return Object.keys(localStorage);
  } catch {
    return [];
  }
}
