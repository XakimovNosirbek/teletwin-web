// Custom statuses and "do not disturb" of employees (`GET /employees`, `GET /chats/{id}/members`, hub `status_changed`)
import type { CorpStatusFields } from './api';

import { createSignal } from '../util/signals';

export interface CorpStatus {
  emoji?: string;
  text?: string;
  until?: number;
  dndUntil?: number;
}

const MS_IN_SECOND = 1000;

const [getCorpStatuses, setCorpStatuses] = createSignal<Record<number, CorpStatus>>({});
// The wake-up target in DND waiting for "wake up anyway"
const [getDndWakeUp, setDndWakeUp] = createSignal<{
  employeeId: number; serverChatId?: number; name: string;
} | undefined>();

export { getCorpStatuses, getDndWakeUp, setDndWakeUp };

function parseTime(value?: string | null) {
  return value ? Math.floor(new Date(value).getTime() / MS_IN_SECOND) : undefined;
}

export function buildCorpStatus(fields: CorpStatusFields): CorpStatus {
  return {
    emoji: fields.statusEmoji || undefined,
    text: fields.statusText || undefined,
    until: parseTime(fields.statusUntil),
    dndUntil: parseTime(fields.dndUntil),
  };
}

export function setCorpStatus(employeeId: number, status: CorpStatus) {
  const current = getCorpStatuses()[employeeId];
  if (current && current.emoji === status.emoji && current.text === status.text && current.until === status.until
    && current.dndUntil === status.dndUntil) {
    return;
  }

  setCorpStatuses({ ...getCorpStatuses(), [employeeId]: status });
}

export function clearCorpStatuses() {
  setCorpStatuses({});
}

// Expired parts are dropped: the server clears them only every few seconds
export function getActiveCorpStatus(employeeId: number) {
  const status = getCorpStatuses()[employeeId];
  if (!status) return undefined;
  const now = Date.now() / MS_IN_SECOND;
  const hasStatus = Boolean(status.emoji || status.text) && (!status.until || status.until > now);
  const isDnd = Boolean(status.dndUntil && status.dndUntil > now);
  if (!hasStatus && !isDnd) return undefined;

  return {
    emoji: hasStatus ? status.emoji : undefined,
    text: hasStatus ? status.text : undefined,
    isDnd,
  };
}

const [getStatusModalOpen, setStatusModalOpen] = createSignal(false);
export { getStatusModalOpen, setStatusModalOpen };
