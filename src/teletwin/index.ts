import { addCallback } from '../lib/teact/teactn';
import { getGlobal } from '../global';

import type { GlobalState } from '../global/types';
import type { CorpCredentials } from './storage';

import { selectTabState } from '../global/selectors';
import { getCurrentTabId } from '../util/establishMultitabRole';
import { createSignal } from '../util/signals';
import {
  CorpApiError, DEFAULT_CORP_SERVER, isCorpUnauthorized, loginCorp, normalizeCorpServer,
} from './api';
import { corpEngine } from './engine';
import {
  buildCredentialsKey, getDeviceId, saveCredentials,
} from './storage';

export { CORP_FOLDER_ID, isCorpChatId, isCorpFolderId } from './ids';
export { guardApiCall } from './guard';
export { fetchCorpViewportMessages, sendCorpText } from './messages';
export { hasCorpData, removeCorpData } from './state';

export type CorpLoginError = 'TeleTwinErrorCredentials' | 'TeleTwinErrorNetwork' | 'TeleTwinErrorRejected';

const [getCorpCredentials, setCorpCredentials] = createSignal<CorpCredentials | undefined>();
const [getIsCorpLoginOpen, setIsCorpLoginOpen] = createSignal(false);

export { DEFAULT_CORP_SERVER, getCorpCredentials, getIsCorpLoginOpen, setIsCorpLoginOpen };

let isInitialized = false;

export function initTeleTwin() {
  if (isInitialized) return;
  isInitialized = true;

  corpEngine.onStatusChange = setCorpCredentials;
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

  try {
    const result = await loginCorp(normalizedServer, login.trim(), password, getDeviceId());
    saveCredentials(telegramUserId, {
      server: normalizedServer,
      token: result.accessToken,
      employee: result.employee,
    });
    corpEngine.reloadCredentials();
    return undefined;
  } catch (err) {
    if (isCorpUnauthorized(err)) return 'TeleTwinErrorCredentials';
    return err instanceof CorpApiError && err.kind === 'rejected' ? 'TeleTwinErrorRejected' : 'TeleTwinErrorNetwork';
  }
}

export function logoutFromCorp() {
  void corpEngine.logout();
}
