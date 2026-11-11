import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/backend', () => ({ sseConnect: vi.fn(), sseDisconnect: vi.fn() }));

import { sseConnect } from '../lib/backend';
import { sseFeature } from '../lib/stores/features/sse';

function host() {
  const source = { id: 'source', requestType: 'http', method: 'GET', url: 'https://source.test/events' };
  const visible = { id: 'visible', requestType: 'http', method: 'POST', url: 'https://visible.test' };
  return {
    activeRequestId: visible.id,
    requestType: visible.requestType,
    method: visible.method,
    url: visible.url,
    requests: [source, visible],
    autosave: false,
    snapshotActiveRequest: () => visible,
    requestForEditing: (id: string) => id === source.id ? source : undefined,
    updateRequestDirtyState: vi.fn(),
    persistRequestStore: vi.fn(async () => true),
    scheduleActiveRequestPersist: vi.fn(),
    buildRequest: vi.fn(() => { throw new Error('must not read the visible request'); }),
    headerValidationErrorForRequest: vi.fn(),
    _ssePendingEvents: new Map(),
    _sseStartedAt: new Map(),
    _sseHistoryRecorded: new Set(),
    _sseSetSession: vi.fn(),
    syncBackendEnvironment: vi.fn(),
    persistActiveRequestNow: vi.fn(),
  };
}

describe('SSE request ownership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('promotes the source draft and preserves the visible method and URL', async () => {
    const state = host();
    expect(await sseFeature.promoteRequestToSSE.call(state as never, 'source')).toBe(true);
    expect(state.method).toBe('POST');
    expect(state.url).toBe('https://visible.test');
    expect(state.requests.find(req => req.id === 'source')?.method).toBe('SSE');
    expect(state.updateRequestDirtyState).toHaveBeenCalledWith('source', expect.objectContaining({ method: 'SSE' }));
    expect(state.persistRequestStore).not.toHaveBeenCalled();
  });

  it('uses the captured request instead of the visible environment or URL', async () => {
    const state = host();
    const request = { requestId: 'source', url: 'https://source.test/events', method: 'GET', templateValues: { token: 'source-marker' } };
    await sseFeature.sseConnect.call(state as never, { persistBeforeConnect: false, request, snapshot: state.requests[0] } as never);
    expect(sseConnect).toHaveBeenCalledWith('source', request);
    expect(state.buildRequest).not.toHaveBeenCalled();
    expect(state.syncBackendEnvironment).not.toHaveBeenCalled();
    expect(state._sseSetSession).toHaveBeenCalledWith('source', expect.objectContaining({ connectedUrl: 'https://source.test/events' }));
  });

  it('does not reconnect a source request deleted before completion', async () => {
    const state = host();
    const request = { requestId: 'deleted', url: 'https://source.test/events' };
    await sseFeature.sseConnect.call(state as never, { persistBeforeConnect: false, request, snapshot: { id: 'deleted' } } as never);
    expect(sseConnect).not.toHaveBeenCalled();
    expect(state._sseSetSession).not.toHaveBeenCalled();
  });
});
