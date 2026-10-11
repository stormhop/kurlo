import { sseConnect, sseDisconnect } from '../../backend';
import { emptyHttpResponse } from '../../wire';
import type { HttpRequest, HttpResponse } from '../../backend';
import type { Method, RequestTab, RequestType, SavedRequest, SSEEventEntry, SSESession } from '../../types/models';
import { requestTitleFrom } from '../../utils';

const SSE_MAX_EVENTS = 3000;
const SSE_MAX_PENDING_EVENTS = 1000;
const SSE_EVENT_FLUSH_MS = 50;

type SSEHost = {
  sseSessions: Map<string, SSESession>;
  _sseEntryCounter: number;
  _ssePendingEvents: Map<string, SSEEventEntry[]>;
  _sseFlushTimer: number | undefined;
  _sseStartedAt: Map<string, number>;
  _sseHistoryRecorded: Set<string>;
  _sseTouchedAt: Map<string, number>;
  activeRequestId: string;
  url: string;
  method: Method;
  requestType: RequestType;
  requests: SavedRequest[];
  requestsById: Map<string, SavedRequest>;
  requestError: string;
  requestTab: RequestTab;
  currentSSESession: SSESession | undefined;
  cleanupRealtimeSessions: () => void;
  recordRequestHistory: (httpResponse: HttpResponse, requestSnapshot?: SavedRequest) => Promise<void>;
  snapshotActiveRequest: (options?: { forPersistence?: boolean }) => SavedRequest;
  normalizeSavedRequestCtx: (input: Partial<SavedRequest>) => SavedRequest;
  scheduleActiveRequestPersist: () => void;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  syncBackendEnvironment: () => Promise<void>;
  buildRequest: () => HttpRequest;
  headerValidationErrorForRequest: (req: SavedRequest, envValues?: Record<string, string>) => string;
  setActiveResponse: (response: HttpResponse | null, requestId?: string) => void;
  forgetSSESession: (id: string) => void;
  _emptySSESession: () => SSESession;
  _sseSetSession: (id: string, patch: Partial<SSESession>) => void;
  _sseAddEvents: (id: string, incoming: SSEEventEntry[]) => void;
  _sseScheduleEventFlush: () => void;
  _sseFlushEvents: () => void;
  _sseTrimEvents: (events: SSEEventEntry[]) => SSEEventEntry[];
  _sseHistorySnapshot: (sessionId: string) => SavedRequest | null;
  _recordSSEHistoryOnce: (sessionId: string, statusCode: number, status: string, timestamp: number) => Promise<void>;
};

export const sseFeature = {
  forgetSSESession(this: SSEHost, id: string) {
    if (!this.sseSessions.has(id)) return;
    const next = new Map(this.sseSessions);
    next.delete(id);
    this.sseSessions = next;
    this._ssePendingEvents.delete(id);
    this._sseStartedAt.delete(id);
    this._sseHistoryRecorded.delete(id);
    this._sseTouchedAt.delete(id);
  },
  sseSessionIsActive(this: SSEHost, session = this.currentSSESession): boolean {
    return session?.status === 'connected' || session?.status === 'connecting' || session?.status === 'reconnecting';
  },
  sseSessionIsVisible(this: SSEHost, session = this.currentSSESession): boolean {
    return Boolean(session && (
      session.status !== 'idle'
      || session.events.length > 0
      || session.clearedEvents.length > 0
      || session.error
    ));
  },
  clearTransientSSESession(this: SSEHost, id = this.activeRequestId) {
    if (!id || this.method === 'SSE' || !this.sseSessions.has(id)) return;
    this.forgetSSESession(id);
  },
  promoteActiveRequestToSSE(this: SSEHost) {
    if (this.requestType !== 'http' || this.method === 'SSE') return;
    this.method = 'SSE';
    this.scheduleActiveRequestPersist();
  },
  _emptySSESession(this: SSEHost): SSESession {
    return {
      status: 'idle',
      connectedUrl: '',
      statusText: '',
      statusCode: 0,
      connectedAt: 0,
      duration: 0,
      timings: null,
      events: [],
      clearedEvents: [],
      headers: [],
      error: '',
    };
  },
  _sseSetSession(this: SSEHost, id: string, patch: Partial<SSESession>) {
    const next = new Map(this.sseSessions);
    const existing: SSESession = { ...this._emptySSESession(), ...(next.get(id) ?? {}) };
    next.set(id, { ...existing, ...patch });
    this.sseSessions = next;
    this._sseTouchedAt.set(id, Date.now());
    this.cleanupRealtimeSessions();
  },
  _sseAddEvent(this: SSEHost, id: string, ev: SSEEventEntry) {
    this._sseAddEvents(id, [ev]);
  },
  _sseAddEvents(this: SSEHost, id: string, incoming: SSEEventEntry[]) {
    const existing = this.sseSessions.get(id);
    if (!existing || !incoming.length) return;
    const pending = this._ssePendingEvents.get(id) ?? [];
    for (const ev of incoming) {
      pending.push({ ...ev, entryId: ++this._sseEntryCounter } as SSEEventEntry & { entryId: number });
    }
    if (pending.length > SSE_MAX_PENDING_EVENTS) {
      pending.splice(0, pending.length - SSE_MAX_PENDING_EVENTS);
    }
    this._ssePendingEvents.set(id, pending);
    this._sseTouchedAt.set(id, Date.now());
    this._sseScheduleEventFlush();
  },
  _sseScheduleEventFlush(this: SSEHost) {
    if (this._sseFlushTimer !== undefined) return;
    this._sseFlushTimer = window.setTimeout(() => this._sseFlushEvents(), SSE_EVENT_FLUSH_MS);
  },
  _sseFlushEvents(this: SSEHost) {
    if (this._sseFlushTimer !== undefined) {
      window.clearTimeout(this._sseFlushTimer);
      this._sseFlushTimer = undefined;
    }
    if (!this._ssePendingEvents.size) return;

    const next = new Map(this.sseSessions);
    for (const [id, pending] of this._ssePendingEvents) {
      const existing = next.get(id);
      if (!existing || !pending.length) continue;
      let events = [...existing.events, ...pending];
      if (events.length > SSE_MAX_EVENTS) {
        events = events.slice(events.length - SSE_MAX_EVENTS);
      }
      next.set(id, { ...existing, events });
    }
    this._ssePendingEvents.clear();
    this.sseSessions = next;
  },
  _sseTrimEvents(this: SSEHost, events: SSEEventEntry[]) {
    if (events.length > SSE_MAX_EVENTS) {
      return events.slice(events.length - SSE_MAX_EVENTS);
    }
    return events;
  },
  _sseHistorySnapshot(this: SSEHost, sessionId: string): SavedRequest | null {
    const base = sessionId === this.activeRequestId
      ? this.snapshotActiveRequest()
      : this.requestsById.get(sessionId);
    if (!base) return null;
    return this.normalizeSavedRequestCtx({
      ...base,
      method: 'SSE',
      name: base.name && base.name !== 'New Request' ? base.name : requestTitleFrom('SSE', base.url),
    });
  },
  async _recordSSEHistoryOnce(this: SSEHost, sessionId: string, statusCode: number, status: string, timestamp: number) {
    if (!sessionId || this._sseHistoryRecorded.has(sessionId)) return;
    const requestSnapshot = this._sseHistorySnapshot(sessionId);
    if (!requestSnapshot) return;
    this._sseHistoryRecorded.add(sessionId);
    const startedAt = this._sseStartedAt.get(sessionId) ?? timestamp;
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
  async sseConnect(this: SSEHost, options: { persistBeforeConnect?: boolean } = {}) {
    const persistBeforeConnect = options.persistBeforeConnect ?? true;
    const id = this.activeRequestId;
    if (!id || !this.url.trim()) return;
    const headerError = this.headerValidationErrorForRequest(this.snapshotActiveRequest());
    if (headerError) {
      this.requestError = headerError;
      this.setActiveResponse(null, id);
      this.requestTab = 'headers';
      this._sseSetSession(id, { status: 'error', error: headerError, connectedUrl: this.url.trim() });
      return;
    }
    this._ssePendingEvents.delete(id);
    this._sseStartedAt.set(id, Date.now());
    this._sseHistoryRecorded.delete(id);
    this._sseSetSession(id, {
      status: 'connecting',
      events: [],
      clearedEvents: [],
      headers: [],
      statusText: '',
      statusCode: 0,
      connectedAt: 0,
      duration: 0,
      timings: null,
      error: '',
      connectedUrl: this.url.trim(),
    });
    try {
      if (persistBeforeConnect) await this.persistActiveRequestNow();
      try { await this.syncBackendEnvironment(); } catch {  }
      await sseConnect(id, this.buildRequest());
    } catch (e) {
      this._sseSetSession(id, { status: 'error', error: String(e) });
      await this._recordSSEHistoryOnce(id, 0, 'Error', Date.now());
    }
  },
  async sseDisconnect(this: SSEHost) {
    const id = this.activeRequestId;
    if (!id) return;
    await sseDisconnect(id);
    this._sseSetSession(id, { status: 'idle' });
  },
  sseClearEvents(this: SSEHost) {
    const id = this.activeRequestId;
    if (!id) return;
    this._sseFlushEvents();
    const next = new Map(this.sseSessions);
    const existing = next.get(id);
    if (existing) {
      next.set(id, {
        ...existing,
        events: [],
        clearedEvents: this._sseTrimEvents([...(existing.clearedEvents ?? []), ...existing.events]),
      });
    }
    this.sseSessions = next;
  },
  sseRestoreEvents(this: SSEHost) {
    const id = this.activeRequestId;
    if (!id) return;
    this._sseFlushEvents();
    const next = new Map(this.sseSessions);
    const existing = next.get(id);
    if (existing?.clearedEvents?.length) {
      next.set(id, {
        ...existing,
        events: this._sseTrimEvents([...(existing.clearedEvents ?? []), ...existing.events]),
        clearedEvents: [],
      });
    }
    this.sseSessions = next;
  },
};
