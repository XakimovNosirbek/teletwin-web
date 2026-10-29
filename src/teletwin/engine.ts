// Corp sync engine:
//  - session start -> GET config + chats -> per chat GET messages?limit=100 -> fabricated chats/messages enter global state
//  - hub: WebSockets only, `access_token` query, `Ready()` after connect, then catch up every loaded chat
//    with GET messages?afterId=<last id> and GET changes?since=<last sync>
//  - events: `message`, `message_edited`, `messages_deleted`, `reactions`, `pins`, `read`, `typing`, `wakeup`,
//    `presence`, `status_changed`, `mention`, `poll_updated`, `thread_updated`, `scheduled_changed`, `chats_changed` (reload chats), `logout` (revoke)
//  - hub closed -> GET me: 401 -> revoke, otherwise reconnect with backoff 1 s, 2 s, 4 s ... 30 s (reset on connect)
//  - any API 401 -> revoke
// The engine keeps the loaded corp history (`messagesByChat`) and re-applies it after Telegram syncs replace
// sections of global state. It runs in the master tab only; other tabs follow through the multitab diff sync.
import type { HubConnection } from '@microsoft/signalr';
import { HttpTransportType, HubConnectionBuilder, LogLevel } from '@microsoft/signalr';
import { getActions, getGlobal, setGlobal } from '../global';

import type { ApiMessage, ApiMessagePoll, ApiTypingStatus } from '../api/types';
import type { GlobalState } from '../global/types';
import type {
  CorpChatInfo, CorpMention, CorpMessage, CorpPoll, CorpPresence, CorpReaction, CorpThreadUpdate,
} from './api';
import type { CorpLinkRule, CorpSnapshot } from './state';
import type { CorpCredentials } from './storage';
import { MAIN_THREAD_ID } from '../api/types';

import { addUserStatuses, updateChat, updateUsers } from '../global/reducers';
import { replaceThreadLocalStateParam, updateThreadInfo, updateThreadReadState } from '../global/reducers/threads';
import { selectChatMessage, selectCurrentMessageList, selectPoll } from '../global/selectors';
import { selectThreadLocalStateParam, selectThreadReadState } from '../global/selectors/threads';
import { getCurrentTabId } from '../util/establishMultitabRole';
import { getTranslationFn } from '../util/localization';
import { getServerTime } from '../util/serverTime';
import {
  buildCorpHubUrl, fetchCorpChanges, fetchCorpChats, fetchCorpConfig, fetchCorpEmployees, fetchCorpGroups, fetchCorpMe,
  fetchCorpMessages, isCorpUnauthorized, logoutCorp, openCorpDirectChat,
} from './api';
import {
  buildCorpChatId, buildCorpPollId, buildCorpUserId, isCorpChatId, registerCorpDirectChat, setCorpGroupMentions,
} from './ids';
import { clearCorpMedia } from './media';
import {
  applyCorpSnapshot, buildCorpMessage, buildCorpPoll, buildCorpReactions, buildCorpThreadInfo, buildCorpThreadInfoFrom,
  buildCorpUser, buildCorpUserStatus, getCorpChatMutedUntil, isCorpDirectChat, isCorpSnapshotApplied, removeCorpData,
} from './state';
import {
  buildCorpStatus, clearCorpStatuses, setCorpStatus,
} from './status';
import {
  loadCredentials, loadReadMarks, removeCredentials, saveReadMarks,
} from './storage';

const HISTORY_LIMIT = 100;
const RESYNC_MAX_PAGES = 10;
const RECONNECT_DELAY_MIN = 1000;
const RECONNECT_DELAY_MAX = 30000;
const RESTORE_LIMIT_PER_WINDOW = 20;
const RESTORE_WINDOW = 10000;
// The first change feed request reaches back this far before the session start, against clock skew
const CHANGES_OVERLAP = 60000;

const TYPING_ACTIONS: Record<string, Exclude<ApiTypingStatus['type'], 'watchingAnimations'>> = {
  typing: 'typing',
  recordVoice: 'recordAudio',
  recordAudio: 'recordAudio',
  recordRound: 'recordRound',
  recordVideo: 'recordVideo',
  uploadFile: 'uploadFile',
  uploadPhoto: 'uploadPhoto',
  uploadVideo: 'uploadVideo',
  uploadAudio: 'uploadAudio',
  uploadRound: 'uploadRound',
  chooseSticker: 'chooseSticker',
};

type StatusListener = (credentials?: CorpCredentials) => void;

export interface CorpWakeUp {
  fromId: number;
  fromName: string;
  chatId?: number;
}

interface HubPresence extends CorpPresence {
  employeeId: number;
}

interface HubTyping {
  chatId: number;
  employeeId: number;
  fullName: string;
  action: string;
}

class CorpEngine {
  telegramUserId?: string;

  credentials?: CorpCredentials;

  onStatusChange?: StatusListener;

  onBindChange?: (telegramUserId?: string) => void;

  onWakeUp?: (wakeUp: CorpWakeUp) => void;

  onMention?: (mention: CorpMention) => void;

  linkRule?: CorpLinkRule;

  private epoch = 0;

  private chats: CorpChatInfo[] = [];

  private areChatsLoaded = false;

  private messagesByChat: Record<number, CorpMessage[]> = {};

  // Thread replies that are not in the main history, by chat and id; they never enter the snapshot
  private threadRepliesByChat: Record<number, Map<number, CorpMessage>> = {};

  private readMarks: Record<number, number> = {};

  private snapshot?: CorpSnapshot;

  private connection?: HubConnection;

  private isHubWanted = false;

  private reconnectDelay = RECONNECT_DELAY_MIN;

  private reconnectTimer?: ReturnType<typeof setTimeout>;

  private isReconnectScheduled = false;

  private isResyncing = false;

  private changesSince: Record<number, string> = {};

  private sessionStartedAt = 0;

  private pendingByClientId = new Map<string, number>();

  private restoreTimestamps: number[] = [];

  private isMaster = false;

  private isSessionActive = false;

  // ---- lifecycle ----

  // Every tab binds to the current Telegram account and knows the credentials, only the master tab syncs
  bind(telegramUserId: string, isMaster: boolean) {
    if (this.telegramUserId !== telegramUserId) {
      this.unbind();
      this.telegramUserId = telegramUserId;
      this.isMaster = isMaster;
      this.onBindChange?.(telegramUserId);
      this.reloadCredentials(true);
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
    this.onBindChange?.(undefined);
    this.onStatusChange?.(undefined);
  }

  get hasSession() {
    return this.isSessionActive;
  }

  get employeeId() {
    return this.credentials?.employee.id;
  }

  get employeeName() {
    return this.credentials?.employee.fullName;
  }

  // Credentials changed in storage: a login, a logout or a revoke, possibly in another tab
  reloadCredentials(shouldNotify?: boolean) {
    const credentials = this.telegramUserId ? loadCredentials(this.telegramUserId) : undefined;
    if (credentials?.token === this.credentials?.token) {
      if (shouldNotify) this.onStatusChange?.(credentials);
      return;
    }

    const hadCredentials = Boolean(this.credentials);
    this.stopSession();
    this.credentials = credentials;
    if (hadCredentials && !credentials) removeCorpEverywhere(this.isMaster);
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
    removeCorpEverywhere(true);
    this.onStatusChange?.(undefined);
  }

  private startSession() {
    this.stopSession();
    this.isSessionActive = true;
    this.sessionStartedAt = Date.now();
    this.readMarks = loadReadMarks(this.telegramUserId!, this.credentials!.employee.id);
    void this.loadConfig();
    void this.loadGroups();
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
    this.threadRepliesByChat = {};
    this.readMarks = {};
    this.snapshot = undefined;
    this.changesSince = {};
    this.pendingByClientId.clear();
    this.linkRule = undefined;
    setCorpGroupMentions([]);
    clearCorpStatuses();
  }

  handleFailure(err: unknown) {
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
        linkRule: this.linkRule,
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

  // ---- lookups for the provider ----

  getChatInfo(serverChatId: number) {
    return this.chats.find(({ id }) => id === serverChatId);
  }

  getCachedMessages(serverChatId: number) {
    return this.messagesByChat[serverChatId];
  }

  buildMessage(dto: CorpMessage): ApiMessage | undefined {
    const chat = this.getChatInfo(dto.chatId);
    if (!chat || !this.credentials || dto.isDeleted) return undefined;

    this.ensureSender(dto.senderId, dto.senderName);

    const { employee } = this.credentials;
    return buildCorpMessage(dto, chat, employee.id, getGlobal().currentUserId!, this.linkRule, employee.login);
  }

  buildPoll(poll: CorpPoll, senderId: number, isFromHub?: boolean): ApiMessagePoll | undefined {
    if (!this.credentials) return undefined;
    const global = getGlobal();
    const current = selectPoll(global, buildCorpPollId(poll.id));
    const isCreator = senderId === this.employeeId;

    return buildCorpPoll(poll, this.credentials.employee.id, global.currentUserId!, isCreator, current, isFromHub);
  }

  // Polls and thread roots of messages the provider returns: GramJS sends them the same way, next to the messages
  publishEntities(list: CorpMessage[]) {
    const polls = list.map((dto) => dto.poll && this.buildPoll(dto.poll, dto.senderId)).filter(Boolean);
    const threadInfos = list.filter((dto) => dto.thread).map((dto) => this.buildThreadInfo(dto)).filter(Boolean);
    if (!polls.length && !threadInfos.length) return;

    getActions().apiUpdate({
      '@type': 'updateEntities',
      polls: polls.length ? polls : undefined,
      threadInfos: threadInfos.length ? threadInfos : undefined,
    });
  }

  private buildThreadInfo(dto: CorpMessage) {
    const chat = this.getChatInfo(dto.chatId);
    if (!chat || !this.credentials) return undefined;
    return buildCorpThreadInfo(dto, buildCorpChatId(chat.id), this.credentials.employee.id, getGlobal().currentUserId!);
  }

  // Thread replies fetched for the thread view, so live echoes of them are not shown twice
  rememberThreadReplies(serverChatId: number, list: CorpMessage[]) {
    const known = (this.threadRepliesByChat[serverChatId] ||= new Map());
    list.forEach((dto) => {
      if (isThreadOnly(dto)) known.set(dto.id, dto);
    });
  }

  getThreadRoot(serverChatId: number, rootId: number) {
    return this.messagesByChat[serverChatId]?.find(({ id }) => id === rootId);
  }

  applyThreadUpdate({
    chatId: serverChatId, rootId, replyCount, lastReplyAt, recentReplierIds,
  }: CorpThreadUpdate) {
    if (!this.credentials || !this.getChatInfo(serverChatId)) return;
    const root = this.getThreadRoot(serverChatId, rootId);
    this.updateCached(serverChatId, rootId, {
      thread: replyCount ? {
        ...root?.thread, replyCount, lastReplyAt, recentReplierIds,
      } : undefined,
    });

    let global = getGlobal();
    global = updateThreadInfo(global, buildCorpThreadInfoFrom(
      buildCorpChatId(serverChatId), rootId, replyCount, recentReplierIds, this.credentials.employee.id,
      global.currentUserId!,
    ));
    setGlobal(global);
  }

  applyPoll(serverChatId: number, messageId: number, corpPoll: CorpPoll, isFromHub?: boolean) {
    const list = this.messagesByChat[serverChatId];
    const senderId = list?.find(({ id }) => id === messageId)?.senderId;
    this.updateCached(serverChatId, messageId, { poll: corpPoll });
    const poll = this.buildPoll(corpPoll, senderId ?? 0, isFromHub);
    if (!poll) return;

    getActions().apiUpdate({ '@type': 'updateMessagePoll', pollId: poll.summary.id, pollUpdate: poll });
  }

  ensureSender(employeeId: number, fullName: string) {
    if (employeeId === this.credentials?.employee.id) return;
    const userId = buildCorpUserId(employeeId);
    let global = getGlobal();
    if (global.users.byId[userId]) return;

    global = updateUsers(global, { [userId]: buildCorpUser(employeeId, fullName) });
    setGlobal(global);
  }

  // Pages fetched by the provider join the cache when they touch it, so Telegram syncs cannot drop them
  mergeFetched(serverChatId: number, list: CorpMessage[], anchorId?: number) {
    const known = this.messagesByChat[serverChatId];
    if (!known || !list.length) return;
    const isAdjacent = anchorId === undefined || known.some(({ id }) => id === anchorId);
    if (!isAdjacent) return;

    this.mergeMessages(serverChatId, list.filter((dto) => !dto.isDeleted));
    this.snapshot = undefined;
  }

  // ---- config, chats & history ----

  private async loadConfig() {
    const credentials = this.credentials;
    if (!credentials) return;
    const epoch = this.epoch;

    try {
      const config = await fetchCorpConfig(credentials.server, credentials.token);
      if (epoch !== this.epoch || !config?.jiraBaseUrl || !config.jiraKeyPattern) return;
      this.linkRule = { baseUrl: config.jiraBaseUrl, pattern: new RegExp(config.jiraKeyPattern, 'g') };
      this.snapshot = undefined;
      this.relinkLoadedMessages();
    } catch (err) {
      // An old server has no config: messages keep plain text
      if (epoch === this.epoch) this.handleFailure(err);
    }
  }

  // User groups for the mention tooltip; they join global state with the next snapshot
  private async loadGroups() {
    const credentials = this.credentials;
    if (!credentials) return;
    const epoch = this.epoch;

    try {
      const groups = await fetchCorpGroups(credentials.server, credentials.token);
      if (epoch !== this.epoch) return;
      setCorpGroupMentions(groups.map(({ id, handle, name }) => ({ id, handle, name })));
      if (this.areChatsLoaded) this.commit();
    } catch (err) {
      // An old server has no groups
      if (epoch === this.epoch) this.handleFailure(err);
    }
  }

  // Messages built before the config arrived get their issue links now
  private relinkLoadedMessages() {
    const actions = getActions();
    const global = getGlobal();
    Object.values(this.messagesByChat).forEach((list) => {
      list.forEach((dto) => {
        if (!dto.text) return;
        const message = this.buildMessage(dto);
        if (!message || !selectChatMessage(global, message.chatId, dto.id)) return;
        actions.apiUpdate({
          '@type': 'updateMessage', chatId: message.chatId, id: dto.id, message: { content: message.content },
        });
      });
    });
  }

  async loadChats() {
    const credentials = this.credentials;
    if (!credentials || !this.isSessionActive) return;
    const epoch = this.epoch;

    try {
      const chats = await fetchCorpChats(credentials.server, credentials.token);
      if (epoch !== this.epoch) return;
      this.applyChats(chats);
      void this.loadPresence();
    } catch (err) {
      if (epoch === this.epoch) this.handleFailure(err);
    }
  }

  // Online state of everyone, for the direct chat headers and member lists
  private async loadPresence() {
    const credentials = this.credentials;
    if (!credentials || !this.isSessionActive) return;
    const epoch = this.epoch;

    try {
      const employees = await fetchCorpEmployees(credentials.server, credentials.token);
      if (epoch !== this.epoch) return;
      employees.forEach((employee) => {
        this.applyPresence({ ...employee, employeeId: employee.id });
        setCorpStatus(employee.id, buildCorpStatus(employee));
      });
    } catch (err) {
      // An old server has no presence
      if (epoch === this.epoch) this.handleFailure(err);
    }
  }

  applyPresence({ employeeId, isOnline, lastSeenAt }: HubPresence) {
    if (employeeId === this.credentials?.employee.id) return;
    const status = buildCorpUserStatus({ isOnline, lastSeenAt });
    if (!status) return;

    let global = getGlobal();
    global = addUserStatuses(global, { [buildCorpUserId(employeeId)]: status });
    setGlobal(global);
  }

  // A mention of me: the "@" counter of the main history (thread reply alerts are not counted) and the alert
  applyMention(mention: CorpMention) {
    const chatId = buildCorpChatId(mention.chatId);
    let global = getGlobal();
    const readState = selectThreadReadState(global, chatId, MAIN_THREAD_ID);
    if (!mention.threadRootId && readState && !readState.unreadMentions?.includes(mention.messageId)) {
      global = updateThreadReadState(global, chatId, MAIN_THREAD_ID, {
        unreadMentionsCount: (readState.unreadMentionsCount || 0) + 1,
        unreadMentions: readState.unreadMentions
          ? [...readState.unreadMentions, mention.messageId].sort((a, b) => b - a) : undefined,
      });
      setGlobal(global);
    }

    this.onMention?.(mention);
  }

  // Opens (or creates) the direct chat with an employee and returns its chat id
  async openDirectChat(employeeId: number) {
    const credentials = this.credentials;
    if (!credentials) return undefined;

    const chat = await openCorpDirectChat(credentials.server, credentials.token, employeeId);
    if (this.isSessionActive && !this.chats.some(({ id }) => id === chat.id)) {
      this.applyChats([...this.chats, chat]);
    }
    if (isCorpDirectChat(chat)) registerCorpDirectChat(chat.id, chat.peerId);

    return buildCorpChatId(chat.id);
  }

  private applyChats(chats: CorpChatInfo[]) {
    chats.forEach((chat) => {
      if (isCorpDirectChat(chat)) registerCorpDirectChat(chat.id, chat.peerId);
    });
    const ids = new Set(chats.map((chat) => chat.id));
    const goneChatIds = this.chats.filter((chat) => !ids.has(chat.id)).map((chat) => buildCorpChatId(chat.id));
    const changedChatIds = this.chats.filter((old) => {
      const chat = chats.find(({ id }) => id === old.id);
      return chat && (chat.title !== old.title || chat.canPost !== old.canPost || chat.kind !== old.kind
        || chat.isAdmin !== old.isAdmin);
    }).map((chat) => buildCorpChatId(chat.id));

    Object.keys(this.messagesByChat).map(Number).filter((id) => !ids.has(id)).forEach((id) => {
      delete this.messagesByChat[id];
    });
    const isInitial = !this.areChatsLoaded;
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
    if (!isInitial) this.applyChatStates(chats);
    this.applyNotifySettings(chats);

    chats.filter((chat) => !this.messagesByChat[chat.id]).forEach((chat) => {
      void this.loadHistory(chat.id);
    });
  }

  // The corp notification setting as the stock mute state: the chat list badge, the header and notifications
  applyNotifySettings(chats: CorpChatInfo[]) {
    const global = getGlobal();
    const actions = getActions();
    chats.forEach((chat) => {
      const chatId = buildCorpChatId(chat.id);
      const mutedUntil = getCorpChatMutedUntil(chat);
      if ((global.chats.notifyExceptionById?.[chatId]?.mutedUntil ?? 0) === mutedUntil) return;
      actions.apiUpdate({ '@type': 'updateChatNotifySettings', chatId, settings: { mutedUntil } });
    });
  }

  updateNotifySetting(serverChatId: number, notifyLevel: CorpChatInfo['notifyLevel'], mutedUntil?: string | null) {
    const chat = this.getChatInfo(serverChatId);
    if (!chat) return;
    chat.notifyLevel = notifyLevel;
    chat.mutedUntil = mutedUntil;
    this.applyNotifySettings([chat]);
  }

  // Read marks, pins and member counts of chats that are already in global state
  private applyChatStates(chats: CorpChatInfo[]) {
    let global = getGlobal();
    chats.forEach((chat) => {
      const chatId = buildCorpChatId(chat.id);
      if (!global.chats.byId[chatId]) return;
      if (chat.memberCount !== undefined) global = updateChat(global, chatId, { membersCount: chat.memberCount });
      const readState = selectThreadReadState(global, chatId, MAIN_THREAD_ID);
      if (readState && chat.unreadMentionsCount !== undefined
        && (readState.unreadMentionsCount || 0) !== chat.unreadMentionsCount) {
        global = updateThreadReadState(global, chatId, MAIN_THREAD_ID, {
          unreadMentionsCount: chat.unreadMentionsCount || undefined,
          unreadMentions: chat.unreadMentionsCount ? readState.unreadMentions : undefined,
        });
      }
      if (chat.readMaxId && readState && (readState.lastReadOutboxMessageId ?? 0) < chat.readMaxId) {
        global = updateThreadReadState(global, chatId, MAIN_THREAD_ID, { lastReadOutboxMessageId: chat.readMaxId });
      }
    });
    setGlobal(global);

    chats.forEach((chat) => {
      if (chat.pinnedIds) this.applyPins(chat.id, chat.pinnedIds);
    });
  }

  private async loadHistory(chatId: number) {
    const credentials = this.credentials;
    if (!credentials) return;
    const epoch = this.epoch;

    try {
      const list = await fetchCorpMessages(credentials.server, credentials.token, chatId, { limit: HISTORY_LIMIT });
      if (epoch !== this.epoch || !this.getChatInfo(chatId)) return;
      this.messagesByChat[chatId] ||= [];
      this.mergeMessages(chatId, list.filter((dto) => !dto.isDeleted));
      this.commit();
    } catch (err) {
      if (epoch === this.epoch) this.handleFailure(err);
    }
  }

  private mergeMessages(chatId: number, incoming: CorpMessage[]) {
    const byId = new Map<number, CorpMessage>();
    (this.messagesByChat[chatId] || []).forEach((dto) => byId.set(dto.id, dto));
    incoming.forEach((dto) => byId.set(dto.id, dto));
    this.messagesByChat[chatId] = [...byId.values()].sort((a, b) => a.id - b.id);
  }

  private updateCached(chatId: number, messageId: number, update: Partial<CorpMessage>) {
    const list = this.messagesByChat[chatId];
    const index = list?.findIndex(({ id }) => id === messageId) ?? -1;
    if (index === -1) return;
    list[index] = { ...list[index], ...update };
    this.snapshot = undefined;
  }

  private async resync() {
    const credentials = this.credentials;
    if (!credentials || this.isResyncing) return;
    this.isResyncing = true;
    const epoch = this.epoch;
    const initialSince = new Date(this.sessionStartedAt - CHANGES_OVERLAP).toISOString();

    try {
      for (const chat of this.chats) {
        for (let page = 0; page < RESYNC_MAX_PAGES; page++) {
          const known = this.messagesByChat[chat.id];
          if (!known) break;
          const lastId = known.length ? known[known.length - 1].id : 0;
          const list = await fetchCorpMessages(credentials.server, credentials.token, chat.id, {
            afterId: lastId, limit: HISTORY_LIMIT,
          });
          if (epoch !== this.epoch) return;
          list.forEach((dto) => this.applyLive(dto));
          if (list.length < HISTORY_LIMIT) break;
        }

        if (this.messagesByChat[chat.id]) {
          const since = this.changesSince[chat.id] || initialSince;
          const changes = await fetchCorpChanges(credentials.server, credentials.token, chat.id, since).catch((err) => {
            if (isCorpUnauthorized(err)) throw err;
            // An old server has no change feed
            return undefined;
          });
          if (epoch !== this.epoch) return;
          changes?.edited.forEach((dto) => this.applyEdited(dto));
          if (changes?.deletedIds.length) this.applyDeleted(chat.id, changes.deletedIds);
          if (changes?.serverTime) this.changesSince[chat.id] = changes.serverTime;
        }
      }
      void this.loadChats();
    } catch (err) {
      if (epoch === this.epoch) this.handleFailure(err);
    } finally {
      this.isResyncing = false;
    }
  }

  // ---- live events ----

  // A message from the hub, a resync page or our own POST response (`localId` is the pending bubble to resolve)
  applyLive(dto: CorpMessage, localId?: number) {
    const list = this.messagesByChat[dto.chatId];
    if (!this.getChatInfo(dto.chatId) || !list || dto.isDeleted) return;

    if (isThreadOnly(dto)) {
      const known = (this.threadRepliesByChat[dto.chatId] ||= new Map());
      if (known.has(dto.id) && localId === undefined) return;
      known.set(dto.id, dto);
      this.publishMessage(dto, localId);
      return;
    }

    const isKnown = list.some(({ id }) => id === dto.id);
    if (isKnown && localId === undefined) return;

    if (!isKnown) {
      this.mergeMessages(dto.chatId, [dto]);
      this.snapshot = undefined;
    }
    this.publishMessage(dto, localId);
  }

  private publishMessage(dto: CorpMessage, localId?: number) {
    const message = this.buildMessage(dto);
    if (!message) return;
    const { chatId } = message;
    const global = getGlobal();
    const actions = getActions();
    const poll = dto.poll ? this.buildPoll(dto.poll, dto.senderId) : undefined;

    if (dto.senderId === this.employeeId) {
      // The POST answer names its bubble; a hub echo that wins the race matches it by `clientId`
      const echoedLocalId = dto.clientId ? this.pendingByClientId.get(dto.clientId) : undefined;
      if (dto.clientId) this.pendingByClientId.delete(dto.clientId);
      const candidateId = localId ?? echoedLocalId;
      const pendingId = candidateId !== undefined && selectChatMessage(global, chatId, candidateId)
        ? candidateId
        : undefined;
      if (pendingId !== undefined) {
        // `updateMessageSendSucceeded` merges over the pending bubble, so its sending state is cleared explicitly
        actions.apiUpdate({
          '@type': 'updateMessageSendSucceeded',
          chatId,
          localId: pendingId,
          message: { ...message, sendingState: undefined },
          poll,
        });
        return;
      }
    }

    if (selectChatMessage(global, chatId, dto.id)) return;

    actions.apiUpdate({
      '@type': 'newMessage', chatId, id: dto.id, message, poll,
    });
  }

  registerPending(clientId: string, localId: number) {
    this.pendingByClientId.set(clientId, localId);
  }

  forgetPending(clientId: string) {
    this.pendingByClientId.delete(clientId);
  }

  applyEdited(dto: CorpMessage) {
    if (dto.isDeleted) {
      this.applyDeleted(dto.chatId, [dto.id]);
      return;
    }
    this.updateCached(dto.chatId, dto.id, dto);
    const message = this.buildMessage(dto);
    if (!message || !selectChatMessage(getGlobal(), message.chatId, dto.id)) return;

    getActions().apiUpdate({
      '@type': 'updateMessage',
      chatId: message.chatId,
      id: dto.id,
      message,
      isFull: true,
      poll: dto.poll ? this.buildPoll(dto.poll, dto.senderId) : undefined,
    });
  }

  applyDeleted(serverChatId: number, ids: number[]) {
    const list = this.messagesByChat[serverChatId];
    if (list) {
      this.messagesByChat[serverChatId] = list.filter(({ id }) => !ids.includes(id));
      this.snapshot = undefined;
    }

    getActions().apiUpdate({ '@type': 'deleteMessages', ids, chatId: buildCorpChatId(serverChatId) });
  }

  applyReactions(serverChatId: number, messageId: number, reactions: CorpReaction[]) {
    this.updateCached(serverChatId, messageId, { reactions });
    const chatId = buildCorpChatId(serverChatId);
    if (!selectChatMessage(getGlobal(), chatId, messageId)) return;

    getActions().apiUpdate({
      '@type': 'updateMessageReactions',
      chatId,
      id: messageId,
      reactions: buildCorpReactions(reactions, this.employeeId!),
    });
  }

  applyPins(serverChatId: number, pinnedIds: number[]) {
    const chatId = buildCorpChatId(serverChatId);
    const chat = this.getChatInfo(serverChatId);
    if (chat) chat.pinnedIds = pinnedIds;
    (this.messagesByChat[serverChatId] || []).forEach((dto) => {
      const isPinned = pinnedIds.includes(dto.id);
      if (Boolean(dto.isPinned) !== isPinned) this.updateCached(serverChatId, dto.id, { isPinned });
    });

    let global = getGlobal();
    const current = selectThreadLocalStateParam(global, chatId, MAIN_THREAD_ID, 'pinnedIds') || [];
    current.filter((id) => !pinnedIds.includes(id)).forEach((id) => {
      global = updatePinnedFlag(global, chatId, id, false);
    });
    pinnedIds.forEach((id) => {
      global = updatePinnedFlag(global, chatId, id, true);
    });
    global = replaceThreadLocalStateParam(
      global, chatId, MAIN_THREAD_ID, 'pinnedIds', pinnedIds.slice().sort((a, b) => b - a),
    );
    setGlobal(global);
  }

  applyRead(serverChatId: number, employeeId: number, maxId: number) {
    const chatId = buildCorpChatId(serverChatId);
    let global = getGlobal();
    const readState = selectThreadReadState(global, chatId, MAIN_THREAD_ID);
    if (!readState) return;

    if (employeeId === this.employeeId) {
      // Read on another device of the same employee
      if ((readState.lastReadInboxMessageId ?? 0) >= maxId) return;
      const list = this.messagesByChat[serverChatId] || [];
      const unreadCount = list.filter((dto) => dto.id > maxId && dto.senderId !== employeeId).length;
      global = updateThreadReadState(global, chatId, MAIN_THREAD_ID, { lastReadInboxMessageId: maxId, unreadCount });
    } else {
      if ((readState.lastReadOutboxMessageId ?? 0) >= maxId) return;
      global = updateThreadReadState(global, chatId, MAIN_THREAD_ID, { lastReadOutboxMessageId: maxId });
    }
    setGlobal(global);
  }

  private applyTyping({
    chatId: serverChatId, employeeId, fullName, action,
  }: HubTyping) {
    if (employeeId === this.employeeId || !this.getChatInfo(serverChatId)) return;
    this.ensureSender(employeeId, fullName);
    const type = TYPING_ACTIONS[action];

    getActions().apiUpdate({
      '@type': 'updateChatTypingStatus',
      id: buildCorpChatId(serverChatId),
      peerId: buildCorpUserId(employeeId),
      typingStatus: type ? { type, timestamp: getServerTime() } : undefined,
    });
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
    const on = <T>(event: string, handler: (payload: T) => void) => {
      connection.on(event, (payload: T) => {
        if (isCurrent()) handler(payload);
      });
    };

    on<CorpMessage>('message', (dto) => this.applyLive(dto));
    on<CorpMessage>('message_edited', (dto) => this.applyEdited(dto));
    on<{ chatId: number; ids: number[] }>('messages_deleted', ({ chatId, ids }) => this.applyDeleted(chatId, ids));
    on<{ chatId: number; messageId: number; reactions: CorpReaction[] }>('reactions', ({
      chatId, messageId, reactions,
    }) => this.applyReactions(chatId, messageId, reactions));
    on<{ chatId: number; pinnedIds: number[] }>('pins', ({ chatId, pinnedIds }) => this.applyPins(chatId, pinnedIds));
    on<{ chatId: number; employeeId: number; maxId: number }>('read', ({
      chatId, employeeId, maxId,
    }) => this.applyRead(chatId, employeeId, maxId));
    on<HubTyping>('typing', (typing) => this.applyTyping(typing));
    on<CorpThreadUpdate>('thread_updated', (update) => this.applyThreadUpdate(update));
    on<{ chatId: number; messageId: number; poll: CorpPoll }>('poll_updated', ({
      chatId, messageId, poll,
    }) => this.applyPoll(chatId, messageId, poll, true));
    on<CorpWakeUp>('wakeup', (wakeUp) => this.onWakeUp?.(wakeUp));
    on<HubPresence>('presence', (presence) => this.applyPresence(presence));
    on<{ employeeId: number; emoji?: string; text?: string; until?: string; dndUntil?: string }>('status_changed', ({
      employeeId, emoji, text, until, dndUntil,
    }) => setCorpStatus(employeeId, buildCorpStatus({
      statusEmoji: emoji, statusText: text, statusUntil: until, dndUntil,
    })));
    on<CorpMention>('mention', (mention) => this.applyMention(mention));
    on<unknown>('chats_changed', () => void this.loadChats());
    // Own scheduled messages changed on this or another device, or the server sent one
    on<{ chatId: number }>('scheduled_changed', ({ chatId }) => {
      if (this.getChatInfo(chatId)) getActions().loadScheduledHistory({ chatId: buildCorpChatId(chatId) });
    });
    on<unknown>('logout', () => {
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

function isThreadOnly(dto: CorpMessage) {
  return Boolean(dto.threadRootId) && !dto.alsoToChannel;
}

function updatePinnedFlag<T extends GlobalState>(global: T, chatId: string, messageId: number, isPinned: boolean): T {
  const message = selectChatMessage(global, chatId, messageId);
  if (!message || Boolean(message.isPinned) === isPinned) return global;
  const chatMessages = global.messages.byChatId[chatId];

  return {
    ...global,
    messages: {
      ...global.messages,
      byChatId: {
        ...global.messages.byChatId,
        [chatId]: {
          ...chatMessages,
          byId: { ...chatMessages.byId, [messageId]: { ...message, isPinned: isPinned || undefined } },
        },
      },
    },
  };
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

function removeCorpEverywhere(isMaster: boolean) {
  clearCorpMedia();
  if (!isMaster) return;
  closeCorpChats();
  let global = getGlobal();
  global = removeCorpData(global);
  setGlobal(global);
}
