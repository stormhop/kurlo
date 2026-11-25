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
  placeRequests,
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
      sidebarRequests: [],
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

describe('placeRequests', () => {
  const request = (id: string, collectionId = 'api', folderPath: string[] = []) => normalizeSavedRequest({
    id, collectionId, folderPath, name: id, method: 'GET', url: `https://example.test/${id}`,
  }, [collection('api'), collection('other')]);
  const ids = (requests: { id: string }[]) => requests.map(req => req.id);

  it('moves a group next to a sibling and keeps the group order', () => {
    const requests = [request('a'), request('b'), request('x', 'other'), request('c'), request('d')];
    expect(ids(placeRequests(requests, ['d', 'b'], 'api', [], { id: 'a', placement: 'before' }))).toEqual(['b', 'd', 'a', 'x', 'c']);
    expect(ids(placeRequests(requests, ['a', 'b'], 'api', [], { id: 'd', placement: 'after' }))).toEqual(['x', 'c', 'd', 'a', 'b']);
    expect(ids(requests)).toEqual(['a', 'b', 'x', 'c', 'd']);
  });

  it('moves a group into a folder without changing global positions', () => {
    const requests = [request('a'), request('n', 'api', ['Users']), request('b', 'api', ['Other'])];
    const moved = placeRequests(requests, ['a', 'b', 'n'], 'api', ['Users']);
    expect(moved.map(req => req.folderPath)).toEqual([['Users'], ['Users'], ['Users']]);
    expect(moved[1]).toBe(requests[1]);
    expect(placeRequests(moved, ['a', 'b'], 'api', ['Users'])).toBe(moved);
  });

  it('skips drafts and invalid rows and rejects bad targets', () => {
    const requests = [request('a'), { ...request('draft'), isDraft: true }, { ...request('invalid'), isInvalid: true }, request('x', 'other'), request('f', 'api', ['F'])];
    expect(placeRequests(requests, ['draft', 'invalid'], 'api', ['F'])).toBe(requests);
    expect(placeRequests(requests, ['a'], '', [])).toBe(requests);
    for (const id of ['a', 'draft', 'invalid', 'x', 'f', 'missing']) {
      expect(placeRequests(requests, ['a'], 'api', [], { id, placement: 'before' })).toBe(requests);
    }
    expect(placeRequests(requests, ['a', 'b'], 'api', [], { id: 'a', placement: 'after' })).toBe(requests);
  });

  it('moves requests from other collections and folders next to a target through the relocation', () => {
    const requests = [request('a'), request('x', 'other'), request('f', 'api', ['F']), request('b')];
    const relocate = (req: ReturnType<typeof request>, collectionId: string, folderPath: string[]) => ({ ...req, collectionId, folderPath, collection: `moved to ${collectionId}` });
    const moved = placeRequests(requests, ['x', 'f'], 'api', [], { id: 'b', placement: 'before' }, relocate);
    expect(ids(moved)).toEqual(['a', 'x', 'f', 'b']);
    expect(moved.slice(1, 3)).toMatchObject([
      { collectionId: 'api', folderPath: [], collection: 'moved to api' },
      { collectionId: 'api', folderPath: [], collection: 'moved to api' },
    ]);
    expect(placeRequests(requests, ['a', 'x'], 'other', [])[0]).toMatchObject({ collectionId: 'other', folderPath: [] });
  });

  it('returns the same list when a group drop changes nothing', () => {
    const requests = [request('a'), request('b'), request('c')];
    expect(placeRequests(requests, ['a', 'b'], 'api', [], { id: 'c', placement: 'before' })).toBe(requests);
  });
});
