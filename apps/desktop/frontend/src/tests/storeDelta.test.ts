import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/backend', () => ({
  cancelQuit: vi.fn(),
  confirmQuit: vi.fn(),
  loadRequestStore: vi.fn(),
  saveRequestStore: vi.fn(),
  saveRequestStoreDelta: vi.fn(),
  saveRequestStoreView: vi.fn(),
}));

import { saveRequestStore, saveRequestStoreDelta } from '../lib/backend';
import { requestPersistenceFeature } from '../lib/stores/features/requestPersistence';

type Req = { id: string; name: string; url?: string; collectionId?: string };

function storeHost(requests: Req[]) {
  return {
    externalWorkspaceChangePending: false,
    workspaceBlocked: false,
    requests,
    activeRequestId: '',
    openRequestIds: [] as string[],
    workspaces: [{ id: 'w1', name: 'Main' }],
    collections: [{ id: 'c1', workspaceId: 'w1', name: 'Core' }],
    activeWorkspaceId: 'w1',
    requestHistory: [] as unknown[],
    environments: [{ id: 'e1', workspaceId: 'w1', name: 'Local', values: [] as unknown[] }],
    activeEnvironmentId: '',
    collectionImportToast: '',
    requestStorePersistEpoch: 0,
    requestStorePersistQueue: Promise.resolve() as Promise<unknown>,
    requestsForStore: (next: Req[]) => next,
    requestStorePayload(this: ReturnType<typeof storeHost>, next: Req[], activeId?: string, openIds?: string[]) {
      return {
        version: 2,
        activeId: activeId ?? '',
        openIds: openIds ?? [],
        workspaces: this.workspaces,
        collections: this.collections,
        environments: this.environments,
        history: this.requestHistory,
        requests: next,
      };
    },
    writeRequestStoreView: vi.fn(async () => ({ ok: true, error: '' })),
    savedRequestSnapshots: new Map<string, Req>(),
    recordSavedRequestSnapshots: vi.fn(),
    scheduleGitStatusRefreshAfterPersist: vi.fn(),
    refreshPendingExternalWorkspaceChangeIfClean: vi.fn(),
    showExternalWorkspacePendingToast: vi.fn(),
    showWorkspaceBlockedToast: vi.fn(),
  };
}

function persist(host: ReturnType<typeof storeHost>, requests = host.requests) {
  host.requests = requests;
  return requestPersistenceFeature.persistRequestStore.call(host as never, requests as never, 'r1', ['r1']);
}

function deltaCalls() {
  return vi.mocked(saveRequestStoreDelta).mock.calls.map(([payload]) => JSON.parse(payload));
}

const one: Req = { id: 'r1', name: 'One', url: 'https://one', collectionId: 'c1' };
const two: Req = { id: 'r2', name: 'Two', url: 'https://two', collectionId: 'c1' };

describe('request store delta saves', () => {
  let revision = 0;
  beforeEach(() => {
    revision = 0;
    vi.mocked(saveRequestStore).mockReset();
    vi.mocked(saveRequestStore).mockImplementation(async () => ({ ok: true, error: '', revision: ++revision }));
    vi.mocked(saveRequestStoreDelta).mockReset();
    vi.mocked(saveRequestStoreDelta).mockImplementation(async () => ({ ok: true, error: '', revision: ++revision }));
  });

  it('sends only the edited request once the backend confirmed a full save', async () => {
    const host = storeHost([one, two]);
    expect(await persist(host)).toBe(true);
    expect(saveRequestStore).toHaveBeenCalledTimes(1);
    expect(await persist(host, [{ ...one, url: 'https://edited' }, two])).toBe(true);
    expect(saveRequestStore).toHaveBeenCalledTimes(1);
    const [delta] = deltaCalls();
    expect(delta.base).toBe(1);
    expect(delta.requestIds).toEqual(['r1', 'r2']);
    expect(delta.requests.map((req: Req) => req.url)).toEqual(['https://edited']);
    expect(delta.store.requests).toBeUndefined();
    expect(delta.store.environments).toEqual(host.environments);
  });

  it('chains deltas on the revision each save returns', async () => {
    const host = storeHost([one, two]);
    await persist(host);
    await persist(host, [{ ...one, url: 'https://a' }, two]);
    await persist(host, [{ ...one, url: 'https://a' }, { ...two, url: 'https://b' }]);
    expect(deltaCalls().map(delta => [delta.base, delta.requests.map((req: Req) => req.id)])).toEqual([[1, ['r1']], [2, ['r2']]]);
  });

  it('falls back to a full save when the backend asks for one', async () => {
    const host = storeHost([one, two]);
    await persist(host);
    vi.mocked(saveRequestStoreDelta).mockResolvedValueOnce({ ok: false, error: '', needFull: true });
    expect(await persist(host, [{ ...one, url: 'https://edited' }, two])).toBe(true);
    expect(saveRequestStore).toHaveBeenCalledTimes(2);
    const full = JSON.parse(vi.mocked(saveRequestStore).mock.calls[1][0]);
    expect(full.requests.map((req: Req) => req.url)).toEqual(['https://edited', 'https://two']);
    await persist(host, [{ ...one, url: 'https://again' }, two]);
    expect(deltaCalls().at(-1)?.base).toBe(2);
  });

  it('reports a failed delta and saves in full next time', async () => {
    const host = storeHost([one, two]);
    await persist(host);
    vi.mocked(saveRequestStoreDelta).mockResolvedValueOnce({ ok: false, error: 'disk full' });
    expect(await persist(host, [{ ...one, url: 'https://edited' }, two])).toBe(false);
    expect(host.collectionImportToast).toContain('disk full');
    expect(await persist(host, [{ ...one, url: 'https://edited' }, two])).toBe(true);
    expect(saveRequestStore).toHaveBeenCalledTimes(2);
    expect(saveRequestStoreDelta).toHaveBeenCalledTimes(1);
  });

  it('saves in full when requests, collections or environments are added, removed or reordered', async () => {
    const host = storeHost([one, two]);
    await persist(host);
    await persist(host, [two, one]);
    await persist(host, [two]);
    host.collections = [...host.collections, { id: 'c2', workspaceId: 'w1', name: 'Second' }];
    await persist(host);
    host.environments = [];
    await persist(host);
    expect(saveRequestStoreDelta).not.toHaveBeenCalled();
    expect(saveRequestStore).toHaveBeenCalledTimes(5);
  });

  it('sends history and other store changes without any request', async () => {
    const host = storeHost([one, two]);
    await persist(host);
    host.requestHistory = [{ id: 'h1', url: 'https://one' }];
    await persist(host);
    const [delta] = deltaCalls();
    expect(delta.requests).toEqual([]);
    expect(delta.store.history).toEqual([{ id: 'h1', url: 'https://one' }]);
  });

  it('keeps saving in full against a backend that returns no revision', async () => {
    vi.mocked(saveRequestStore).mockImplementation(async () => ({ ok: true, error: '' }));
    const host = storeHost([one, two]);
    await persist(host);
    await persist(host, [{ ...one, url: 'https://edited' }, two]);
    expect(saveRequestStoreDelta).not.toHaveBeenCalled();
    expect(saveRequestStore).toHaveBeenCalledTimes(2);
  });

  it('sends the store as it was when the save was asked for', async () => {
    const host = storeHost([one, two]);
    await persist(host);
    let release: () => void = () => {};
    host.requestStorePersistQueue = new Promise<void>(resolve => { release = resolve; });
    const pending = persist(host, [{ ...one, url: 'https://edited' }, two]);
    host.environments[0].values.push({ key: 'late' });
    release();
    await pending;
    expect(deltaCalls()[0].store.environments[0].values).toEqual([]);
  });
});
