import { backend, TestApp, row } from './support/appIntegration';
import { describe, it, expect, vi } from 'vitest';
import { makeWorkspace, makeCollection, normalizeSavedRequest } from '../lib/normalizers';
import { mkRow } from '../lib/constants';
import { type Environment, type KVRow, type Collection, type SavedRequest } from '../lib/types/models';

describe('manual save mode keeps workspace edits off disk until Save', () => {
  function storedEnvironment(id: string) {
    return backend.state.savedStores.at(-1)?.environments?.find(environment => environment.id === id);
  }

  async function manualApp() {
    backend.state.savedStores = [];
    backend.state.environment = {};
    backend.state.globals = {};
    const app = new TestApp() as TestApp & Record<string, any>;
    const workspace = makeWorkspace('Manual');
    app.workspaces = [workspace];
    app.activeWorkspaceId = workspace.id;
    app.collections = [makeCollection(workspace.id, 'Manual')];
    app.environments = [
      { id: 'dev', workspaceId: app.activeWorkspaceId, name: 'Dev', values: [row('host', 'dev.example.test')] },
      { id: 'prod', workspaceId: app.activeWorkspaceId, name: 'Prod', values: [row('host', 'prod.example.test')] },
    ];
    app.globalVariables = [row('region', 'eu'), mkRow()];
    await app.persistRequestStore();
    app.autosave = false;
    return app;
  }

  it('keeps an environment rename unsaved while other actions write the store', async () => {
    const app = await manualApp();
    await app.renameEnvironment('dev', 'Development');
    app.updateEnvironmentRow('dev', 0, { value: 'edited.example.test' });
    await app.selectEnvironment('prod');
    await app.openEnvironment('prod');

    expect(app.environmentSaveState).toBe('dirty');
    expect(app.environments.find((environment: Environment) => environment.id === 'dev')?.name).toBe('Development');
    expect(storedEnvironment('dev')).toMatchObject({ name: 'Dev', values: [expect.objectContaining({ value: 'dev.example.test' })] });
    expect(backend.state.savedStores.at(-1)?.activeEnvironmentId).toBe('prod');

    expect(await app.saveEnvironment()).toBe(true);
    expect(app.hasUnsavedEnvironmentChanges()).toBe(false);
    expect(storedEnvironment('dev')).toMatchObject({ name: 'Development', values: [expect.objectContaining({ value: 'edited.example.test' })] });
  });

  it('keeps a parent change unsaved and reverts all environment edits', async () => {
    const app = await manualApp();
    await app.setEnvironmentParent('prod', 'dev');
    app.updateEnvironmentRow('prod', 0, { value: 'changed' });
    await app.createEnvironment();

    expect(storedEnvironment('prod')?.parentId).toBeUndefined();
    expect(backend.state.savedStores.at(-1)?.environments).toHaveLength(3);

    await app.discardEnvironmentChanges();
    expect(app.hasUnsavedEnvironmentChanges()).toBe(false);
    expect(app.environmentSaveState).toBe('idle');
    expect(app.environments.find((environment: Environment) => environment.id === 'prod')).toMatchObject({ name: 'Prod', values: [expect.objectContaining({ value: 'prod.example.test' })] });
    expect(app.environments.find((environment: Environment) => environment.id === 'prod')?.parentId).toBeUndefined();
  });

  it('clears the unsaved mark when an edit is typed back', async () => {
    const app = await manualApp();
    app.updateEnvironmentRow('dev', 0, { value: 'x' });
    expect(app.environmentSaveState).toBe('dirty');
    app.updateEnvironmentRow('dev', 0, { value: 'dev.example.test' });
    expect(app.environmentSaveState).toBe('idle');
    expect(app.hasUnsavedEnvironmentChanges()).toBe(false);
  });

  it('saves script-set values right away without saving the user edits next to them', async () => {
    const app = await manualApp();
    app.activeEnvironmentId = 'dev';
    app.updateEnvironmentRow('dev', 0, { value: 'typed.example.test' });
    await app.applyEnvironmentChangesFromResponse({ environmentUpdates: { token: 'abc' } }, 'dev');

    const stored = storedEnvironment('dev');
    expect(stored?.values.map((value: KVRow) => [value.key, value.value])).toEqual([['host', 'dev.example.test'], ['token', 'abc']]);
    expect(app.environmentValuesFor('dev')).toEqual({ host: 'typed.example.test', token: 'abc' });
    expect(app.hasUnsavedEnvironmentChanges()).toBe(true);
  });

  it('keeps protection a direct action that does not save pending edits', async () => {
    const app = await manualApp();
    app.updateEnvironmentRow('dev', 0, { value: 'typed' });
    await app.setEnvironmentProtected('dev', true);

    expect(storedEnvironment('dev')).toMatchObject({ protected: true, values: [expect.objectContaining({ value: 'dev.example.test' })] });
    expect(app.hasUnsavedEnvironmentChanges()).toBe(true);
  });

  it.each(['red', ''] as const)('keeps the environment color edit %j unsaved until Save', async color => {
    const app = await manualApp();
    if (!color) {
      app.environments = app.environments.map(environment => environment.id === 'dev' ? { ...environment, color: 'red' } : environment);
      await app.persistRequestStore();
    }
    const previousColor = storedEnvironment('dev')?.color;
    const savedCount = backend.state.savedStores.length;
    await app.setEnvironmentColor('dev', color);

    expect(backend.state.savedStores).toHaveLength(savedCount);
    expect(app.environmentSaveState).toBe('dirty');
    expect(app.environments.find(environment => environment.id === 'dev')?.color).toBe(color || undefined);
    expect(app.hasUnsavedEnvironmentChanges()).toBe(true);

    app.updateEnvironmentRow('dev', 0, { value: 'typed' });
    await app.selectEnvironment('prod');
    expect(storedEnvironment('dev')?.color).toBe(previousColor);
    expect(storedEnvironment('dev')?.values[0].value).toBe('dev.example.test');

    expect(await app.saveEnvironment()).toBe(true);
    expect(storedEnvironment('dev')?.color).toBe(color || undefined);
    expect(storedEnvironment('dev')?.values[0].value).toBe('typed');
    expect(app.hasUnsavedEnvironmentChanges()).toBe(false);
  });

  it('reverts environment colors and clears the unsaved mark when the original color is selected', async () => {
    const app = await manualApp();
    await app.setEnvironmentColor('dev', 'red');
    await app.discardEnvironmentChanges();

    expect(app.environments.find(environment => environment.id === 'dev')).not.toHaveProperty('color');
    expect(app.environmentSaveState).toBe('idle');
    expect(app.hasUnsavedEnvironmentChanges()).toBe(false);

    await app.setEnvironmentColor('dev', 'blue');
    await app.setEnvironmentColor('dev', '');
    expect(app.environmentSaveState).toBe('idle');
    expect(app.hasUnsavedEnvironmentChanges()).toBe(false);
    expect(storedEnvironment('dev')).not.toHaveProperty('color');
  });

  it('saves and clears environment colors with autosave enabled', async () => {
    const app = await manualApp();
    app.autosave = true;
    await app.setEnvironmentColor('dev', 'red');
    expect(storedEnvironment('dev')?.color).toBe('red');
    await app.setEnvironmentColor('dev', '');
    expect(storedEnvironment('dev')).not.toHaveProperty('color');
    expect(app.hasUnsavedEnvironmentChanges()).toBe(false);
  });

  it('restores a deleted request, folder, collection and environment in place', async () => {
    const app = await manualApp();
    const collection = app.collections[0];
    const second = makeCollection(app.activeWorkspaceId, 'Second');
    app.collections = [...app.collections, second];
    const request = (id: string, name: string, folderPath: string[] = []) => normalizeSavedRequest({ id, name, method: 'GET', url: `https://api.test/${id}`, collectionId: collection.id, collection: collection.name, folderPath }, app.collections, app.activeWorkspaceId);
    app.requests = [request('r1', 'First'), request('r2', 'In folder', ['Auth']), request('r3', 'Deep', ['Auth', 'Tokens']), request('r4', 'Last')];
    app.collections = app.collections.map((candidate: Collection) => candidate.id === collection.id ? { ...candidate, folderPaths: [['Auth'], ['Auth', 'Tokens'], ['Empty']] } : candidate);
    app.environments = app.environments.map((environment: Environment) => environment.id === 'prod' ? { ...environment, parentId: 'dev' } : environment);
    app.collections = app.collections.map((candidate: Collection) => candidate.id === second.id ? { ...candidate, environmentIds: ['dev'], defaultEnvironmentId: 'dev' } : candidate);
    await app.persistRequestStore();
    const order = () => app.requests.map((req: SavedRequest) => req.id);

    await app.deleteRequest('r2');
    expect(order()).toEqual(['r1', 'r3', 'r4']);
    expect(app.undoEntryId).toBe(app.trash[0].id);
    expect(await app.restoreDeleted(app.trash[0].id)).toBe(true);
    expect(order()).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(app.trash).toHaveLength(0);
    expect(backend.state.savedStores.at(-1)?.requests.map((req: SavedRequest) => req.id)).toEqual(['r1', 'r2', 'r3', 'r4']);

    await app.deleteFolder(collection.id, ['Auth']);
    expect(order()).toEqual(['r1', 'r4']);
    expect(app.collections.find((candidate: Collection) => candidate.id === collection.id)?.folderPaths).toEqual([['Empty']]);
    await app.restoreDeleted(app.trash[0].id);
    expect(order()).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(app.collections.find((candidate: Collection) => candidate.id === collection.id)?.folderPaths).toEqual(expect.arrayContaining([['Auth'], ['Auth', 'Tokens'], ['Empty']]));

    await app.deleteCollection(collection.id);
    expect(app.requests).toHaveLength(0);
    expect(app.trashForWorkspace(app.activeWorkspaceId, ['collection']).map((entry: { name: string }) => entry.name)).toEqual(['Manual']);
    await app.restoreDeleted(app.trash[0].id);
    expect(app.collections.map((candidate: Collection) => candidate.id)).toEqual([collection.id, second.id]);
    expect(order()).toEqual(['r1', 'r2', 'r3', 'r4']);

    await app.deleteEnvironment('dev');
    expect(app.environments.find((environment: Environment) => environment.id === 'prod')?.parentId).toBeUndefined();
    expect(app.collections.find((candidate: Collection) => candidate.id === second.id)?.environmentIds ?? []).toEqual([]);
    await app.restoreDeleted(app.trash[0].id);
    expect(app.environments.map((environment: Environment) => environment.id)).toEqual(['dev', 'prod']);
    expect(app.environments.find((environment: Environment) => environment.id === 'prod')?.parentId).toBe('dev');
    expect(app.collections.find((candidate: Collection) => candidate.id === second.id)).toMatchObject({ environmentIds: ['dev'], defaultEnvironmentId: 'dev' });
    expect(storedEnvironment('dev')).toMatchObject({ name: 'Dev' });
  });

  it('will not restore a request whose collection is gone, and keeps the entry', async () => {
    const app = await manualApp();
    const collection = app.collections[0];
    app.requests = [normalizeSavedRequest({ id: 'r1', name: 'Orphan', method: 'GET', url: 'https://api.test', collectionId: collection.id, collection: collection.name }, app.collections, app.activeWorkspaceId)];
    await app.deleteRequest('r1');
    const requestEntry = app.trash[0].id;
    await app.deleteCollection(collection.id);
    const alerts: string[] = [];
    app.openAlertDialog = async (_title: string, message: string) => { alerts.push(message); };
    expect(await app.restoreDeleted(requestEntry)).toBe(false);
    expect(alerts[0]).toContain('Restore the collection first');
    expect(app.trash.some((entry: { id: string }) => entry.id === requestEntry)).toBe(true);
    expect(app.trashRestoreProblem(app.trash[0])).toBe('');
  });

  it('keeps the newest twenty deletions', async () => {
    const app = await manualApp();
    const collection = app.collections[0];
    app.requests = Array.from({ length: 22 }, (_, index) => normalizeSavedRequest({ id: `r${index}`, name: `Request ${index}`, method: 'GET', url: `https://api.test/${index}`, collectionId: collection.id, collection: collection.name }, app.collections, app.activeWorkspaceId));
    for (let index = 0; index < 22; index += 1) await app.deleteRequest(`r${index}`);
    expect(app.trash).toHaveLength(20);
    expect(app.trash[0].name).toBe('Request 21');
    expect(app.trash.at(-1).name).toBe('Request 2');
  });

  it('keeps global variable edits unsaved until Save and reverts them', async () => {
    const app = await manualApp();
    app.updateGlobalVariableRow(0, { value: 'us' });
    await app.selectEnvironment('dev');

    expect(app.globalsSaveState).toBe('dirty');
    expect(backend.state.savedStores.at(-1)?.globals?.map((value: KVRow) => value.value)).toEqual(['eu']);

    app.discardGlobalsChanges();
    expect(app.globalVariableValues()).toEqual({ region: 'eu' });
    expect(app.globalsSaveState).toBe('idle');

    app.updateGlobalVariableRow(0, { value: 'ap' });
    expect(await app.saveGlobals()).toBe(true);
    expect(backend.state.savedStores.at(-1)?.globals?.map((value: KVRow) => value.value)).toEqual(['ap']);
    expect(app.hasUnsavedGlobalsChanges()).toBe(false);
  });

  it('saves script-set globals without the edits typed next to them', async () => {
    const app = await manualApp();
    app.updateGlobalVariableRow(0, { value: 'typed' });
    await app.applyGlobalVariableChangesFromResponse({ globalVariableUpdates: { token: 'abc' } });

    expect(backend.state.savedStores.at(-1)?.globals?.map((value: KVRow) => [value.key, value.value])).toEqual([['region', 'eu'], ['token', 'abc']]);
    expect(app.globalVariableValues()).toEqual({ region: 'typed', token: 'abc' });
  });

  it('keeps the workspace README as a draft until Save', async () => {
    const app = await manualApp();
    app.updateWorkspaceDescription('# Draft');
    await app.selectEnvironment('dev');

    expect(app.workspaceReadme()).toBe('# Draft');
    expect(backend.state.savedStores.at(-1)?.workspaces?.[0]?.description ?? '').toBe('');
    expect(app.hasUnsavedWorkspaceEdits()).toBe(true);

    expect(await app.saveWorkspaceReadmes()).toBe(true);
    expect(backend.state.savedStores.at(-1)?.workspaces?.[0]?.description).toBe('# Draft');
    expect(app.hasUnsavedWorkspaceEdits()).toBe(false);
  });

  it('asks about environment, globals and README edits before quitting', async () => {
    const app = await manualApp();
    app.updateEnvironmentRow('dev', 0, { value: 'typed' });
    app.updateGlobalVariableRow(0, { value: 'typed' });
    app.updateWorkspaceDescription('# Draft');
    const asked: string[] = [];
    app.openSaveChangesDialog = (name: string) => {
      asked.push(name);
      return Promise.resolve(name === 'Global variables' ? 'discard' : 'save');
    };

    expect(await app.reviewWorkspaceEditsBeforeQuit()).toBe(true);
    expect(asked).toEqual(['Environments', 'Global variables', 'README']);
    expect(storedEnvironment('dev')?.values[0]?.value).toBe('typed');
    expect(backend.state.savedStores.at(-1)?.globals?.[0]?.value).toBe('eu');
    expect(backend.state.savedStores.at(-1)?.workspaces?.[0]?.description).toBe('# Draft');
  });

  it('autosaves the same edits straight away', async () => {
    const app = await manualApp();
    app.autosave = true;
    await app.renameEnvironment('dev', 'Development');
    expect(storedEnvironment('dev')?.name).toBe('Development');
    app.scheduleWorkspacePersist = vi.fn();
    app.updateWorkspaceDescription('# Live');
    expect(app.scheduleWorkspacePersist).toHaveBeenCalledTimes(1);
    expect(app.workspaces[0].description).toBe('# Live');
    expect(app.workspaceReadmeDrafts).toEqual({});
    expect(app.hasUnsavedWorkspaceEdits()).toBe(false);
  });
});

describe('OpenAPI sync persistence with manual saving', () => {
  for (const [localEdit, saveFails] of [[false, false], [true, false], [true, true]]) {
    it(saveFails ? 'keeps accepted changes recoverable when saving fails' : `saves accepted parameters without leaving a dirty request with local edits ${localEdit}`, async () => {
      backend.state.savedStores = [];
      const app = new TestApp() as TestApp & Record<string, any>;
      app.autosave = false;
      app.openApiSync = {};
      app.openApiReview = null;
      const first = { openapi: '3.0.3', info: { title: 'Pets' }, paths: { '/pets': { get: { operationId: 'listPets', summary: 'List pets' } } } };
      const second = { ...first, paths: { '/pets': { get: { ...first.paths['/pets'].get, parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } }] } } } };
      await app.importOpenApiPayload(first, 'pets.json');
      const request = app.requests.find((req: SavedRequest) => !req.isDraft)!;
      const collection = app.collections.find((entry: Collection) => entry.id === request.collectionId)!;
      collection.openapi = { source: 'https://spec.test/pets.json', intervalMinutes: 15 };
      const unrelated = normalizeSavedRequest({ ...request, id: 'unrelated', name: 'Local request', url: 'https://local.test/other', openapi: undefined }, app.collections, app.activeWorkspaceId);
      app.requests = [...app.requests, unrelated];
      await app.persistRequestStore();
      app.updateRequestDirtyState(unrelated.id, { ...unrelated, requestNotes: 'Keep this unsaved' });
      await app.switchRequest(request.id);
      if (localEdit) {
        app.requestNotes = 'My local notes';
        await app.persistActiveRequestNow();
      }
      backend.readOpenApiBaseSpec.mockResolvedValue({ content: JSON.stringify(first), exists: true, path: '' });
      app.fetchOpenApiSpec = async () => ({ kind: 'spec', spec: second, text: JSON.stringify(second), hash: 'v2', etag: '', lastModified: '', sourceUrl: '' });
      await app.checkOpenApiSync(collection.id, { manual: true, review: true });
      backend.writeOpenApiBaseSpec.mockClear();
      if (saveFails) backend.saveRequestStore.mockResolvedValueOnce({ ok: false, error: 'Disk full' });
      await app.applyOpenApiReview();
      expect(app.isRequestDirty(unrelated.id)).toBe(true);
      expect(app.requestForEditing(unrelated.id)?.requestNotes).toBe('Keep this unsaved');
      expect(backend.state.savedStores.at(-1)!.requests.find(req => req.id === unrelated.id)?.requestNotes).toBe('');
      if (saveFails) {
        expect(app.alerts).toContainEqual({ title: 'OpenAPI sync failed', message: 'Kurlo could not save the workspace.' });
        expect(app.isRequestDirty(request.id)).toBe(true);
        expect(app.requestForEditing(request.id)?.params).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'limit', value: '20' })]));
        expect(app.savedRequestSnapshots.get(request.id)?.params).toEqual([]);
        expect(backend.writeOpenApiBaseSpec).not.toHaveBeenCalled();
        expect(app.openApiReview).not.toBeNull();
        return;
      }
      expect(app.alerts).toEqual([]);
      const saved = backend.state.savedStores.at(-1)!.requests.find(req => req.id === request.id)!;
      expect(saved.params).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'limit', value: '20' })]));
      expect(saved.requestNotes).toBe(localEdit ? 'My local notes' : '');
      app.updateRequestDirtyState(request.id, app.snapshotActiveRequest({ forPersistence: true }));
      expect(app.isRequestDirty(request.id)).toBe(false);
      await app.discardRequestChanges(request.id);
      expect(app.snapshotActiveRequest().params).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'limit', value: '20' })]));
    });
  }
});

describe('request reordering persistence', () => {
  it('saves sibling order in manual mode without saving unrelated request edits', async () => {
    backend.state.savedStores = [];
    const app = new TestApp() as TestApp & Record<string, any>;
    const workspace = makeWorkspace('Reorder');
    const collection = makeCollection(workspace.id, 'API');
    app.workspaces = [workspace];
    app.activeWorkspaceId = workspace.id;
    app.collections = [collection];
    app.requests = ['a', 'b', 'c'].map(id => normalizeSavedRequest({
      id, name: id, collectionId: collection.id, folderPath: [], method: 'GET', url: `https://example.test/${id}`,
    }, [collection]));
    app.activeRequestId = 'a';
    app.applySavedRequest(app.requests[0]);
    await app.persistRequestStore();
    app.autosave = false;
    app.url = 'https://example.test/unsaved';
    await app.moveRequest('c', 'a', 'before');
    expect(app.requests.map((req: SavedRequest) => req.id)).toEqual(['c', 'a', 'b']);
    const saved = backend.state.savedStores.at(-1)!;
    expect(saved.requests.map(req => req.id)).toEqual(['c', 'a', 'b']);
    expect(saved.requests.find(req => req.id === 'a')?.url).toBe('https://example.test/a');
    expect(app.url).toBe('https://example.test/unsaved');
    expect(app.activeRequestId).toBe('a');
    const saveCount = backend.state.savedStores.length;
    app.sidebarSearch = 'a';
    await app.moveRequest('a', 'c', 'before');
    expect(backend.state.savedStores).toHaveLength(saveCount);
    app.sidebarSearch = '';
    app.guardWorkspaceWritable = () => false;
    await app.moveRequest('a', 'c', 'before');
    expect(backend.state.savedStores).toHaveLength(saveCount);
    expect(app.requests.map((req: SavedRequest) => req.id)).toEqual(['c', 'a', 'b']);
  });
});
