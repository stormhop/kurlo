import { socketIOConnect, socketIODisconnect, socketIOEmit } from '../../backend';
import { emptyHttpResponse } from '../../wire';
import type { HttpRequest, HttpResponse } from '../../backend';
import type { RequestTab, SavedRequest, SIOArg, SocketIOMessageEntry, SocketIOSession } from '../../types/models';
import { requestTitleFrom } from '../../utils';

const SIO_MAX_MESSAGES = 3000;
const SIO_MAX_PENDING_MESSAGES = 1000;
const SIO_EVENT_FLUSH_MS = 50;

type SocketIOHost = {
  socketIOSessions: Map<string, SocketIOSession>;
  _sioEntryCounter: number;
  _sioPendingMessages: Map<string, SocketIOMessageEntry[]>;
  _sioFlushTimer: number | undefined;
  _sioStartedAt: Map<string, number>;
  _sioHistoryRecorded: Set<string>;
  _sioTouchedAt: Map<string, number>;
  activeRequestId: string;
  url: string;
  requests: SavedRequest[];
  requestsById: Map<string, SavedRequest>;
  requestError: string;
  requestTab: RequestTab;
  sioEventName: string;
  sioNamespace: string;
  sioArgs: SIOArg[];
  sioAck: boolean;
  socketIOConnected: boolean;
  cleanupRealtimeSessions: () => void;
  recordRequestHistory: (httpResponse: HttpResponse, requestSnapshot?: SavedRequest) => Promise<void>;
  snapshotActiveRequest: (options?: { forPersistence?: boolean }) => SavedRequest;
  normalizeSavedRequestCtx: (input: Partial<SavedRequest>) => SavedRequest;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  syncBackendEnvironment: () => Promise<void>;
  buildRequest: () => HttpRequest;
  headerValidationErrorForRequest: (req: SavedRequest, envValues?: Record<string, string>) => string;
  setActiveResponse: (response: HttpResponse | null, requestId?: string) => void;
  resolveTemplate: (value: string, values?: Record<string, string>) => string;
  environmentValuesForRequest: (req: Pick<SavedRequest, 'collectionId'>, envValues?: Record<string, string>) => Record<string, string>;
  forgetSocketIOSession: (id: string) => void;
  _emptySocketIOSession: () => SocketIOSession;
  _sioSetSession: (id: string, patch: Partial<SocketIOSession>) => void;
  _sioAddMessage: (id: string, message: SocketIOMessageEntry) => void;
  _sioAddMessages: (id: string, incoming: SocketIOMessageEntry[]) => void;
  _sioScheduleMessageFlush: () => void;
  _sioFlushMessages: () => void;
  _sioTrimMessages: (messages: SocketIOMessageEntry[]) => SocketIOMessageEntry[];
  _sioHistorySnapshot: (sessionId: string) => SavedRequest | null;
  _recordSocketIOHistoryOnce: (sessionId: string, statusCode: number, status: string, timestamp: number) => Promise<void>;
};

export const socketioFeature = {
  forgetSocketIOSession(this: SocketIOHost, id: string) {
    if (!this.socketIOSessions.has(id)) return;
    const next = new Map(this.socketIOSessions);
    next.delete(id);
    this.socketIOSessions = next;
    this._sioPendingMessages.delete(id);
    this._sioStartedAt.delete(id);
    this._sioHistoryRecorded.delete(id);
    this._sioTouchedAt.delete(id);
  },
  _emptySocketIOSession(this: SocketIOHost): SocketIOSession {
    return { status: 'idle', connectedUrl: '', namespace: '/', connectedAt: 0, messages: [], clearedMessages: [], headers: [], error: '' };
  },
  _sioSetSession(this: SocketIOHost, id: string, patch: Partial<SocketIOSession>) {
    const next = new Map(this.socketIOSessions);
    const existing: SocketIOSession = { ...this._emptySocketIOSession(), ...(next.get(id) ?? {}) };
    next.set(id, { ...existing, ...patch });
    this.socketIOSessions = next;
    this._sioTouchedAt.set(id, Date.now());
    this.cleanupRealtimeSessions();
  },
  _sioAddMessage(this: SocketIOHost, id: string, message: SocketIOMessageEntry) { this._sioAddMessages(id, [message]); },
  _sioAddMessages(this: SocketIOHost, id: string, incoming: SocketIOMessageEntry[]) {
    const existing = this.socketIOSessions.get(id);
    if (!existing || !incoming.length) return;
    const pending = this._sioPendingMessages.get(id) ?? [];
    for (const message of incoming) {
      pending.push({ ...message, id: message.id || `sio-${++this._sioEntryCounter}` });
    }
    if (pending.length > SIO_MAX_PENDING_MESSAGES) {
      pending.splice(0, pending.length - SIO_MAX_PENDING_MESSAGES);
    }
    this._sioPendingMessages.set(id, pending);
    this._sioTouchedAt.set(id, Date.now());
    this._sioScheduleMessageFlush();
  },
  _sioScheduleMessageFlush(this: SocketIOHost) {
    if (this._sioFlushTimer !== undefined) return;
    this._sioFlushTimer = window.setTimeout(() => this._sioFlushMessages(), SIO_EVENT_FLUSH_MS);
  },
  _sioFlushMessages(this: SocketIOHost) {
    if (this._sioFlushTimer !== undefined) { window.clearTimeout(this._sioFlushTimer); this._sioFlushTimer = undefined; }
    if (!this._sioPendingMessages.size) return;
    const next = new Map(this.socketIOSessions);
    for (const [id, pending] of this._sioPendingMessages) {
      const existing = next.get(id);
      if (!existing || !pending.length) continue;
      let messages = [...existing.messages, ...pending];
      if (messages.length > SIO_MAX_MESSAGES) messages = messages.slice(messages.length - SIO_MAX_MESSAGES);
      next.set(id, { ...existing, messages });
    }
    this._sioPendingMessages.clear();
    this.socketIOSessions = next;
  },
  _sioTrimMessages(this: SocketIOHost, messages: SocketIOMessageEntry[]) {
    if (messages.length > SIO_MAX_MESSAGES) return messages.slice(messages.length - SIO_MAX_MESSAGES);
    return messages;
  },
  _sioHistorySnapshot(this: SocketIOHost, sessionId: string): SavedRequest | null {
    const base = sessionId === this.activeRequestId
      ? this.snapshotActiveRequest()
      : this.requestsById.get(sessionId);
    if (!base) return null;
    return this.normalizeSavedRequestCtx({
      ...base,
      requestType: 'socketio',
      method: 'GET',
      name: !base.nameAuto && base.name && base.name !== 'New Request' ? base.name : requestTitleFrom('Socket.IO', base.url),
    });
  },
  async _recordSocketIOHistoryOnce(this: SocketIOHost, sessionId: string, statusCode: number, status: string, timestamp: number) {
    if (!sessionId || this._sioHistoryRecorded.has(sessionId)) return;
    const requestSnapshot = this._sioHistorySnapshot(sessionId);
    if (!requestSnapshot) return;
    this._sioHistoryRecorded.add(sessionId);
    const startedAt = this._sioStartedAt.get(sessionId) ?? timestamp;
    await this.recordRequestHistory({ ...emptyHttpResponse(), statusCode, status, duration: Math.max(0, timestamp - startedAt) }, requestSnapshot);
  },
  async socketIOConnect(this: SocketIOHost) {
    const id = this.activeRequestId;
    if (!id || !this.url.trim()) return;
    const headerError = this.headerValidationErrorForRequest(this.snapshotActiveRequest());
    if (headerError) {
      this.requestError = headerError;
      this.setActiveResponse(null, id);
      this.requestTab = 'headers';
      this._sioSetSession(id, { status: 'error', error: headerError, connectedUrl: this.url.trim() });
      return;
    }
    this._sioPendingMessages.delete(id);
    this._sioStartedAt.set(id, Date.now());
    this._sioHistoryRecorded.delete(id);
    this._sioSetSession(id, { status: 'connecting', messages: [], clearedMessages: [], namespace: this.sioNamespace || '/', error: '', connectedUrl: this.url.trim(), connectedAt: 0 });
    try {
      await this.persistActiveRequestNow();
      try { await this.syncBackendEnvironment(); } catch {  }
      await socketIOConnect(id, this.buildRequest());
    } catch (e) {
      const timestamp = Date.now();
      const message = e instanceof Error ? e.message : String(e);
      this._sioSetSession(id, { status: 'error', error: message });
      this._sioAddMessage(id, { id: '', direction: 'system', eventName: '', args: [], namespace: '/', timestamp, isSystem: true, isError: true, message });
      await this._recordSocketIOHistoryOnce(id, 0, 'Error', timestamp);
    }
  },
  async socketIODisconnect(this: SocketIOHost) {
    const id = this.activeRequestId;
    if (!id) return;
    await socketIODisconnect(id);
    this._sioSetSession(id, { status: 'idle' });
  },
  async socketIOEmitCurrentMessage(this: SocketIOHost) {
    const id = this.activeRequestId;
    if (!id || !this.socketIOConnected) return;
    const eventName = this.sioEventName.trim() || 'message';
    const namespace = this.sioNamespace || '/';
    const envValues = this.environmentValuesForRequest(this.snapshotActiveRequest());
    const args = this.sioArgs.map(a => {
      if (a.bodyType === 'binary') return a.content;
      return this.resolveTemplate(a.content, envValues);
    });
    const result = await socketIOEmit(id, { eventName, args, namespace, ack: this.sioAck });
    const timestamp = Date.now();
    if (result.ok) {
      this._sioAddMessage(id, { id: `sio-out-${timestamp}`, direction: 'outgoing', eventName, args, namespace, timestamp, isSystem: false, isError: false });
    } else {
      this._sioAddMessage(id, { id: '', direction: 'system', eventName: '', args: [], namespace, timestamp, isSystem: true, isError: true, message: result.error || 'Failed to emit Socket.IO event' });
    }
  },
  socketIOClearMessages(this: SocketIOHost) {
    const id = this.activeRequestId;
    if (!id) return;
    this._sioFlushMessages();
    const next = new Map(this.socketIOSessions);
    const existing = next.get(id);
    if (existing) {
      next.set(id, { ...existing, messages: [], clearedMessages: this._sioTrimMessages([...(existing.clearedMessages ?? []), ...existing.messages]) });
    }
    this.socketIOSessions = next;
  },
  socketIORestoreMessages(this: SocketIOHost) {
    const id = this.activeRequestId;
    if (!id) return;
    this._sioFlushMessages();
    const next = new Map(this.socketIOSessions);
    const existing = next.get(id);
    if (existing?.clearedMessages?.length) {
      next.set(id, { ...existing, messages: this._sioTrimMessages([...(existing.clearedMessages ?? []), ...existing.messages]), clearedMessages: [] });
    }
    this.socketIOSessions = next;
  },
};
