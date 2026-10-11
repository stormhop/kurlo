import { webSocketConnect, webSocketDisconnect, webSocketSend } from '../../backend';
import { emptyHttpResponse } from '../../wire';
import type { HttpRequest, HttpResponse } from '../../backend';
import type { BodyType, RequestTab, SavedRequest, WebSocketMessageEntry, WebSocketSession } from '../../types/models';
import { byteLength, requestTitleFrom } from '../../utils';

const WS_MAX_MESSAGES = 3000;
const WS_MAX_PENDING_MESSAGES = 1000;
const WS_EVENT_FLUSH_MS = 50;

type WebSocketHost = {
  webSocketSessions: Map<string, WebSocketSession>;
  _wsEntryCounter: number;
  _wsPendingMessages: Map<string, WebSocketMessageEntry[]>;
  _wsFlushTimer: number | undefined;
  _wsStartedAt: Map<string, number>;
  _wsHistoryRecorded: Set<string>;
  _wsTouchedAt: Map<string, number>;
  activeRequestId: string;
  url: string;
  bodyType: BodyType;
  bodyContent: string;
  requests: SavedRequest[];
  requestsById: Map<string, SavedRequest>;
  requestError: string;
  requestTab: RequestTab;
  webSocketConnected: boolean;
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
  forgetWebSocketSession: (id: string) => void;
  _emptyWebSocketSession: () => WebSocketSession;
  _wsSetSession: (id: string, patch: Partial<WebSocketSession>) => void;
  _wsAddMessage: (id: string, message: WebSocketMessageEntry) => void;
  _wsAddMessages: (id: string, incoming: WebSocketMessageEntry[]) => void;
  _wsScheduleMessageFlush: () => void;
  _wsFlushMessages: () => void;
  _wsTrimMessages: (messages: WebSocketMessageEntry[]) => WebSocketMessageEntry[];
  _wsHistorySnapshot: (sessionId: string) => SavedRequest | null;
  _recordWebSocketHistoryOnce: (sessionId: string, statusCode: number, status: string, timestamp: number) => Promise<void>;
  _wsOutgoingMessage: (type: WebSocketMessageEntry['type'], data: string, encoding?: 'plain' | 'base64' | '', code?: number) => WebSocketMessageEntry;
};

export const websocketFeature = {
  forgetWebSocketSession(this: WebSocketHost, id: string) {
    if (!this.webSocketSessions.has(id)) return;
    const next = new Map(this.webSocketSessions);
    next.delete(id);
    this.webSocketSessions = next;
    this._wsPendingMessages.delete(id);
    this._wsStartedAt.delete(id);
    this._wsHistoryRecorded.delete(id);
    this._wsTouchedAt.delete(id);
  },
  _emptyWebSocketSession(this: WebSocketHost): WebSocketSession {
    return {
      status: 'idle',
      connectedUrl: '',
      statusText: '',
      connectedAt: 0,
      messages: [],
      clearedMessages: [],
      headers: [],
      protocol: '',
      error: '',
    };
  },
  _wsSetSession(this: WebSocketHost, id: string, patch: Partial<WebSocketSession>) {
    const next = new Map(this.webSocketSessions);
    const existing: WebSocketSession = { ...this._emptyWebSocketSession(), ...(next.get(id) ?? {}) };
    next.set(id, { ...existing, ...patch });
    this.webSocketSessions = next;
    this._wsTouchedAt.set(id, Date.now());
    this.cleanupRealtimeSessions();
  },
  _wsAddMessage(this: WebSocketHost, id: string, message: WebSocketMessageEntry) {
    this._wsAddMessages(id, [message]);
  },
  _wsAddMessages(this: WebSocketHost, id: string, incoming: WebSocketMessageEntry[]) {
    const existing = this.webSocketSessions.get(id);
    if (!existing || !incoming.length) return;
    const pending = this._wsPendingMessages.get(id) ?? [];
    for (const message of incoming) {
      pending.push({ ...message, id: message.id || `ws-${++this._wsEntryCounter}` });
    }
    if (pending.length > WS_MAX_PENDING_MESSAGES) {
      pending.splice(0, pending.length - WS_MAX_PENDING_MESSAGES);
    }
    this._wsPendingMessages.set(id, pending);
    this._wsTouchedAt.set(id, Date.now());
    this._wsScheduleMessageFlush();
  },
  _wsScheduleMessageFlush(this: WebSocketHost) {
    if (this._wsFlushTimer !== undefined) return;
    this._wsFlushTimer = window.setTimeout(() => this._wsFlushMessages(), WS_EVENT_FLUSH_MS);
  },
  _wsFlushMessages(this: WebSocketHost) {
    if (this._wsFlushTimer !== undefined) {
      window.clearTimeout(this._wsFlushTimer);
      this._wsFlushTimer = undefined;
    }
    if (!this._wsPendingMessages.size) return;
    const next = new Map(this.webSocketSessions);
    for (const [id, pending] of this._wsPendingMessages) {
      const existing = next.get(id);
      if (!existing || !pending.length) continue;
      let messages = [...existing.messages, ...pending];
      if (messages.length > WS_MAX_MESSAGES) messages = messages.slice(messages.length - WS_MAX_MESSAGES);
      next.set(id, { ...existing, messages });
    }
    this._wsPendingMessages.clear();
    this.webSocketSessions = next;
  },
  _wsTrimMessages(this: WebSocketHost, messages: WebSocketMessageEntry[]) {
    if (messages.length > WS_MAX_MESSAGES) return messages.slice(messages.length - WS_MAX_MESSAGES);
    return messages;
  },
  _wsHistorySnapshot(this: WebSocketHost, sessionId: string): SavedRequest | null {
    const base = sessionId === this.activeRequestId
      ? this.snapshotActiveRequest()
      : this.requestsById.get(sessionId);
    if (!base) return null;
    return this.normalizeSavedRequestCtx({
      ...base,
      requestType: 'ws',
      method: 'GET',
      name: !base.nameAuto && base.name && base.name !== 'New Request' ? base.name : requestTitleFrom('WS', base.url),
    });
  },
  async _recordWebSocketHistoryOnce(this: WebSocketHost, sessionId: string, statusCode: number, status: string, timestamp: number) {
    if (!sessionId || this._wsHistoryRecorded.has(sessionId)) return;
    const requestSnapshot = this._wsHistorySnapshot(sessionId);
    if (!requestSnapshot) return;
    this._wsHistoryRecorded.add(sessionId);
    const startedAt = this._wsStartedAt.get(sessionId) ?? timestamp;
    await this.recordRequestHistory({
      ...emptyHttpResponse(),
      statusCode,
      status,
      headers: [],
      body: '',
      duration: Math.max(0, timestamp - startedAt),
      size: 0,
      preRequestResult: { tests: [] },
      testResult: { tests: [] },
    }, requestSnapshot);
  },
  async webSocketConnect(this: WebSocketHost) {
    const id = this.activeRequestId;
    if (!id || !this.url.trim()) return;
    const headerError = this.headerValidationErrorForRequest(this.snapshotActiveRequest());
    if (headerError) {
      this.requestError = headerError;
      this.setActiveResponse(null, id);
      this.requestTab = 'headers';
      this._wsSetSession(id, { status: 'error', error: headerError, connectedUrl: this.url.trim() });
      return;
    }
    this._wsPendingMessages.delete(id);
    this._wsStartedAt.set(id, Date.now());
    this._wsHistoryRecorded.delete(id);
    this._wsSetSession(id, {
      status: 'connecting',
      messages: [],
      clearedMessages: [],
      headers: [],
      statusText: '',
      connectedAt: 0,
      protocol: '',
      error: '',
      connectedUrl: this.url.trim(),
    });
    try {
      await this.persistActiveRequestNow();
      try { await this.syncBackendEnvironment(); } catch {  }
      await webSocketConnect(id, this.buildRequest());
    } catch (e) {
      const timestamp = Date.now();
      const message = e instanceof Error ? e.message : String(e);
      this._wsSetSession(id, { status: 'error', error: message });
      this._wsAddMessage(id, {
        id: '', direction: 'system', type: 'error', data: '',
        timestamp, isSystem: true, isError: true, size: 0,
        message,
      });
      await this._recordWebSocketHistoryOnce(id, 0, 'Error', timestamp);
    }
  },
  async webSocketDisconnect(this: WebSocketHost) {
    const id = this.activeRequestId;
    if (!id) return;
    await webSocketDisconnect(id);
    this._wsSetSession(id, { status: 'idle' });
  },
  _wsOutgoingMessage(this: WebSocketHost, type: WebSocketMessageEntry['type'], data: string, encoding: 'plain' | 'base64' | '' = 'plain', code = 0): WebSocketMessageEntry {
    return {
      id: `ws-out-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      direction: 'outgoing',
      type,
      data,
      encoding,
      code,
      size: encoding === 'base64' ? Math.ceil((data.length * 3) / 4) : byteLength(data),
      timestamp: Date.now(),
      isSystem: type === 'ping' || type === 'pong' || type === 'close',
      isError: false,
    };
  },
  async webSocketSendCurrentMessage(this: WebSocketHost) {
    const id = this.activeRequestId;
    if (!id || !this.webSocketConnected) return;
    const data = this.resolveTemplate(this.bodyContent, this.environmentValuesForRequest(this.snapshotActiveRequest()));
    const messageType = this.bodyType === 'binary' ? 'binary' : 'text';
    const result = await webSocketSend(id, { type: messageType, data, encoding: 'plain' });
    if (result.ok) {
      this._wsAddMessage(id, this._wsOutgoingMessage(messageType, data, 'plain'));
    } else {
      this._wsAddMessage(id, {
        id: '', direction: 'system', type: 'error', data: '',
        timestamp: Date.now(), isSystem: true, isError: true, size: 0,
        message: result.error || 'Failed to send WebSocket message',
      });
    }
  },
  async webSocketSendControl(this: WebSocketHost, type: 'ping' | 'pong' | 'close', data = '', code = 1000) {
    const id = this.activeRequestId;
    if (!id || !this.webSocketConnected) return;
    const result = await webSocketSend(id, { type, data, encoding: 'plain', code });
    if (result.ok) {
      this._wsAddMessage(id, this._wsOutgoingMessage(type, data, 'plain', type === 'close' ? code : 0));
      if (type === 'close') this._wsSetSession(id, { status: 'idle' });
    } else {
      this._wsAddMessage(id, {
        id: '', direction: 'system', type: 'error', data: '',
        timestamp: Date.now(), isSystem: true, isError: true, size: 0,
        message: result.error || `Failed to send ${type}`,
      });
    }
  },
  webSocketClearMessages(this: WebSocketHost) {
    const id = this.activeRequestId;
    if (!id) return;
    this._wsFlushMessages();
    const next = new Map(this.webSocketSessions);
    const existing = next.get(id);
    if (existing) {
      next.set(id, {
        ...existing,
        messages: [],
        clearedMessages: this._wsTrimMessages([...(existing.clearedMessages ?? []), ...existing.messages]),
      });
    }
    this.webSocketSessions = next;
  },
  webSocketRestoreMessages(this: WebSocketHost) {
    const id = this.activeRequestId;
    if (!id) return;
    this._wsFlushMessages();
    const next = new Map(this.webSocketSessions);
    const existing = next.get(id);
    if (existing?.clearedMessages?.length) {
      next.set(id, {
        ...existing,
        messages: this._wsTrimMessages([...(existing.clearedMessages ?? []), ...existing.messages]),
        clearedMessages: [],
      });
    }
    this.webSocketSessions = next;
  },
};
