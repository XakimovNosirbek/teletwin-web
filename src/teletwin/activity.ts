// Activity feed of the corp employee (`GET /me/activity`): mentions, thread replies and reactions to my messages.
// The server keeps no read state for it, so "seen" is the newest `at` the employee has looked at, per device.
import type { CorpActivityItem } from './api';

import { createSignal } from '../util/signals';
import { fetchCorpActivity } from './api';
import { corpEngine } from './engine';

const PAGE_SIZE = 50;
const SEEN_KEY_PREFIX = 'teletwin.activity.seen.';

const [getCorpActivity, setCorpActivity] = createSignal<CorpActivityItem[] | undefined>();
const [getActivitySeenAt, setActivitySeenAt] = createSignal(0);
const [getActivityModalOpen, setActivityModalOpen] = createSignal(false);

export { getActivityModalOpen, getActivitySeenAt, getCorpActivity, setActivityModalOpen };

function getSeenKey() {
  const credentials = corpEngine.credentials;
  return credentials ? `${SEEN_KEY_PREFIX}${corpEngine.telegramUserId}.${credentials.employee.id}` : undefined;
}

function readSeenAt() {
  const key = getSeenKey();
  if (!key) return 0;
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}

export function isCorpActivityUnread(item: CorpActivityItem, seenAt = getActivitySeenAt()) {
  return new Date(item.at).getTime() > seenAt;
}

export function getCorpActivityUnreadCount() {
  const seenAt = getActivitySeenAt();
  return getCorpActivity()?.filter((item) => isCorpActivityUnread(item, seenAt)).length || 0;
}

export function clearCorpActivity() {
  setCorpActivity(undefined);
  setActivitySeenAt(0);
}

export async function loadCorpActivity() {
  const credentials = corpEngine.credentials;
  if (!credentials) return;
  setActivitySeenAt(readSeenAt());
  try {
    const items = await fetchCorpActivity(credentials.server, credentials.token, PAGE_SIZE);
    setCorpActivity(items.filter((item) => corpEngine.getChatInfo(item.chatId)));
  } catch (err) {
    corpEngine.handleFailure(err);
  }
}

export function markCorpActivityRead() {
  const newest = getCorpActivity()?.reduce((max, item) => Math.max(max, new Date(item.at).getTime()), 0) || 0;
  const seenAt = Math.max(newest, getActivitySeenAt());
  setActivitySeenAt(seenAt);
  const key = getSeenKey();
  if (!key) return;
  try {
    localStorage.setItem(key, String(seenAt));
  } catch {
    // Private mode: the unread count resets with the page
  }
}
