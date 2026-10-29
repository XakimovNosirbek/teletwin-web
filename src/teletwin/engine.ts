// Corp sync engine, ported from the PWA client (`web/src/corp.ts`) and the desktop fork (`corp_manager.cpp`):
//  - session start -> GET chats -> per chat GET messages?limit=100 -> fabricated chats/messages enter global state
//  - hub: WebSockets only, `access_token` query, `Ready()` after connect, then catch up every loaded chat
//    with GET messages?afterId=<last id>
//  - events: `message` (dedupe by id), `chats_changed` (reload chats), `logout` (revoke)
//  - hub closed -> GET me: 401 -> revoke, otherwise reconnect with backoff 1 s, 2 s, 4 s ... 30 s (reset on connect)
//  - any API 401 -> revoke
// The engine runs in the master tab only; global state reaches other tabs through the multitab diff sync.
import type { HubConnection } from '@microsoft/signalr';
import { HttpTransportType, HubConnectionBuilder, LogLevel } from '@microsoft/signalr';
import { getActions, getGlobal, setGlobal } from '../global';

import type { ApiMessage } from '../api/types';
import type { GlobalState } from '../global/types';
import type { CorpChatInfo, CorpMessage } from './api';
import type { CorpSnapshot } from './state';
import type { CorpCredentials } from './storage';
import { MAIN_THREAD_ID } from '../api/types';

import { updateUsers } from '../global/reducers';
import { selectChatMessage, selectCurrentMessageList } from '../global/selectors';
import { selectThreadReadState } from '../global/selectors/threads';
import { getCurrentTabId } from '../util/establishMultitabRole';
import { getTranslationFn } from '../util/localization';
import {
  buildCorpHubUrl, fetchCorpChats, fetchCorpMe, fetchCorpMessages, isCorpUnauthorized, logoutCorp,
} from './api';
import { buildCorpChatId, buildCorpUserId, isCorpChatId } from './ids';
import {
  applyCorpSnapshot, buildCorpMessage, buildCorpUser, isCorpSnapshotApplied, removeCorpData,
} from './state';
import {
  loadCredentials, loadReadMarks, removeCredentials, saveReadMarks,
} from './storage';

const HISTORY_LIMIT = 100;
// The server clamps `limit` to 1..200 and has no "before id" paging: this is the deepest history available
const HISTORY_MAX = 200;
const RESYNC_MAX_PAGES = 10;
const RECONNECT_DELAY_MIN = 1000;
const RECONNECT_DELAY_MAX = 30000;
const RESTORE_LIMIT_PER_WINDOW = 20;
const RESTORE_WINDOW = 10000;

type StatusListener = (credentials?: CorpCredentials) => void;

class CorpEngine {
  telegramUserId?: string;

  credentials?: CorpCredentials;

  onStatusChange?: StatusListener;

  private epoch = 0;

  private chats: CorpChatInfo[] = [];

  private areChatsLoaded = false;

  private messagesByChat: Record<number, CorpMessage[]> = {};

  private canLoadOlder: Record<number, boolean> = {};

  private readMarks: Record<number, number> = {};

  private snapshot?: CorpSnapshot;

  private connection?: HubConnection;

  private isHubWanted = false;

  private reconnectDelay = RECONNECT_DELAY_MIN;

  private reconnectTimer?: ReturnType<typeof setTimeout>;

  private isReconnectScheduled = false;

  private isResyncing = false;

  private restoreTimestamps: number[] = [];

  private loadingOlder = new Set<number>();

  private isMaster = false;

  private isSessionActive = false;

  // ---- lifecycle ----

  // Every tab binds to the current Telegram account and knows the credentials, only the master tab syncs
  bind(telegramUserId: string, isMaster: boolean) {
    if (this.telegramUserId !== telegramUserId) {
      this.unbind();
      this.telegramUserId = telegramUserId;
      this.isMaster = isMaster;
      this.reloadCredentials();
      return;
    }

    if (this.isMaster === isMaster) return;
    this.isMaster = isMaster;
    if (isMaster && this.credentials) {
      this.startSession();
    } else {
      this.stopSession();
    }
  }

  unbind() {
    if (!this.telegramUserId) return;
    this.stopSession();
    this.telegramUserId = undefined;
    this.credentials = undefined;
    this.onStatusChange?.(undefined);
  }

  get hasSession() {
    return this.isSessionActive;
  }

  // Credentials changed in storage: a login, a logout or a revoke, possibly in another tab
  reloadCredentials() {
    const credentials = this.telegramUserId ? loadCredentials(this.telegramUserId) : undefined;
    if (credentials?.token === this.credentials?.token) return;

    const hadCredentials = Boolean(this.credentials);
    this.stopSession();
    this.credentials = credentials;
    if (hadCredentials && !credentials && this.isMaster) removeCorpEverywhere();
    this.onStatusChange?.(credentials);
    if (credentials && this.isMaster) this.startSession();
  }

  async logout() {
    const credentials = this.credentials;
    this.wipe();
    if (credentials) {
      try {
        await logoutCorp(credentials.server, credentials.token);
      } catch {
        // The session is dropped locally anyway
      }
    }
  }

  revoke() {
    if (!this.credentials) return;
    this.wipe();

    const actions = getActions();
    const tabIds = this.isMaster ? Object.keys(getGlobal().byTabId).map(Number) : [getCurrentTabId()];
    tabIds.forEach((tabId) => {
      actions.showNotification({ message: { key: 'TeleTwinRevoked' }, icon: 'lock', tabId });
    });
  }

  private wipe() {
    if (this.telegramUserId) removeCredentials(this.telegramUserId);
    this.stopSession();
    this.credentials = undefined;
    // Other tabs follow through the multitab diff sync and the `storage` event
    removeCorpEverywhere();
    this.onStatusChange?.(undefined);
  }

  private startSession() {
    this.stopSession();
    this.isSessionActive = true;
    this.readMarks = loadReadMarks(this.telegramUserId!, this.credentials!.employee.id);
    void this.loadChats();
    this.connectHub();
  }

  private stopSession() {
    this.epoch++;
    this.isSessionActive = false;
    this.disconnectHub();
    this.chats = [];
    this.areChatsLoaded = false;
    this.messagesByChat = {};
    this.canLoadOlder = {};
    this.readMarks = {};
    this.snapshot = undefined;
    this.loadingOlder.clear();
  }

  private handleFailure(err: unknown) {
    if (isCorpUnauthorized(err)) this.revoke();
  }

  // ---- global state ----

  private getSnapshot() {
    if (!this.snapshot) {
      this.snapshot = {
        telegramUserId: this.telegramUserId!,
        employee: this.credentials!.employee,
        chats: this.chats,
        messagesByChat: this.messagesByChat,
        readMarks: this.readMarks,
        folderTitle: getTranslationFn()('TeleTwinFolderTitle'),
      };
    }

    return this.snapshot;
  }

  private commit() {
    this.snapshot = undefined;
    let global = getGlobal();
    global = applyCorpSnapshot(global, this.getSnapshot());
    setGlobal(global);
  }

  // Runs after every global change: Telegram syncs replace chat lists, folders and message stores wholesale
  handleGlobalChange(currentGlobal: GlobalState) {
    if (!this.credentials || !this.areChatsLoaded) return;

    this.saveChangedReadMarks(currentGlobal);

    const snapshot = this.getSnapshot();
    if (isCorpSnapshotApplied(currentGlobal, snapshot)) return;

    const now = Date.now();
    this.restoreTimestamps = this.restoreTimestamps.filter((timestamp) => now - timestamp < RESTORE_WINDOW);
    if (this.restoreTimestamps.length >= RESTORE_LIMIT_PER_WINDOW) return;
    this.restoreTimestamps.push(now);

    let global = getGlobal();
    global = applyCorpSnapshot(global, snapshot);
    setGlobal(global);
  }

  private saveChangedReadMarks(global: GlobalState) {
    let isChanged = false;
    this.chats.forEach((chat) => {
      const lastRead = selectThreadReadState(global, buildCorpChatId(chat.id), MAIN_THREAD_ID)?.lastReadInboxMessageId;
      if (lastRead && Number.isInteger(lastRead) && lastRead > (this.readMarks[chat.id] ?? 0)) {
        this.readMarks[chat.id] = lastRead;
        isChanged = true;
      }
    });

    if (isChanged) saveReadMarks(this.telegramUserId!, this.credentials!.employee.id, this.readMarks);
  }

  // ---- chats & history ----

  async loadChats() {
    const credentials = this.credentials;
    if (!credentials || !this.isSessionActive) return;
    const epoch = this.epoch;

    try {
      const chats = await fetchCorpChats(credentials.server, credentials.token);
      if (epoch !== this.epoch) return;
      this.applyChats(chats);
    } catch (err) {
      if (epoch === this.epoch) this.handleFailure(err);
    }
  }

  private applyChats(chats: CorpChatInfo[]) {
    const ids = new Set(chats.map((chat) => chat.id));
    const goneChatIds = this.chats.filter((chat) => !ids.has(chat.id)).map((chat) => buildCorpChatId(chat.id));
    const changedChatIds = this.chats.filter((old) => {
      const chat = chats.find(({ id }) => id === old.id);
      return chat && (chat.title !== old.title || chat.canPost !== old.canPost || chat.kind !== old.kind);
    }).map((chat) => buildCorpChatId(chat.id));

    Object.keys(this.messagesByChat).map(Number).filter((id) => !ids.has(id)).forEach((id) => {
      delete this.messagesByChat[id];
    });
    this.chats = chats;
    this.areChatsLoaded = true;

    if (goneChatIds.length || changedChatIds.length) {
      closeCorpChats(goneChatIds);
      // Changed chats are rebuilt from scratch on commit, gone ones disappear
      let global = getGlobal();
      global = removeCorpData(global, [...goneChatIds, ...changedChatIds]);
      setGlobal(global);
    }
    this.commit();

    chats.filter((chat) => !this.messagesByChat[chat.id]).forEach((chat) => {
      void this.loadHistory(chat.id, HISTORY_LIMIT);
    });
  }

  private async loadHistory(chatId: number, limit: number) {
    const credentials = this.credentials;
    if (!credentials) return;
    const epoch = this.epoch;

    try {
      const list = await fetchCorpMessages(credentials.server, credentials.token, chatId, 0, limit);
      if (epoch !== this.epoch || !this.chats.some((chat) => chat.id === chatId)) return;
      this.mergeMessages(chatId, list);
      this.canLoadOlder[chatId] = limit < HISTORY_MAX && list.length >= limit;
      this.commit();
    } catch (err) {
      if (epoch === this.epoch) this.handleFailure(err);
    }
  }

  // The API has no "before id" paging: the only way further back is a bigger "latest N" page
  loadOlder(serverChatId: number) {
    if (!this.canLoadOlder[serverChatId] || this.loadingOlder.has(serverChatId)) return;
    this.loadingOlder.add(serverChatId);
    this.canLoadOlder[serverChatId] = false;
    void this.loadHistory(serverChatId, HISTORY_MAX).finally(() => this.loadingOlder.delete(serverChatId));
  }

  private mergeMessages(chatId: number, incoming: CorpMessage[]) {
    const byId = new Map<number, CorpMessage>();
    (this.messagesByChat[chatId] || []).forEach((dto) => byId.set(dto.id, dto));
    incoming.forEach((dto) => {
      if (!byId.has(dto.id)) byId.set(dto.id, dto);
    });
    this.messagesByChat[chatId] = [...byId.values()].sort((a, b) => a.id - b.id);
  }

  private async resync() {
    const credentials = this.credentials;
    if (!credentials || this.isResyncing) return;
    this.isResyncing = true;
    const epoch = this.epoch;

    try {
      for (const chat of this.chats) {
        for (let page = 0; page < RESYNC_MAX_PAGES; page++) {
          const known = this.messagesByChat[chat.id];
          if (!known) break;
          const lastId = known.length ? known[known.length - 1].id : 0;
          const list = await fetchCorpMessages(credentials.server, credentials.token, chat.id, lastId, HISTORY_LIMIT);
          if (epoch !== this.epoch) return;
          list.forEach((dto) => this.applyLive(dto));
          if (list.length < HISTORY_LIMIT) break;
        }
      }
    } catch (err) {
      if (epoch === this.epoch) this.handleFailure(err);
    } finally {
      this.isResyncing = false;
    }
  }

  // A message from the hub, a resync page or our own POST response (`localId` is the pending bubble to resolve)
  applyLive(dto: CorpMessage, localId?: number) {
    const chat = this.chats.find(({ id }) => id === dto.chatId);
    const list = this.messagesByChat[dto.chatId];
    if (!chat || !list) return;
    const isKnown = list.some(({ id }) => id === dto.id);
    if (isKnown && localId === undefined) return;

    if (!isKnown) {
      this.mergeMessages(dto.chatId, [dto]);
      this.snapshot = undefined;
    }
    publishCorpMessage(dto, chat, this.credentials!.employee.id, localId);
  }

  // ---- realtime hub ----

  private connectHub() {
    const credentials = this.credentials;
    if (!credentials) return;

    this.isHubWanted = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.isReconnectScheduled = false;
    this.connection?.stop().catch(() => undefined);

    const connection = new HubConnectionBuilder()
      .withUrl(buildCorpHubUrl(credentials.server), {
        transport: HttpTransportType.WebSockets,
        skipNegotiation: true,
        accessTokenFactory: () => this.credentials?.token || '',
      })
      .configureLogging(LogLevel.None)
      .build();
    this.connection = connection;
    const isCurrent = () => this.connection === connection && this.isHubWanted;

    connection.on('message', (dto: CorpMessage) => {
      if (isCurrent()) this.applyLive(dto);
    });
    connection.on('chats_changed', () => {
      if (isCurrent()) void this.loadChats();
    });
    connection.on('logout', () => {
      if (!isCurrent()) return;
      this.isHubWanted = false;
      this.revoke();
    });
    connection.onclose(() => {
      if (isCurrent()) this.scheduleReconnect();
    });

    connection.start()
      .then(() => {
        if (!isCurrent()) return undefined;
        this.reconnectDelay = RECONNECT_DELAY_MIN;
        return connection.invoke<number>('Ready').then(() => {
          if (isCurrent()) void this.resync();
        });
      })
      .catch(() => {
        if (!isCurrent()) return;
        connection.stop().catch(() => undefined);
        this.scheduleReconnect();
      });
  }

  private disconnectHub() {
    this.isHubWanted = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.isReconnectScheduled = false;
    const connection = this.connection;
    this.connection = undefined;
    connection?.stop().catch(() => undefined);
  }

  private scheduleReconnect() {
    const credentials = this.credentials;
    if (!credentials || !this.isHubWanted || this.isReconnectScheduled) return;
    this.isReconnectScheduled = true;
    const epoch = this.epoch;

    const arm = () => {
      if (epoch !== this.epoch || !this.isHubWanted) return;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_DELAY_MAX);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        this.isReconnectScheduled = false;
        if (this.isHubWanted) this.connectHub();
      }, delay);
    };

    // Ask `/me` first, so a revoked session is detected even if the hub just refuses the socket
    fetchCorpMe(credentials.server, credentials.token).then(arm, (err) => {
      if (epoch !== this.epoch) return;
      if (isCorpUnauthorized(err)) {
        this.isReconnectScheduled = false;
        this.isHubWanted = false;
        this.revoke();
        return;
      }
      arm();
    });
  }

  reconnectNow() {
    if (!this.credentials || !this.isHubWanted || !this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.isReconnectScheduled = false;
    this.reconnectDelay = RECONNECT_DELAY_MIN;
    this.connectHub();
  }
}

export const corpEngine = new CorpEngine();

export function publishCorpMessage(dto: CorpMessage, chat: CorpChatInfo, employeeId: number, localId?: number) {
  let global = getGlobal();
  const chatId = buildCorpChatId(chat.id);
  const actions = getActions();
  // `updateMessageSendSucceeded` merges over the pending bubble, so its sending state is cleared explicitly
  const message: ApiMessage = {
    ...buildCorpMessage(dto, chat, employeeId, global.currentUserId!),
    sendingState: undefined,
  };
  const isOwn = dto.senderId === employeeId;

  if (isOwn) {
    // The POST answer names its bubble; a hub echo that wins the race matches it by text
    const pendingId = localId !== undefined && selectChatMessage(global, chatId, localId)
      ? localId
      : findPendingMessage(global, chatId, dto.text)?.id;
    if (pendingId !== undefined) {
      actions.apiUpdate({
        '@type': 'updateMessageSendSucceeded', chatId, localId: pendingId, message,
      });
      return;
    }
  }

  if (selectChatMessage(global, chatId, dto.id)) return;

  if (!isOwn) {
    const userId = buildCorpUserId(dto.senderId);
    if (!global.users.byId[userId]) {
      global = updateUsers(global, { [userId]: buildCorpUser(dto.senderId, dto.senderName) });
      setGlobal(global);
    }
  }

  actions.apiUpdate({
    '@type': 'newMessage', chatId, id: dto.id, message,
  });
}

function findPendingMessage(global: GlobalState, chatId: string, text: string): ApiMessage | undefined {
  const byId = global.messages.byChatId[chatId]?.byId;
  if (!byId) return undefined;

  return Object.values(byId)
    .filter((message) => message.sendingState === 'messageSendingStatePending' && message.content.text?.text === text)
    .sort((a, b) => a.id - b.id)[0];
}

function closeCorpChats(chatIds?: string[]) {
  const actions = getActions();
  const global = getGlobal();
  Object.values(global.byTabId).forEach(({ id: tabId }) => {
    const currentChatId = selectCurrentMessageList(global, tabId)?.chatId;
    const isClosed = chatIds ? chatIds.includes(currentChatId!) : isCorpChatId(currentChatId);
    if (isClosed) actions.openChat({ id: undefined, tabId });
  });
}

function removeCorpEverywhere() {
  closeCorpChats();
  let global = getGlobal();
  global = removeCorpData(global);
  setGlobal(global);
}
