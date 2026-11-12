import { describe, expect, it } from 'vitest';
import { emptyCollectionDefaults } from '../lib/collectionDefaults';
import {
  addCollectionFolderPath,
  folderCollapsedByDefault,
  normalizeCollectionFolderPaths,
  removeCollectionFolderPathTree,
  renameCollectionFolderPath,
  reorderWorkspaceCollections,
  reorderCollectionRequests,
  canReorderRequests,
} from '../lib/collections';
import { normalizeSavedRequest } from '../lib/normalizers';
import { collectionFeature } from '../lib/stores/features/collections';
import { folderFeature } from '../lib/stores/features/folders';
import type { Collection } from '../lib/types/models';

function collection(id: string, workspaceId = 'workspace-1'): Collection {
  return {
    id,
    workspaceId,
    name: id,
    filesystemName: id,
    description: '',
    collapsed: false,
    defaults: emptyCollectionDefaults(),
  };
}

describe('reorderWorkspaceCollections', () => {
  it('moves a collection before another collection in the same workspace', () => {
    const reordered = reorderWorkspaceCollections(
      [collection('a'), collection('b'), collection('c')],
      'workspace-1',
      'c',
      'a',
      'before',
    );

    expect(reordered.map(c => c.id)).toEqual(['c', 'a', 'b']);
  });

  it('moves a collection after another collection without moving other workspaces', () => {
    const reordered = reorderWorkspaceCollections(
      [collection('a'), collection('x', 'workspace-2'), collection('b'), collection('c')],
      'workspace-1',
      'a',
      'c',
      'after',
    );

    expect(reordered.map(c => c.id)).toEqual(['b', 'x', 'c', 'a']);
    expect(reordered[1].workspaceId).toBe('workspace-2');
  });

  it('leaves the list unchanged when source or target is outside the workspace', () => {
    const collections = [collection('a'), collection('x', 'workspace-2')];

    expect(reorderWorkspaceCollections(collections, 'workspace-1', 'x', 'a', 'before')).toBe(collections);
    expect(reorderWorkspaceCollections(collections, 'workspace-1', 'a', 'x', 'before')).toBe(collections);
  });
});

describe('collection folder paths', () => {
  it('normalizes and deduplicates persisted empty folder paths', () => {
    expect(normalizeCollectionFolderPaths([
      ['Root', 'Child'],
      ['Root', 'Child'],
      ['Root', ''],
      [],
    ])).toEqual([
      ['Root', 'Child'],
      ['Root'],
    ]);
  });

  it('adds, renames, and removes folder path trees without touching other folders', () => {
    const base = addCollectionFolderPath(collection('api'), ['Users', 'Active']);
    const withSibling = addCollectionFolderPath(base, ['Orders']);
    const renamed = renameCollectionFolderPath(withSibling, ['Users'], ['Accounts']);
    const removed = removeCollectionFolderPathTree(renamed, ['Accounts']);

    expect(base.folderPaths).toEqual([['Users', 'Active']]);
    expect(renamed.folderPaths).toEqual([['Accounts', 'Active'], ['Orders']]);
    expect(removed.folderPaths).toEqual([['Orders']]);
  });

  it('collapses nested folders by default while keeping top-level folders open', () => {
    expect(folderCollapsedByDefault(['Users'])).toBe(false);
    expect(folderCollapsedByDefault(['Users', 'Active'])).toBe(true);

    const host = {
      activeWorkspaceId: 'workspace-1',
      collections: [{
        ...collection('api'),
        folderPaths: [['Users', 'Active'], ['Users', 'Archived'], ['Orders']],
      }],
      folderCollapseState: {},
      requests: [],
      sidebarSearch: '',
      workspaceDiagnostics: [],
      diagnosticsForCollection: () => [],
      diagnosticsForRequest: () => [],
      folderCollapseKey: folderFeature.folderCollapseKey,
      folderDisplayName: folderFeature.folderDisplayName,
      requestsForDisplay: () => [],
    };

    const groups = collectionFeature.buildCollectionGroups.call(host as never);
    const users = groups[0].folders.find(folder => folder.name === 'Users');

    expect(users?.collapsed).toBe(false);
    expect(users?.children.map(folder => [folder.name, folder.collapsed])).toEqual([
      ['Active', true],
      ['Archived', true],
    ]);
  });

  it('toggles folders against their default collapsed state', async () => {
    let persistCalls = 0;
    const host = {
      folderCollapseState: {},
      folderCollapseKey: folderFeature.folderCollapseKey,
      scheduleRequestStorePersist: () => { persistCalls += 1; },
    };

    const topLevelKey = folderFeature.folderCollapseKey.call(host as never, 'api', ['Users']);
    const nestedKey = folderFeature.folderCollapseKey.call(host as never, 'api', ['Users', 'Active']);

    await folderFeature.toggleFolderCollapsed.call(host as never, 'api', ['Users']);
    await folderFeature.toggleFolderCollapsed.call(host as never, 'api', ['Users', 'Active']);

    expect(host.folderCollapseState[topLevelKey]).toBe(true);
    expect(host.folderCollapseState[nestedKey]).toBe(false);
    expect(persistCalls).toBe(2);
  });
});

describe('reorderCollectionRequests', () => {
  const request = (id: string, collectionId = 'api', folderPath: string[] = []) => normalizeSavedRequest({
    id, collectionId, folderPath, name: id, method: 'GET', url: `https://example.test/${id}`,
  }, [collection('api'), collection('other')]);

  it('moves requests before and after siblings while preserving other collections and folders', () => {
    const requests = [request('a'), request('x', 'other'), request('b'), request('nested', 'api', ['Users']), request('c')];
    expect(reorderCollectionRequests(requests, 'c', 'a', 'before').map(req => req.id)).toEqual(['c', 'x', 'a', 'nested', 'b']);
    expect(reorderCollectionRequests(requests, 'a', 'c', 'after').map(req => req.id)).toEqual(['b', 'x', 'c', 'nested', 'a']);
    expect(requests.map(req => req.id)).toEqual(['a', 'x', 'b', 'nested', 'c']);
  });

  it('reorders requests in nested folders without changing their contents or parent', () => {
    const requests = [request('a', 'api', ['Users', 'Active']), request('root'), request('b', 'api', ['Users', 'Active'])];
    const reordered = reorderCollectionRequests(requests, 'b', 'a', 'before');
    expect(reordered).toEqual([requests[2], requests[1], requests[0]]);
    expect(reordered[0]).toBe(requests[2]);
  });

  it('rejects other parents, drafts, invalid rows, missing requests and self-drops', () => {
    const requests = [request('a'), request('folder', 'api', ['Users']), request('other', 'other'),
      { ...request('draft'), isDraft: true }, { ...request('invalid'), isInvalid: true }];
    for (const targetId of ['a', 'folder', 'other', 'draft', 'invalid', 'missing']) {
      expect(reorderCollectionRequests(requests, 'a', targetId, 'before')).toBe(requests);
      expect(reorderCollectionRequests(requests, targetId, 'a', 'after')).toBe(requests);
    }
    expect(canReorderRequests(requests[0], undefined)).toBe(false);
  });

  it('does not persist a drop that leaves the order unchanged', () => {
    const requests = [request('a'), request('b')];
    expect(reorderCollectionRequests(requests, 'a', 'b', 'before')).toBe(requests);
    expect(reorderCollectionRequests(requests, 'b', 'a', 'after')).toBe(requests);
  });
});
