import { backend, TestApp } from './support/appIntegration';
import { describe, it, expect, vi } from 'vitest';
import { makeWorkspace, makeCollection, normalizeSavedRequest } from '../lib/normalizers';
import { trashEntryLabel } from '../lib/stores/features/trash';
import { uiShellFeature } from '../lib/stores/features/uiShell';
import { type Collection, type SavedRequest } from '../lib/types/models';

async function bulkApp() {
  backend.state.savedStores = [];
  const app = new TestApp() as TestApp & Record<string, any>;
  const workspace = makeWorkspace('Bulk');
  app.workspaces = [workspace];
  app.activeWorkspaceId = workspace.id;
  const api = makeCollection(workspace.id, 'API');
  const other = makeCollection(workspace.id, 'Other');
  app.collections = [{ ...api, folderPaths: [['Users'], ['Empty']] }, other];
  const request = (id: string, collection: Collection, folderPath: string[] = []) => normalizeSavedRequest({
    id, name: id, method: 'GET', url: `https://api.test/${id}`, collectionId: collection.id, collection: collection.name, folderPath,
  }, app.collections, workspace.id);
  app.requests = [request('a', api), request('b', api), request('u', api, ['Users']), request('c', api), request('x', other)];
  await app.persistRequestStore();
  app.autosave = false;
  return { app, api, other };
}

const order = (app: Record<string, any>) => app.requests.map((req: SavedRequest) => req.id);
const stored = () => backend.state.savedStores.at(-1)?.requests ?? [];

describe('bulk request moves', () => {
  it('moves a selection into a folder and next to a sibling in one save', async () => {
    const { app, api } = await bulkApp();
    const persist = vi.spyOn(app, 'persistRequestStore');
    await app.moveRequests(['a', 'c'], api.id, ['Users']);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(app.requests.filter((req: SavedRequest) => req.folderPath?.[0] === 'Users').map((req: SavedRequest) => req.id)).toEqual(['a', 'u', 'c']);
    expect(stored().find((req: SavedRequest) => req.id === 'c')?.folderPath).toEqual(['Users']);
    expect(app.folderCollapseState[app.folderCollapseKey(api.id, ['Users'])]).toBe(false);

    await app.moveRequests(['a', 'c'], api.id, ['Users'], { id: 'u', placement: 'after' });
    expect(order(app)).toEqual(['b', 'u', 'a', 'c', 'x']);
  });

  it('rejects missing folders, full folders, name sort and filtered trees', async () => {
    const { app, api } = await bulkApp();
    const persist = vi.spyOn(app, 'persistRequestStore');
    await app.moveRequests(['a'], api.id, ['Missing']);
    await app.moveRequests(['a'], 'missing-collection', []);
    app.requestSortMode = 'name';
    await app.moveRequests(['a'], api.id, [], { id: 'c', placement: 'after' });
    app.requestSortMode = 'manual';
    app.sidebarSearch = 'a';
    await app.moveRequests(['a'], api.id, ['Empty']);
    app.sidebarSearch = '';
    const template = app.requestsById.get('u');
    app.requests = [...app.requests, ...Array.from({ length: 48 }, (_, index) => ({ ...template, id: `full-${index}` }))];
    const alert = vi.spyOn(app, 'openAlertDialog').mockResolvedValue(undefined);
    await app.moveRequests(['a', 'b'], api.id, ['Users']);
    expect(alert).toHaveBeenCalledWith('Folder limit', expect.any(String));
    expect(persist).not.toHaveBeenCalled();
    await app.moveRequests(['a'], api.id, ['Users']);
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

describe('bulk delete, duplicate and star', () => {
  it('deletes a selection across collections with one confirmation and restores it in place', async () => {
    const { app } = await bulkApp();
    app.openRequestIds = ['b', 'x'];
    app.applySavedRequest(app.requestsById.get('b'));
    const confirm = vi.spyOn(app, 'openConfirmDialog');
    await app.deleteRequests(['b', 'u', 'x']);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][1]).toContain('Delete 3 requests?');
    expect(order(app)).toEqual(['a', 'c']);
    expect(stored().map((req: SavedRequest) => req.id)).toEqual(['a', 'c']);
    expect(app.openRequestIds).not.toContain('x');
    expect(['a', 'c']).toContain(app.activeRequestId);
    expect(app.trash).toHaveLength(1);
    expect(trashEntryLabel(app.trash[0])).toBe('3 requests');
    expect(app.trash[0].detail).toBe('API, Other');
    expect(app.collections[0].folderPaths).toContainEqual(['Users']);

    expect(await app.restoreDeleted(app.trash[0].id)).toBe(true);
    expect(order(app)).toEqual(['a', 'b', 'u', 'c', 'x']);
    expect(app.trash).toHaveLength(0);
  });

  it('explains which collection is missing before restoring a mixed selection', async () => {
    const { app, other } = await bulkApp();
    await app.deleteRequests(['a', 'x']);
    app.collections = app.collections.filter((collection: Collection) => collection.id !== other.id);
    const alert = vi.spyOn(app, 'openAlertDialog').mockResolvedValue(undefined);
    expect(await app.restoreDeleted(app.trash[0].id)).toBe(false);
    expect(alert).toHaveBeenCalledWith('Cannot restore request', 'Collection “Other” was deleted. Restore it first.');
  });

  it('keeps everything when the confirmation is declined and falls back to a single delete', async () => {
    const { app } = await bulkApp();
    vi.spyOn(app, 'openConfirmDialog').mockResolvedValueOnce(false);
    await app.deleteRequests(['a', 'b']);
    expect(order(app)).toHaveLength(5);
    const single = vi.spyOn(app, 'openConfirmDialog');
    single.mockClear();
    await app.deleteRequests(['a', 'missing']);
    expect(single.mock.calls[0][0]).toBe('Delete request');
    expect(trashEntryLabel(app.trash[0])).toBe('Request “a”');
  });

  it('duplicates a selection without switching the open request', async () => {
    const { app } = await bulkApp();
    app.applySavedRequest(app.requestsById.get('c'));
    const persist = vi.spyOn(app, 'persistRequestStore');
    const ids = await app.duplicateRequests(['a', 'u']);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(ids).toHaveLength(2);
    expect(app.activeRequestId).toBe('c');
    expect(ids.map((id: string) => app.requestsById.get(id))).toMatchObject([
      { name: 'a Copy', folderPath: [] },
      { name: 'u Copy', folderPath: ['Users'] },
    ]);
  });

  it('refuses duplicates and pastes that would overflow a folder', async () => {
    const { app } = await bulkApp();
    const template = app.requestsById.get('u');
    app.requests = [...app.requests, ...Array.from({ length: 49 }, (_, index) => ({ ...template, id: `full-${index}` }))];
    const alert = vi.spyOn(app, 'openAlertDialog').mockResolvedValue(undefined);
    const persist = vi.spyOn(app, 'persistRequestStore');
    await app.duplicateRequest('u');
    expect(alert).toHaveBeenCalledTimes(1);
    expect(await app.duplicateRequests(['a', 'u', 'full-0'])).toBeUndefined();
    expect(alert).toHaveBeenCalledTimes(2);
    app.copiedRequestItem = app.requestsById.get('u');
    await app.pasteCopiedRequestItem();
    expect(alert).toHaveBeenCalledTimes(3);
    expect(persist).not.toHaveBeenCalled();
    expect(app.requests).toHaveLength(54);

    expect(await app.duplicateRequests(['a', 'b'])).toHaveLength(2);
    expect(app.requests.filter((req: SavedRequest) => req.folderPath?.[0] === 'Users')).toHaveLength(50);
  });

  it('stars and unstars a selection and skips drafts', async () => {
    const { app } = await bulkApp();
    app.requests = app.requests.map((req: SavedRequest) => req.id === 'c' ? { ...req, isDraft: true } : req);
    await app.setRequestsStarred(['a', 'b', 'c'], true);
    expect([...app.starredRequestIds].sort()).toEqual(['a', 'b']);
    const persist = vi.spyOn(app, 'persistRequestStore');
    await app.setRequestsStarred(['a', 'b'], true);
    expect(persist).not.toHaveBeenCalled();
    await app.setRequestsStarred(['a', 'b'], false);
    expect(app.starredRequestIds.size).toBe(0);
  });

  it('applies the delete and duplicate shortcuts to a selection', async () => {
    const { app } = await bulkApp();
    app.requestSelection = { ids: ['a', 'b'], anchor: 'a' };
    await uiShellFeature.runShortcut.call(app as never, 'duplicate-item');
    expect(app.requests).toHaveLength(7);
    await uiShellFeature.runShortcut.call(app as never, 'delete-item');
    expect(order(app)).not.toContain('a');
    expect(order(app)).not.toContain('b');
  });
});

describe('moving requests to another collection', () => {
  it('moves a mixed selection into another collection and keeps edits, stars and the open request', async () => {
    const { app, api, other } = await bulkApp();
    app.requests = app.requests.map((req: SavedRequest) => req.id === 'u' ? { ...req, openapi: 'GET /users' } : req);
    app.collections = app.collections.map((collection: Collection) => collection.id === other.id ? { ...collection, collapsed: true, folderPaths: [['Inbox']] } : collection);
    app.starredRequestIds = new Set(['u']);
    app.applySavedRequest(app.requestsById.get('u'));
    app.savedRequestSnapshots = new Map([['u', { ...app.requestsById.get('u') }]]);
    const persist = vi.spyOn(app, 'persistRequestStore');
    expect(await app.moveRequests(['a', 'u', 'x'], other.id, ['Inbox'])).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(await app.moveRequests(['a'], other.id, ['Inbox'])).toBe(false);
    for (const id of ['a', 'u', 'x']) {
      expect(app.requestsById.get(id)).toMatchObject({ collectionId: other.id, collection: 'Other', folderPath: ['Inbox'] });
    }
    expect(app.requestsById.get('u')).not.toHaveProperty('openapi');
    expect(app.savedRequestSnapshots.get('u')).toMatchObject({ collectionId: other.id, folderPath: ['Inbox'] });
    expect(app.savedRequestSnapshots.get('u')).not.toHaveProperty('openapi');
    expect(app.snapshotActiveRequest({ forPersistence: true })).toMatchObject({ collectionId: other.id, collection: 'Other', folderPath: ['Inbox'] });
    expect(app.starredRequestIds.has('u')).toBe(true);
    expect(app.collections.find((collection: Collection) => collection.id === other.id)?.collapsed).toBe(false);
    expect(app.collections.find((collection: Collection) => collection.id === api.id)?.folderPaths).toContainEqual(['Users']);
    expect(stored().filter((req: SavedRequest) => req.collectionId === other.id).map((req: SavedRequest) => req.id).sort()).toEqual(['a', 'u', 'x']);
  });

  it('places requests from another collection next to a target and restores a deletion to their new home', async () => {
    const { app, api, other } = await bulkApp();
    await app.moveRequests(['x'], api.id, [], { id: 'b', placement: 'after' });
    expect(order(app)).toEqual(['a', 'b', 'x', 'u', 'c']);
    expect(app.requestsById.get('x')).toMatchObject({ collectionId: api.id, collection: 'API' });
    await app.deleteRequests(['x', 'a']);
    await app.restoreDeleted(app.trash[0].id);
    expect(app.requestsById.get('x')?.collectionId).toBe(api.id);
    expect(app.requests.filter((req: SavedRequest) => req.collectionId === other.id)).toHaveLength(0);
  });

  it('refuses collections from another workspace and invalid collections', async () => {
    const { app, api } = await bulkApp();
    const foreign = makeCollection('workspace-elsewhere', 'Elsewhere');
    app.collections = [...app.collections, foreign, { ...makeCollection(app.activeWorkspaceId, 'Broken'), id: 'broken', isInvalid: true }];
    const persist = vi.spyOn(app, 'persistRequestStore');
    await app.moveRequests(['a'], foreign.id, []);
    await app.moveRequests(['a'], 'broken', []);
    app.requests = app.requests.map((req: SavedRequest) => req.id === 'a' ? { ...req, collectionId: foreign.id } : req);
    await app.moveRequests(['a'], api.id, ['Users']);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('renaming folders inline', () => {
  it('renames a folder from the tree and moves its requests', async () => {
    const { app, api } = await bulkApp();
    const dialog = vi.spyOn(app, 'openNameDialog');
    await app.renameFolder(api.id, ['Users'], '  People  ');
    expect(dialog).not.toHaveBeenCalled();
    expect(app.requestsById.get('u')?.folderPath).toEqual(['People']);
    expect(app.collections[0].folderPaths).toContainEqual(['People']);
    expect(stored().find((req: SavedRequest) => req.id === 'u')?.folderPath).toEqual(['People']);
  });

  it('refuses a name another folder at the same level already has', async () => {
    const { app, api } = await bulkApp();
    app.collections = app.collections.map((collection: Collection) => collection.id === api.id ? { ...collection, folderPaths: [['Users'], ['Empty'], ['Users', 'Admins']] } : collection);
    const alert = vi.spyOn(app, 'openAlertDialog').mockResolvedValue(undefined);
    const persist = vi.spyOn(app, 'persistRequestStore');
    await app.renameFolder(api.id, ['Users'], 'Empty');
    expect(alert).toHaveBeenCalledWith('Folder already exists', 'This level already has a folder named "Empty".');
    expect(app.requestsById.get('u')?.folderPath).toEqual(['Users']);
    await app.renameFolder(api.id, ['Empty'], 'Admins');
    expect(app.collections[0].folderPaths).toContainEqual(['Admins']);
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
