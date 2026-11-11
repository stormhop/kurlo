import { sseDisconnect, socketIODisconnect, webSocketDisconnect } from '../../backend';
import type {
  KeyValue,
  ResponseTimings,
  SSEEventEntry,
  SSESession,
  SocketIOHandshake,
  SocketIOMessageEntry,
  SocketIOSession,
  WebSocketMessageEntry,
  WebSocketSession,
} from '../../types/models';
import { listenRuntime } from '../../runtimeEvents';

const REALTIME_MAX_STORED_SESSIONS = 24;
const REALTIME_IDLE_SESSION_TTL_MS = 30 * 60 * 1000;

type RealtimeStatus = { status: string };

type RealtimeHost = {
  activeRequestId: string;
  openRequestIds: string[];
  sseSessions: Map<string, SSESession>;
  socketIOSessions: Map<string, SocketIOSession>;
  url: string;
  webSocketSessions: Map<string, WebSocketSession>;
  _sioTouchedAt: Map<string, number>;
  _sseStartedAt: Map<string, number>;
  _sseTouchedAt: Map<string, number>;
  _wsTouchedAt: Map<string, number>;
  cleanupRealtimeSessions: () => void;
  forgetSSESession: (id: string) => void;
  forgetSocketIOSession: (id: string) => void;
  forgetWebSocketSession: (id: string) => void;
  realtimeProtectedSessionIds: () => Set<string>;
  realtimeSessionIdsToPrune: <T extends RealtimeStatus>(sessions: Map<string, T>, touchedAt: Map<string, number>) => string[];
  realtimeStatusIsActive: (status: string) => boolean;
  _recordSSEHistoryOnce: (sessionId: string, statusCode: number, status: string, timestamp: number) => Promise<void>;
  _recordSocketIOHistoryOnce: (sessionId: string, statusCode: number, status: string, timestamp: number) => Promise<void>;
  _recordWebSocketHistoryOnce: (sessionId: string, statusCode: number, status: string, timestamp: number) => Promise<void>;
  _sioAddMessage: (id: string, message: SocketIOMessageEntry) => void;
  _sioAddMessages: (id: string, messages: SocketIOMessageEntry[]) => void;
  _sioFlushMessages: () => void;
  _sioSetSession: (id: string, patch: Partial<SocketIOSession>) => void;
  _sseAddEvent: (id: string, event: SSEEventEntry) => void;
  _sseAddEvents: (id: string, events: SSEEventEntry[]) => void;
  _sseSetSession: (id: string, patch: Partial<SSESession>) => void;
  _wsAddMessage: (id: string, message: WebSocketMessageEntry) => void;
  _wsAddMessages: (id: string, messages: WebSocketMessageEntry[]) => void;
  _wsSetSession: (id: string, patch: Partial<WebSocketSession>) => void;
};

export const realtimeFeature = {
  get currentSSESession(): SSESession | undefined {
    const host = this as unknown as RealtimeHost;
    return host.sseSessions.get(host.activeRequestId);
  },

  get currentWebSocketSession(): WebSocketSession | undefined {
    const host = this as unknown as RealtimeHost;
    return host.webSocketSessions.get(host.activeRequestId);
  },

  get webSocketConnected(): boolean {
    const host = this as unknown as RealtimeHost & { currentWebSocketSession: WebSocketSession | undefined };
    return host.currentWebSocketSession?.status === 'connected';
  },

  get webSocketConnecting(): boolean {
    const host = this as unknown as RealtimeHost & { currentWebSocketSession: WebSocketSession | undefined };
    return host.currentWebSocketSession?.status === 'connecting' || host.currentWebSocketSession?.status === 'reconnecting';
  },

  get currentSocketIOSession(): SocketIOSession | undefined {
    const host = this as unknown as RealtimeHost;
    return host.socketIOSessions.get(host.activeRequestId);
  },

  get socketIOConnected(): boolean {
    const host = this as unknown as RealtimeHost & { currentSocketIOSession: SocketIOSession | undefined };
    return host.currentSocketIOSession?.status === 'connected';
  },

  get socketIOConnecting(): boolean {
    const host = this as unknown as RealtimeHost & { currentSocketIOSession: SocketIOSession | undefined };
    return host.currentSocketIOSession?.status === 'connecting' || host.currentSocketIOSession?.status === 'reconnecting';
  },

  realtimeStatusIsActive(status: string) {
    return status === 'connected' || status === 'connecting' || status === 'reconnecting';
  },

  realtimeProtectedSessionIds(this: RealtimeHost) {
    return new Set([this.activeRequestId, ...this.openRequestIds].filter(Boolean));
  },

  realtimeSessionIdsToPrune<T extends RealtimeStatus>(this: RealtimeHost, sessions: Map<string, T>, touchedAt: Map<string, number>) {
    const protectedIds = this.realtimeProtectedSessionIds();
    const now = Date.now();
    const idleEntries = [...sessions.entries()]
      .filter(([id, session]) => !protectedIds.has(id) && !this.realtimeStatusIsActive(session.status));
    const expired = idleEntries
      .filter(([id]) => now - (touchedAt.get(id) ?? 0) > REALTIME_IDLE_SESSION_TTL_MS)
      .map(([id]) => id);
    const overflow = Math.max(0, sessions.size - REALTIME_MAX_STORED_SESSIONS);
    const oldestIdle = idleEntries
      .sort(([a], [b]) => (touchedAt.get(a) ?? 0) - (touchedAt.get(b) ?? 0))
      .slice(0, overflow)
      .map(([id]) => id);
    return [...new Set([...expired, ...oldestIdle])];
  },

  disposeRealtimeSession(this: RealtimeHost, id: string) {
    if (!id) return;
    const sseSession = this.sseSessions.get(id);
    const wsSession = this.webSocketSessions.get(id);
    const sioSession = this.socketIOSessions.get(id);
    if (sseSession && this.realtimeStatusIsActive(sseSession.status)) void sseDisconnect(id);
    if (wsSession && this.realtimeStatusIsActive(wsSession.status)) void webSocketDisconnect(id);
    if (sioSession && this.realtimeStatusIsActive(sioSession.status)) void socketIODisconnect(id);
    this.forgetSSESession(id);
    this.forgetWebSocketSession(id);
    this.forgetSocketIOSession(id);
  },

  cleanupRealtimeSessions(this: RealtimeHost) {
    for (const id of this.realtimeSessionIdsToPrune(this.sseSessions, this._sseTouchedAt)) this.forgetSSESession(id);
    for (const id of this.realtimeSessionIdsToPrune(this.webSocketSessions, this._wsTouchedAt)) this.forgetWebSocketSession(id);
    for (const id of this.realtimeSessionIdsToPrune(this.socketIOSessions, this._sioTouchedAt)) this.forgetSocketIOSession(id);
  },

  initSSEListeners(this: RealtimeHost) {
    if (!window.runtime?.EventsOn) return;

    listenRuntime('sse:open', (payload: { sessionId: string; url: string; statusCode: number; status: string; headers?: KeyValue[]; duration?: number; timings?: ResponseTimings; timestamp: number }) => {
      const startedAt = this._sseStartedAt.get(payload.sessionId) ?? payload.timestamp;
      const duration = typeof payload.duration === 'number' && Number.isFinite(payload.duration)
        ? payload.duration
        : typeof payload.timings?.total === 'number' && Number.isFinite(payload.timings.total)
          ? payload.timings.total
          : Math.max(0, payload.timestamp - startedAt);
      this._sseSetSession(payload.sessionId, {
        status: 'connected',
        connectedUrl: payload.url,
        statusText: payload.status,
        statusCode: payload.statusCode,
        connectedAt: payload.timestamp,
        duration,
        timings: payload.timings ?? null,
        headers: payload.headers ?? [],
        error: '',
      });
      this._sseAddEvent(payload.sessionId, {
        id: '', event: 'connected', data: '',
        timestamp: payload.timestamp, isSystem: true,
        message: `Connected to ${payload.url}`,
      });
      void this._recordSSEHistoryOnce(payload.sessionId, payload.statusCode, payload.status, payload.timestamp);
    });

    listenRuntime('sse:event', (payload: { sessionId: string; event: SSEEventEntry }) => {
      this._sseAddEvent(payload.sessionId, payload.event);
    });

    listenRuntime('sse:events', (payload: { sessionId: string; events: SSEEventEntry[] }) => {
      this._sseAddEvents(payload.sessionId, payload.events);
    });

    listenRuntime('sse:close', (payload: { sessionId: string; message: string; timestamp: number }) => {
      this._sseSetSession(payload.sessionId, { status: 'idle' });
      this._sseAddEvent(payload.sessionId, {
        id: '', event: 'disconnected', data: '',
        timestamp: payload.timestamp, isSystem: true,
        message: payload.message,
      });
    });

    listenRuntime('sse:reconnecting', (payload: { sessionId: string; attempt: number; delayMs: number; lastEventId: string; message: string; timestamp: number }) => {
      this._sseSetSession(payload.sessionId, { status: 'reconnecting' });
      const seconds = Math.max(1, Math.round(payload.delayMs / 1000));
      const reason = payload.message ? ` — ${payload.message}` : '';
      this._sseAddEvent(payload.sessionId, {
        id: '', event: 'reconnecting', data: '',
        timestamp: payload.timestamp, isSystem: true,
        message: `Reconnecting in ${seconds}s (attempt ${payload.attempt})${reason}`,
      });
    });

    listenRuntime('sse:error', (payload: { sessionId: string; message: string; timestamp: number }) => {
      const existing = this.sseSessions.get(payload.sessionId);
      this._sseSetSession(payload.sessionId, { status: 'error', error: payload.message });
      this._sseAddEvent(payload.sessionId, {
        id: '', event: 'error', data: '',
        timestamp: payload.timestamp, isError: true,
        message: payload.message,
      });
      if (!existing?.connectedAt) {
        void this._recordSSEHistoryOnce(payload.sessionId, 0, 'Error', payload.timestamp);
      }
    });
  },

  initWebSocketListeners(this: RealtimeHost) {
    if (!window.runtime?.EventsOn) return;

    listenRuntime('ws:open', (payload: { sessionId: string; url: string; status: string; headers?: KeyValue[]; requestHeaders?: KeyValue[]; responseHeaders?: KeyValue[]; protocol?: string; timestamp: number }) => {
      const statusCode = Number(payload.status.match(/\b(\d{3})\b/)?.[1] ?? 101);
      const responseHeaders = payload.responseHeaders ?? payload.headers ?? [];
      this._wsSetSession(payload.sessionId, {
        status: 'connected',
        connectedUrl: payload.url,
        statusText: payload.status,
        connectedAt: payload.timestamp,
        headers: responseHeaders,
        protocol: payload.protocol ?? '',
        error: '',
      });
      this._wsAddMessage(payload.sessionId, {
        id: '', direction: 'system', type: 'connected', data: '',
        timestamp: payload.timestamp, isSystem: true, isError: false, size: 0,
        message: `Connected to ${payload.url}`,
        handshake: {
          url: payload.url,
          method: 'GET',
          statusCode,
          statusText: payload.status,
          protocol: payload.protocol ?? '',
          requestHeaders: payload.requestHeaders ?? [],
          responseHeaders,
        },
      });
    });

    listenRuntime('ws:event', (payload: { sessionId: string; event: WebSocketMessageEntry }) => {
      this._wsAddMessage(payload.sessionId, payload.event);
    });

    listenRuntime('ws:events', (payload: { sessionId: string; events: WebSocketMessageEntry[] }) => {
      this._wsAddMessages(payload.sessionId, payload.events);
    });

    listenRuntime('ws:close', (payload: { sessionId: string; message: string; code?: number; timestamp: number }) => {
      const existing = this.webSocketSessions.get(payload.sessionId);
      this._wsSetSession(payload.sessionId, { status: 'idle' });
      this._wsAddMessage(payload.sessionId, {
        id: '', direction: 'system', type: 'disconnected', data: '',
        timestamp: payload.timestamp, isSystem: true, isError: false, size: 0,
        code: payload.code, message: payload.message,
        handshake: {
          url: existing?.connectedUrl || this.url.trim(),
          method: 'GET',
          statusText: payload.message,
          responseHeaders: existing?.headers ?? [],
        },
      });
      void this._recordWebSocketHistoryOnce(payload.sessionId, 101, '101 Switching Protocols', payload.timestamp);
    });

    listenRuntime('ws:reconnecting', (payload: { sessionId: string; attempt: number; maxAttempts: number; intervalMs: number; timestamp: number }) => {
      this._wsSetSession(payload.sessionId, {
        status: 'reconnecting',
        error: '',
        statusText: `Reconnecting ${payload.attempt}/${payload.maxAttempts}`,
      });
      this._wsAddMessage(payload.sessionId, {
        id: '', direction: 'system', type: 'reconnecting', data: '',
        timestamp: payload.timestamp, isSystem: true, isError: false, size: 0,
        message: payload.intervalMs > 0
          ? `Reconnecting in ${Math.round(payload.intervalMs / 1000)}s (${payload.attempt}/${payload.maxAttempts})`
          : `Reconnecting (${payload.attempt}/${payload.maxAttempts})`,
      });
    });

    listenRuntime('ws:error', (payload: { sessionId: string; message: string; timestamp: number }) => {
      const existing = this.webSocketSessions.get(payload.sessionId);
      this._wsSetSession(payload.sessionId, { status: 'error', error: payload.message });
      this._wsAddMessage(payload.sessionId, {
        id: '', direction: 'system', type: 'error', data: '',
        timestamp: payload.timestamp, isSystem: true, isError: true, size: 0,
        message: payload.message,
        handshake: {
          url: existing?.connectedUrl || this.url.trim(),
          method: 'GET',
          statusText: payload.message,
          responseHeaders: existing?.headers ?? [],
        },
      });
      void this._recordWebSocketHistoryOnce(payload.sessionId, 0, 'Error', payload.timestamp);
    });
  },

  initSocketIOListeners(this: RealtimeHost) {
    if (!window.runtime?.EventsOn) return;

    listenRuntime('sio:open', (payload: { sessionId: string; url: string; namespace: string; timestamp: number; requestHeaders?: { key: string; value: string }[]; responseHeaders?: { key: string; value: string }[]; statusCode?: number; statusText?: string }) => {
      this._sioSetSession(payload.sessionId, { status: 'connected', connectedUrl: payload.url, namespace: payload.namespace, connectedAt: payload.timestamp, headers: [...(payload.requestHeaders ?? []), ...(payload.responseHeaders ?? [])], error: '' });
      const handshake: SocketIOHandshake = {
        url: payload.url,
        method: 'GET',
        statusCode: payload.statusCode ?? 101,
        statusText: payload.statusText ?? '101 Switching Protocols',
        requestHeaders: payload.requestHeaders ?? [],
        responseHeaders: payload.responseHeaders ?? [],
      };
      let connHost = payload.url;
      try { connHost = new URL(payload.url).host; } catch {  }
      this._sioAddMessage(payload.sessionId, {
        id: `sio-open-${payload.timestamp}`,
        direction: 'system',
        eventName: '',
        args: [],
        namespace: payload.namespace,
        timestamp: payload.timestamp,
        isSystem: true,
        isError: false,
        message: `Connected to ${connHost}`,
        handshake,
      });
    });

    listenRuntime('sio:event', (payload: { sessionId: string; event: SocketIOMessageEntry }) => {
      this._sioAddMessage(payload.sessionId, payload.event);
    });

    listenRuntime('sio:events', (payload: { sessionId: string; events: SocketIOMessageEntry[] }) => {
      this._sioAddMessages(payload.sessionId, payload.events);
    });

    listenRuntime('sio:close', (payload: { sessionId: string; message: string; timestamp: number }) => {
      this._sioFlushMessages();
      const existing = this.socketIOSessions.get(payload.sessionId);
      this._sioSetSession(payload.sessionId, { status: 'disconnected' });
      this._sioAddMessage(payload.sessionId, {
        id: '',
        direction: 'system',
        eventName: '',
        args: [],
        namespace: existing?.namespace ?? '/',
        timestamp: payload.timestamp,
        isSystem: true,
        isError: false,
        message: payload.message,
        details: {
          connectedUrl: existing?.connectedUrl,
          namespace: existing?.namespace ?? '/',
          durationMs: existing?.connectedAt ? Math.max(0, payload.timestamp - existing.connectedAt) : undefined,
          messageCount: existing?.messages.length ?? 0,
          reason: payload.message,
        },
      });
      void this._recordSocketIOHistoryOnce(payload.sessionId, 101, '101 Switching Protocols', payload.timestamp);
    });

    listenRuntime('sio:reconnecting', (payload: { sessionId: string; attempt: number; maxAttempts: number; intervalMs: number; timestamp: number }) => {
      this._sioFlushMessages();
      this._sioSetSession(payload.sessionId, { status: 'reconnecting', error: '' });
      this._sioAddMessage(payload.sessionId, { id: '', direction: 'system', eventName: '', args: [], namespace: '/', timestamp: payload.timestamp, isSystem: true, isError: false, message: payload.intervalMs > 0 ? `Reconnecting in ${Math.round(payload.intervalMs / 1000)}s (${payload.attempt}/${payload.maxAttempts})` : `Reconnecting (${payload.attempt}/${payload.maxAttempts})` });
    });

    listenRuntime('sio:error', (payload: { sessionId: string; message: string; timestamp: number; handshake?: SocketIOHandshake }) => {
      this._sioFlushMessages();
      this._sioSetSession(payload.sessionId, { status: 'error', error: payload.message });
      this._sioAddMessage(payload.sessionId, { id: `sio-err-${payload.timestamp}`, direction: 'system', eventName: '', args: [], namespace: '/', timestamp: payload.timestamp, isSystem: true, isError: true, message: payload.message, handshake: payload.handshake });
      void this._recordSocketIOHistoryOnce(payload.sessionId, 0, 'Error', payload.timestamp);
    });

    listenRuntime('sio:ack', (payload: { sessionId: string; ackId: number; eventName: string; args: string[]; namespace: string; timestamp: number }) => {
      const ackLabel = payload.eventName ? `ack for "${payload.eventName}"` : `ack #${payload.ackId}`;
      const preview = payload.args?.length ? payload.args.join(', ') : '(no args)';
      this._sioAddMessage(payload.sessionId, { id: `sio-ack-${payload.ackId}`, direction: 'incoming', eventName: ackLabel, args: payload.args ?? [], namespace: payload.namespace ?? '/', timestamp: payload.timestamp, isSystem: false, isError: false, message: preview });
    });
  },
};
