import { getActions, getGlobal } from '../global';

import type { CorpMention } from './api';
import type { CorpWakeUp } from './engine';

import { getTranslationFn } from '../util/localization';
import { createSignal } from '../util/signals';
import { buildCorpChatId } from './ids';

const MUTED_KEY = 'teletwin.wakeup.muted';
const SHAKE_DURATION = 600;
const SHAKE_OFFSET_PX = 12;
const NOTIFICATION_DURATION = 10000;
const QUACK_COUNT = 2;
const QUACK_LENGTH = 0.22;
const QUACK_GAP = 0.08;
const QUACK_START_HZ = 950;
const QUACK_END_HZ = 420;
const QUACK_FORMANT_HZ = 1200;
const QUACK_VOLUME = 0.9;
const QUACK_ATTACK = 0.015;

const [getIsWakeUpMuted, setIsWakeUpMuted] = createSignal(readIsMuted());
// The corp chat whose members are offered for a wake-up
const [getWakeUpPickerChatId, setWakeUpPickerChatId] = createSignal<string | undefined>();

export { getIsWakeUpMuted, getWakeUpPickerChatId, setWakeUpPickerChatId };

export function toggleWakeUpSound() {
  const isMuted = !getIsWakeUpMuted();
  setIsWakeUpMuted(isMuted);
  try {
    if (isMuted) {
      localStorage.setItem(MUTED_KEY, '1');
    } else {
      localStorage.removeItem(MUTED_KEY);
    }
  } catch {
    // Blocked storage: the choice lasts until reload
  }
}

export function handleWakeUp({ fromName, chatId }: CorpWakeUp) {
  const lang = getTranslationFn();
  const text = lang('TeleTwinWakeUpIncoming', { name: fromName });

  if (!getIsWakeUpMuted()) playQuack();
  shakeApp();

  const actions = getActions();
  const corpChatId = chatId ? buildCorpChatId(chatId) : undefined;
  Object.values(getGlobal().byTabId).forEach(({ id: tabId }) => {
    actions.showNotification({
      message: text,
      duration: NOTIFICATION_DURATION,
      actionText: corpChatId ? { key: 'TeleTwinWakeUpOpen' } : undefined,
      action: corpChatId ? { action: 'openChat', payload: { id: corpChatId, tabId } } : undefined,
      tabId,
    });
  });

  showSystemNotification(text, corpChatId);
}

// Mentions alert even in muted chats, unless the chat is open in front of the user
export function handleMention({
  chatId, messageId, fromName, text,
}: CorpMention) {
  const corpChatId = buildCorpChatId(chatId);
  const global = getGlobal();
  const isVisible = document.visibilityState === 'visible';
  const tabs = Object.values(global.byTabId);
  if (isVisible && tabs.some(({ messageLists }) => messageLists[messageLists.length - 1]?.chatId === corpChatId)) {
    return;
  }

  const message = getTranslationFn()('TeleTwinMentionIncoming', { name: fromName, text });
  const actions = getActions();
  tabs.forEach(({ id: tabId }) => {
    actions.showNotification({
      message,
      duration: NOTIFICATION_DURATION,
      actionText: { key: 'TeleTwinWakeUpOpen' },
      action: { action: 'focusMessage', payload: { chatId: corpChatId, messageId, tabId } },
      tabId,
    });
  });

  if (!isVisible) showSystemNotification(message, corpChatId, 'teletwin-mention');
}

function readIsMuted() {
  try {
    return localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

// A synthesized duck call: a falling sawtooth through a nasal band-pass filter, twice
function playQuack() {
  try {
    const context = new AudioContext();
    const start = context.currentTime;
    for (let i = 0; i < QUACK_COUNT; i++) {
      const at = start + i * (QUACK_LENGTH + QUACK_GAP);
      const oscillator = context.createOscillator();
      oscillator.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(QUACK_START_HZ, at);
      oscillator.frequency.exponentialRampToValueAtTime(QUACK_END_HZ, at + QUACK_LENGTH);

      const filter = context.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = QUACK_FORMANT_HZ;

      const gain = context.createGain();
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(QUACK_VOLUME, at + QUACK_ATTACK);
      gain.gain.exponentialRampToValueAtTime(0.001, at + QUACK_LENGTH);

      oscillator.connect(filter).connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + QUACK_LENGTH);
    }
    setTimeout(() => void context.close(), (QUACK_COUNT * (QUACK_LENGTH + QUACK_GAP) + 1) * 1000);
  } catch {
    // No audio output available
  }
}

function shakeApp() {
  const root = document.getElementById('root') || document.body;
  const offset = `${SHAKE_OFFSET_PX}px`;
  root.animate([
    { transform: 'translateX(0)' },
    { transform: `translateX(-${offset})` },
    { transform: `translateX(${offset})` },
    { transform: `translateX(-${offset})` },
    { transform: `translateX(${offset})` },
    { transform: 'translateX(0)' },
  ], { duration: SHAKE_DURATION, easing: 'ease-in-out' });
}

export function showSystemNotification(text: string, corpChatId?: string, tag = 'teletwin-wakeup') {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  try {
    const notification = new Notification(text, { tag, requireInteraction: false });
    notification.onclick = () => {
      window.focus();
      if (corpChatId) getActions().openChat({ id: corpChatId });
      notification.close();
    };
  } catch {
    // Some platforms only allow notifications from a service worker
  }
}
