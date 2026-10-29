// Saved corp messages and their reminders (`/me/saved`, hub `reminder`)
import { getActions, getGlobal } from '../global';

import type { CorpReminder, CorpSavedItem } from './api';

import { getTranslationFn } from '../util/localization';
import { createSignal } from '../util/signals';
import {
  deleteCorpSaved, fetchCorpSaved, saveCorpMessage, updateCorpSaved,
} from './api';
import { corpEngine } from './engine';
import { buildCorpChatId } from './ids';
import { showSystemNotification } from './wakeup';

const NOTIFICATION_DURATION = 15000;
const PREVIEW_LENGTH = 120;

const [getCorpSavedItems, setCorpSavedItems] = createSignal<CorpSavedItem[] | undefined>();
const [getSavedModalOpen, setSavedModalOpen] = createSignal(false);
// The message waiting for a reminder time
const [getReminderTarget, setReminderTarget] = createSignal<{ chatId: number; messageId: number } | undefined>();

export { getCorpSavedItems, getReminderTarget, getSavedModalOpen, setReminderTarget, setSavedModalOpen };

export function findCorpSavedItem(chatId: number, messageId: number) {
  return getCorpSavedItems()?.find((item) => item.chatId === chatId && item.messageId === messageId);
}

export function clearCorpSaved() {
  setCorpSavedItems(undefined);
}

export async function loadCorpSaved() {
  const credentials = corpEngine.credentials;
  if (!credentials) return;
  try {
    setCorpSavedItems(await fetchCorpSaved(credentials.server, credentials.token));
  } catch (err) {
    corpEngine.handleFailure(err);
  }
}

function replaceItem(item: CorpSavedItem) {
  const items = getCorpSavedItems() || [];
  const rest = items.filter(({ id }) => id !== item.id);
  setCorpSavedItems([item, ...rest]);
}

export async function saveCorpMessageItem(messageId: number, remindAt?: Date) {
  const credentials = corpEngine.credentials;
  if (!credentials) return;
  const actions = getActions();
  try {
    const item = await saveCorpMessage(credentials.server, credentials.token, messageId, remindAt?.toISOString());
    replaceItem(item);
    actions.showNotification({ message: { key: remindAt ? 'TeleTwinReminderSet' : 'TeleTwinSavedDone' } });
  } catch (err) {
    corpEngine.handleFailure(err);
    actions.showNotification({ message: { key: 'TeleTwinErrorNetwork' } });
  }
}

export async function removeCorpSavedItem(id: number) {
  const credentials = corpEngine.credentials;
  if (!credentials) return;
  try {
    await deleteCorpSaved(credentials.server, credentials.token, id);
    setCorpSavedItems((getCorpSavedItems() || []).filter((item) => item.id !== id));
  } catch (err) {
    corpEngine.handleFailure(err);
  }
}

export async function markCorpSavedDone(id: number) {
  const credentials = corpEngine.credentials;
  if (!credentials) return;
  try {
    await updateCorpSaved(credentials.server, credentials.token, id, { done: true });
    setCorpSavedItems((getCorpSavedItems() || []).filter((item) => item.id !== id));
  } catch (err) {
    corpEngine.handleFailure(err);
  }
}

// Opens a corp message: thread replies open in their thread
export function openCorpMessage(chatId: number, messageId: number, threadRootId?: number | null) {
  const actions = getActions();
  actions.focusMessage({
    chatId: buildCorpChatId(chatId),
    messageId,
    threadId: threadRootId || undefined,
    shouldReplaceHistory: true,
  });
}

// A due reminder: in-app toast with "Ochish" and a system notification when the page is hidden
export function handleCorpReminder({ savedId, chatId, messageId }: CorpReminder) {
  const item = getCorpSavedItems()?.find(({ id }) => id === savedId);
  const message = item?.message;
  const text = (message?.text || '').slice(0, PREVIEW_LENGTH);
  const lang = getTranslationFn();
  const notificationText = lang('TeleTwinReminderIncoming', { text });
  const corpChatId = buildCorpChatId(chatId);

  const actions = getActions();
  Object.values(getGlobal().byTabId).forEach(({ id: tabId }) => {
    actions.showNotification({
      message: notificationText,
      duration: NOTIFICATION_DURATION,
      actionText: { key: 'TeleTwinOpen' },
      action: {
        action: 'focusMessage',
        payload: {
          chatId: corpChatId, messageId, threadId: message?.threadRootId || undefined, tabId,
        },
      },
      tabId,
    });
  });
  if (document.visibilityState !== 'visible') showSystemNotification(notificationText, corpChatId, 'teletwin-reminder');

  void loadCorpSaved();
}
