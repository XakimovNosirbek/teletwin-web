import { addCallback } from '../lib/teact/teactn';
import { getActions, getGlobal } from '../global';

import type { GlobalState } from '../global/types';
import type { CorpCredentials, PendingRegistration } from './storage';

import { selectTabState } from '../global/selectors';
import { getCurrentTabId } from '../util/establishMultitabRole';
import { createSignal } from '../util/signals';
import { updatePeerColors } from '../util/theme';
import {
  CorpApiError, DEFAULT_CORP_SERVER, isCorpUnauthorized, loginCorp, normalizeCorpServer, registerCorp,
  wakeUpCorpEmployee,
} from './api';
import { corpEngine } from './engine';
import {
  buildCredentialsKey, getDeviceId, loadPendingRegistration, removePendingRegistration, saveCredentials,
  savePendingRegistration,
} from './storage';
import { handleWakeUp } from './wakeup';

export { CORP_FOLDER_ID, isCorpChatId, isCorpFolderId } from './ids';
export { hasCorpData, removeCorpData } from './state';

export type CorpLoginError = 'TeleTwinErrorCredentials' | 'TeleTwinErrorNetwork' | 'TeleTwinErrorRejected'
  | 'TeleTwinPending' | 'TeleTwinRejected';
export type CorpRegisterError = 'TeleTwinErrorLoginTaken' | 'TeleTwinErrorNetwork' | 'TeleTwinErrorRejected';

const PENDING_RETRY_INTERVAL = 15000;
const HTTP_CONFLICT = 409;

const [getCorpCredentials, setCorpCredentials] = createSignal<CorpCredentials | undefined>();
// The Telegram account the corp layer is bound to: set once Telegram authorization is ready
const [getCorpTelegramUserId, setCorpTelegramUserId] = createSignal<string | undefined>();
const [getPendingRegistration, setPendingRegistration] = createSignal<PendingRegistration | undefined>();
// A waiting registration that the administrator rejected
const [getRegistrationError, setRegistrationError] = createSignal<CorpLoginError | undefined>();

export {
  DEFAULT_CORP_SERVER, getCorpCredentials, getCorpTelegramUserId, getPendingRegistration, getRegistrationError,
};

let isInitialized = false;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;

export function initTeleTwin() {
  if (isInitialized) return;
  isInitialized = true;

  corpEngine.onStatusChange = setCorpCredentials;
  corpEngine.onBindChange = handleBindChange;
  corpEngine.onWakeUp = handleWakeUp;
  // Corp chats and employees have no photos: their initials avatars need the peer palette even before (or without)
  // Telegram's peer colors being loaded, otherwise they render in the text color
  if (!getGlobal().peerColors) updatePeerColors({});
  addCallback(handleGlobalChange);
  handleGlobalChange(getGlobal());

  window.addEventListener('storage', (e) => {
    if (corpEngine.telegramUserId && e.key === buildCredentialsKey(corpEngine.telegramUserId)) {
      corpEngine.reloadCredentials();
    }
  });
  window.addEventListener('online', () => corpEngine.reconnectNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') corpEngine.reconnectNow();
  });
}

function handleGlobalChange(global: GlobalState) {
  const { currentUserId } = global;
  const isAuthorized = global.auth.state === 'authorizationStateReady' && Boolean(currentUserId);
  if (!isAuthorized) {
    corpEngine.unbind();
    return;
  }

  const isMaster = Boolean(selectTabState(global, getCurrentTabId())?.isMasterTab);
  corpEngine.bind(currentUserId, isMaster);
  if (isMaster) corpEngine.handleGlobalChange(global);
}

function handleBindChange(telegramUserId?: string) {
  setCorpTelegramUserId(telegramUserId);
  stopPendingRetry();
  const pending = telegramUserId ? loadPendingRegistration(telegramUserId) : undefined;
  setPendingRegistration(pending);
  if (pending) schedulePendingRetry();
}

export async function loginToCorp(
  server: string, login: string, password: string,
): Promise<CorpLoginError | undefined> {
  const telegramUserId = corpEngine.telegramUserId;
  if (!telegramUserId) return 'TeleTwinErrorNetwork';

  let normalizedServer: string;
  try {
    normalizedServer = normalizeCorpServer(server);
  } catch {
    return 'TeleTwinErrorNetwork';
  }

  setRegistrationError(undefined);
  try {
    const result = await loginCorp(normalizedServer, login.trim(), password, getDeviceId());
    saveCredentials(telegramUserId, {
      server: normalizedServer,
      token: result.accessToken,
      employee: result.employee,
    });
    clearPendingRegistration();
    corpEngine.reloadCredentials();
    return undefined;
  } catch (err) {
    if (isCorpUnauthorized(err)) return 'TeleTwinErrorCredentials';
    if (err instanceof CorpApiError) {
      if (err.kind === 'pending') {
        rememberPendingRegistration({ server: normalizedServer, login: login.trim(), password });
        return 'TeleTwinPending';
      }
      if (err.kind === 'declined') {
        if (getPendingRegistration()) setRegistrationError('TeleTwinRejected');
        clearPendingRegistration();
        return 'TeleTwinRejected';
      }
      if (err.kind === 'rejected' || err.kind === 'forbidden' || err.kind === 'tooMany') return 'TeleTwinErrorRejected';
    }
    return 'TeleTwinErrorNetwork';
  }
}

export async function registerInCorp(
  server: string,
  form: { fullName: string; login: string; password: string; note?: string },
): Promise<CorpRegisterError | undefined> {
  const telegramUserId = corpEngine.telegramUserId;
  if (!telegramUserId) return 'TeleTwinErrorNetwork';

  let normalizedServer: string;
  try {
    normalizedServer = normalizeCorpServer(server);
  } catch {
    return 'TeleTwinErrorNetwork';
  }

  const login = form.login.trim();
  setRegistrationError(undefined);
  try {
    await registerCorp(normalizedServer, {
      fullName: form.fullName.trim(),
      login,
      password: form.password,
      deviceId: getDeviceId(),
      note: form.note?.trim() || undefined,
      telegramUserId,
    });
  } catch (err) {
    if (err instanceof CorpApiError && err.status === HTTP_CONFLICT) return 'TeleTwinErrorLoginTaken';
    if (err instanceof CorpApiError && err.kind === 'rejected') return 'TeleTwinErrorRejected';
    return 'TeleTwinErrorNetwork';
  }

  rememberPendingRegistration({ server: normalizedServer, login, password: form.password });
  return undefined;
}

export function cancelPendingRegistration() {
  clearPendingRegistration();
}

function rememberPendingRegistration(pending: PendingRegistration) {
  const telegramUserId = corpEngine.telegramUserId;
  if (!telegramUserId) return;
  savePendingRegistration(telegramUserId, pending);
  setPendingRegistration(pending);
  schedulePendingRetry();
}

function clearPendingRegistration() {
  stopPendingRetry();
  if (corpEngine.telegramUserId) removePendingRegistration(corpEngine.telegramUserId);
  setPendingRegistration(undefined);
}

// A registration waits for the administrator: the login is retried until it is approved or rejected
function schedulePendingRetry() {
  stopPendingRetry();
  pendingTimer = setTimeout(async () => {
    pendingTimer = undefined;
    const pending = getPendingRegistration();
    if (!pending || corpEngine.credentials) return;

    const error = await loginToCorp(pending.server, pending.login, pending.password);
    if (error && error !== 'TeleTwinPending' && error !== 'TeleTwinRejected' && getPendingRegistration()) {
      schedulePendingRetry();
    }
  }, PENDING_RETRY_INTERVAL);
}

function stopPendingRetry() {
  clearTimeout(pendingTimer);
  pendingTimer = undefined;
}

export function logoutFromCorp() {
  void corpEngine.logout();
}

export function logoutFromTelegram() {
  getActions().signOut({ forceInitApi: true });
}

export async function wakeUpEmployee(employeeId: number, serverChatId: number | undefined, name: string) {
  const credentials = corpEngine.credentials;
  if (!credentials) return;
  const actions = getActions();

  try {
    await wakeUpCorpEmployee(credentials.server, credentials.token, employeeId, serverChatId);
    actions.showNotification({ message: { key: 'TeleTwinWakeUpSent', variables: { name } } });
  } catch (err) {
    corpEngine.handleFailure(err);
    const isTooSoon = err instanceof CorpApiError && err.kind === 'tooMany';
    actions.showNotification({ message: { key: isTooSoon ? 'TeleTwinWakeUpTooSoon' : 'TeleTwinErrorNetwork' } });
  }
}
