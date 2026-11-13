import { describe, expect, it, vi } from 'vitest';
import { legacyStarredRequestIds, starredRequestIdsFromStore } from '../lib/starredRequests';
import { requestCrudFeature } from '../lib/stores/features/requestCrud';
import { requestPersistenceFeature } from '../lib/stores/features/requestPersistence';
import type { RequestStore, SavedRequest } from '../lib/types/models';

function request(id: string): SavedRequest {
  return { id, name: id, collectionId: 'collection-1', collection: 'API', folderPath: [], method: 'GET', url: `https://example.test/${id}` } as SavedRequest;
}

describe('starred request ids', () => {
  it('reads stars from the local store', () => {
    expect(starredRequestIdsFromStore({ starredRequestIds: ['a', 'b', 'a', '', 7 as unknown as string] })).toEqual(['a', 'b']);
  });

  it('migrates legacy isPinned flags only while the local store has no stars yet', () => {
    const requests = [{ id: 'a', isPinned: true }, { id: 'b', isPinned: false }, { id: 'c' }, { id: 'd', isPinned: true }] as unknown as SavedRequest[];
    expect(legacyStarredRequestIds(requests)).toEqual(['a', 'd']);
    expect(starredRequestIdsFromStore({ requests })).toEqual(['a', 'd']);
    expect(starredRequestIdsFromStore({ requests, starredRequestIds: [] })).toEqual([]);
  });

  it('toggles a star locally without touching the request', async () => {
    const original = request('a');
    const host = {
      requests: [original],
      requestsById: new Map([[original.id, original]]),
      starredRequestIds: new Set<string>(),
      openRequestMenuId: 'pinned:a',
      guardWorkspaceWritable: () => true,
      persistRequestStore: vi.fn(async () => true),
    };
    await requestCrudFeature.toggleRequestPinned.call(host as never, 'a');
    expect([...host.starredRequestIds]).toEqual(['a']);
    expect(host.requests[0]).toBe(original);
    expect(host.openRequestMenuId).toBe('');
    expect(host.persistRequestStore).toHaveBeenCalledTimes(1);
    await requestCrudFeature.toggleRequestPinned.call(host as never, 'a');
    expect(host.starredRequestIds.size).toBe(0);
  });

  it('lists starred requests of the active workspace that match the filter', () => {
    const host = {
      dirtyRequestIdList: [],
      activeWorkspaceId: 'workspace-1',
      collections: [{ id: 'collection-1', workspaceId: 'workspace-1' }, { id: 'collection-2', workspaceId: 'workspace-2' }],
      requests: [request('a'), request('b'), { ...request('c'), collectionId: 'collection-2' }, { ...request('d'), isDraft: true }],
      starredRequestIds: new Set(['a', 'c', 'd']),
      sidebarSearch: '',
    };
    expect(Object.getOwnPropertyDescriptor(requestCrudFeature, 'pinnedRequests')!.get!.call(host).map((r: SavedRequest) => r.id)).toEqual(['a']);
    host.sidebarSearch = 'zzz';
    expect(Object.getOwnPropertyDescriptor(requestCrudFeature, 'pinnedRequests')!.get!.call(host)).toEqual([]);
  });

  it('saves stars into the local store and drops removed requests', () => {
    const host = {
      ...requestPersistenceFeature,
      requests: [request('a'), request('b')],
      activeRequestId: 'a',
      openRequestIds: ['a'],
      workspaces: [{ id: 'workspace-1', name: 'W', filesystemName: 'W', description: '' }],
      collections: [{ id: 'collection-1', workspaceId: 'workspace-1', name: 'API', filesystemName: 'API', description: '' }],
      activeWorkspaceId: 'workspace-1',
      requestHistory: [],
      environments: [],
      activeEnvironmentId: '',
      folderCollapseState: {},
      starredRequestIds: new Set(['b', 'gone']),
      workspaceCookies: {},
      cookies: [],
      collectionLastRuns: {},
      environmentsForStore: (environments: unknown[]) => environments,
      pruneHistory: (history: unknown[]) => history,
      globalsForStore: () => [],
    };
    const store = requestPersistenceFeature.requestStorePayload.call(host as never) as RequestStore;
    expect(store.starredRequestIds).toEqual(['b']);
    expect(store.requests.some(r => 'isPinned' in r)).toBe(false);
  });
});
