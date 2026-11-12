import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/backend', () => ({
  cancelQuit: vi.fn(),
  confirmQuit: vi.fn(),
  loadRequestStore: vi.fn(),
  saveRequestStore: vi.fn(),
  saveRequestStoreView: vi.fn(),
}));

import { saveRequestStore } from '../lib/backend';
import { requestCrudFeature } from '../lib/stores/features/requestCrud';
import { requestPersistenceFeature } from '../lib/stores/features/requestPersistence';

type Req = { id: string; name: string; isDraft?: boolean };

function storeHost(requests: Req[]) {
  return {
    externalWorkspaceChangePending: false,
    workspaceBlocked: false,
    requests,
    activeRequestId: '',
    openRequestIds: [] as string[],
    workspaces: [],
    collections: [],
    activeWorkspaceId: '',
    requestHistory: [],
    environments: [],
    activeEnvironmentId: '',
    collectionImportToast: '',
    requestStorePersistEpoch: 0,
    requestStorePersistQueue: Promise.resolve() as Promise<unknown>,
    requestsForStore: (next: Req[]) => next,
    requestStorePayload: (next: Req[]) => ({ requests: next.map(req => ({ ...req })) }),
    recordSavedRequestSnapshots: vi.fn(),
    scheduleGitStatusRefreshAfterPersist: vi.fn(),
    refreshPendingExternalWorkspaceChangeIfClean: vi.fn(),
    showExternalWorkspacePendingToast: vi.fn(),
    showWorkspaceBlockedToast: vi.fn(),
  };
}

function persist(host: ReturnType<typeof storeHost>, requests = host.requests) {
  return requestPersistenceFeature.persistRequestStore.call(host as never, requests as never);
}

function savedPayloads() {
  return vi.mocked(saveRequestStore).mock.calls.map(([payload]) => JSON.parse(payload).requests.map((req: Req) => req.name).join(','));
}

describe('request store persistence dedup', () => {
  beforeEach(() => {
    vi.mocked(saveRequestStore).mockReset();
    vi.mocked(saveRequestStore).mockResolvedValue({ ok: true, error: '' });
  });

  it('does not send a store that is already saved again', async () => {
    const host = storeHost([{ id: 'r1', name: 'A' }]);

    expect(await persist(host)).toBe(true);
    expect(await persist(host)).toBe(true);
    expect(await persist(host)).toBe(true);

    expect(saveRequestStore).toHaveBeenCalledTimes(1);
    expect(host.recordSavedRequestSnapshots).toHaveBeenCalledTimes(3);
    expect(host.scheduleGitStatusRefreshAfterPersist).toHaveBeenCalledTimes(1);
  });

  it('saves every change', async () => {
    const host = storeHost([{ id: 'r1', name: 'A' }]);

    await persist(host);
    await persist(host, [{ id: 'r1', name: 'B' }]);

    expect(savedPayloads()).toEqual(['A', 'B']);
  });

  it('writes a state again after a different one was saved in between', async () => {
    const host = storeHost([{ id: 'r1', name: 'A' }]);

    await persist(host, [{ id: 'r1', name: 'A' }]);
    await persist(host, [{ id: 'r1', name: 'B' }]);
    await persist(host, [{ id: 'r1', name: 'A' }]);

    expect(savedPayloads()).toEqual(['A', 'B', 'A']);
  });

  it('writes a state again when a different one is still queued', async () => {
    const host = storeHost([{ id: 'r1', name: 'A' }]);
    let finishB: (value: { ok: boolean; error: string }) => void = () => {};
    vi.mocked(saveRequestStore)
      .mockResolvedValueOnce({ ok: true, error: '' })
      .mockImplementationOnce(() => new Promise(resolve => { finishB = resolve; }));

    await persist(host, [{ id: 'r1', name: 'A' }]);
    const b = persist(host, [{ id: 'r1', name: 'B' }]);
    const a = persist(host, [{ id: 'r1', name: 'A' }]);
    await vi.waitFor(() => expect(saveRequestStore).toHaveBeenCalledTimes(2));
    finishB({ ok: true, error: '' });

    expect(await b).toBe(true);
    expect(await a).toBe(true);
    expect(savedPayloads()).toEqual(['A', 'B', 'A']);
  });

  it('waits for the queued save of the same state instead of sending it twice', async () => {
    const host = storeHost([{ id: 'r1', name: 'A' }]);
    let finish: (value: { ok: boolean; error: string }) => void = () => {};
    vi.mocked(saveRequestStore).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));

    const first = persist(host);
    const second = persist(host);
    let secondDone = false;
    void second.then(() => { secondDone = true; });
    await vi.waitFor(() => expect(saveRequestStore).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(secondDone).toBe(false);
    finish({ ok: true, error: '' });

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(saveRequestStore).toHaveBeenCalledTimes(1);
  });

  it('retries a state whose save failed', async () => {
    const host = storeHost([{ id: 'r1', name: 'A' }]);
    vi.mocked(saveRequestStore).mockResolvedValueOnce({ ok: false, error: 'disk full' });

    expect(await persist(host)).toBe(false);
    expect(await persist(host)).toBe(true);

    expect(saveRequestStore).toHaveBeenCalledTimes(2);
  });

  it('saves again after the store was reloaded', async () => {
    const host = storeHost([{ id: 'r1', name: 'A' }]);

    await persist(host);
    host.requestStorePersistEpoch += 1;
    await persist(host);

    expect(saveRequestStore).toHaveBeenCalledTimes(2);
  });
});

describe('closing a request tab', () => {
  it('removes the tab before the request is saved', async () => {
    let finishPersist: () => void = () => {};
    const order: string[] = [];
    const saved = { id: 'r1', name: 'One', collectionId: 'c1', isDraft: false };
    const other = { id: 'r2', name: 'Two', collectionId: 'c1', isDraft: false };
    const host = {
      autosave: true,
      activeRequestId: 'r1',
      openRequestIds: ['r1', 'r2'],
      lastClosedRequestIds: [] as string[],
      draftRequestIds: new Set<string>(),
      dirtyRequestIds: new Set<string>(),
      topView: 'request',
      activeWorkspaceId: 'w1',
      requestForEditing: (id: string) => (id === 'r1' ? saved : other),
      persistActiveRequestNow: vi.fn(() => {
        order.push('persist started');
        return new Promise<void>(resolve => {
          finishPersist = () => { order.push('persist finished'); resolve(); };
        });
      }),
      disposeRealtimeSession: vi.fn(),
      workspaceIdForCollection: () => 'w1',
      applySavedRequest: vi.fn((req: typeof other) => {
        order.push(`switched to ${req.id}`);
        host.activeRequestId = req.id;
      }),
      persistRequestStore: vi.fn(),
      persistRequestStoreView: vi.fn(async () => {
        order.push('view saved');
        return true;
      }),
    };

    const closing = requestCrudFeature.closeRequestTab.call(host as never, 'r1');
    await Promise.resolve();

    expect(host.openRequestIds).toEqual(['r2']);
    expect(host.activeRequestId).toBe('r2');
    expect(host.persistRequestStoreView).not.toHaveBeenCalled();

    finishPersist();
    await closing;

    expect(order).toEqual(['persist started', 'switched to r2', 'persist finished', 'view saved']);
    expect(host.persistRequestStoreView).toHaveBeenCalledWith('r2', ['r2']);
  });
});
