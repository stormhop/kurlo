import { describe, expect, it, vi } from 'vitest';
import { makeCollection, normalizeSavedRequest } from '../lib/normalizers';
import { collectionFeature } from '../lib/stores/features/collections';
import { folderFeature } from '../lib/stores/features/folders';
import { importExportFeature } from '../lib/stores/features/importExport';
import type { SavedRequest } from '../lib/types/models';

function importHost() {
  return {
    activeWorkspaceId: 'ws',
    workspaces: [{ id: 'ws', name: 'Workspace' }],
    collections: [makeCollection('ws', 'Existing')],
    requests: [] as SavedRequest[],
    environments: [],
    openRequestIds: [],
    requestHistory: [],
    activeEnvironmentId: '',
    folderCollapseState: { 'existing:Open': false, 'existing:Closed': true } as Record<string, boolean>,
    folderCollapseKey: folderFeature.folderCollapseKey,
    guardWorkspaceWritable: () => true,
    persistActiveRequestNow: vi.fn(async () => {}),
    persistRequestStore: vi.fn(async () => true),
    applySavedRequest: vi.fn(),
  };
}

describe('imported collection collapse state', () => {
  it.each(['bundle', 'requests'])('collapses %s imports without changing existing choices', async mode => {
    const host = importHost();
    const buildRequests = (collectionId: string) => [
      normalizeSavedRequest({ id: 'nested', collectionId, folderPath: ['Users / team', 'Active'], name: 'List users' }, []),
      normalizeSavedRequest({ id: 'root', collectionId, name: 'Root' }, []),
    ];
    if (mode === 'bundle') {
      await importExportFeature.importCollectionBundle.call(host as never, {
        name: 'Imported', description: '', folderPaths: [['Empty', 'Child']], requests: buildRequests('source'),
      });
    } else {
      await importExportFeature.importRequestsPayload.call(host as never, 'Imported', buildRequests);
    }
    const imported = host.collections[1];
    expect(imported.collapsed).toBe(true);
    expect(host.collections[0].collapsed).toBe(false);
    expect(host.folderCollapseState['existing:Open']).toBe(false);
    expect(host.folderCollapseState['existing:Closed']).toBe(true);
    for (const path of [['Users / team'], ['Users / team', 'Active'], ...(mode === 'bundle' ? [['Empty'], ['Empty', 'Child']] : [])]) {
      expect(host.folderCollapseState[host.folderCollapseKey.call(host as never, imported.id, path)]).toBe(true);
    }
    expect(host.persistRequestStore).toHaveBeenCalledTimes(1);
    expect(host.applySavedRequest).toHaveBeenCalledWith(host.requests[0]);

    const scheduleRequestStorePersist = vi.fn();
    const toggleHost = Object.assign(host, { scheduleRequestStorePersist });
    await collectionFeature.toggleCollectionCollapsed.call(toggleHost as never, imported.id);
    await folderFeature.toggleFolderCollapsed.call(toggleHost as never, imported.id, ['Users / team']);
    expect(host.collections[1].collapsed).toBe(false);
    expect(host.folderCollapseState[host.folderCollapseKey.call(host as never, imported.id, ['Users / team'])]).toBe(false);
    expect(host.folderCollapseState[host.folderCollapseKey.call(host as never, imported.id, ['Users / team', 'Active'])]).toBe(true);
    expect(scheduleRequestStorePersist).toHaveBeenCalledTimes(2);
  });

  it('collapses an imported collection containing only empty folders', async () => {
    const host = importHost();
    await importExportFeature.importCollectionBundle.call(host as never, {
      name: 'Empty', description: '', folderPaths: [['Parent', 'Child']], requests: [],
    });
    const imported = host.collections[1];
    expect(imported.collapsed).toBe(true);
    expect(host.folderCollapseState[host.folderCollapseKey.call(host as never, imported.id, ['Parent'])]).toBe(true);
    expect(host.folderCollapseState[host.folderCollapseKey.call(host as never, imported.id, ['Parent', 'Child'])]).toBe(true);
    expect(host.applySavedRequest).not.toHaveBeenCalled();
  });

  it('keeps collapse state unchanged when no requests can be imported', async () => {
    const host = importHost();
    const before = { ...host.folderCollapseState };
    await expect(importExportFeature.importRequestsPayload.call(host as never, 'Invalid', () => []))
      .rejects.toThrow('No requests found');
    expect(host.folderCollapseState).toEqual(before);
    expect(host.collections).toHaveLength(1);
    expect(host.persistRequestStore).not.toHaveBeenCalled();
  });
});
