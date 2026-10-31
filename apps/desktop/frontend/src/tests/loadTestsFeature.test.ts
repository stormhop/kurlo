import { describe, expect, it, vi } from 'vitest';
import { loadTestFeature, uniqueLoadTestName } from '../lib/stores/features/loadTests';
import { loadTestFingerprint } from '../lib/loadTests';
import { makeCollection, normalizeCollection, normalizeSavedRequest } from '../lib/normalizers';
import type { Collection, SavedRequest } from '../lib/types/models';
import type { LoadTest } from '../lib/wire';

function makeHost(requestType: SavedRequest['requestType'] = 'http') {
  const collection = makeCollection('ws-1', 'Shop API');
  const login = normalizeSavedRequest({ id: 'req-login', name: 'Login', collectionId: collection.id, requestType, method: 'POST', url: 'https://shop.test/login' }, [collection], 'ws-1');
  const orders = normalizeSavedRequest({ id: 'req-orders', name: 'List orders', collectionId: collection.id, requestType: 'http', method: 'GET', url: 'https://shop.test/orders' }, [collection], 'ws-1');
  const socket = normalizeSavedRequest({ id: 'req-socket', name: 'Live', collectionId: collection.id, requestType: 'ws', method: 'GET', url: 'wss://shop.test/live' }, [collection], 'ws-1');
  const saved: Collection[][] = [];
  const host = {
    ...loadTestFeature,
    activeEnvironmentId: '',
    environments: [],
    globalVariables: [],
    activeLoadTestId: '',
    activeLoadTestCollectionId: '',
    loadTestDraft: null as { collectionId: string; test: LoadTest } | null,
    loadTestEdits: null as { collectionId: string; test: LoadTest; dirty: boolean } | null,
    autosave: false,
    openSaveChangesDialog: vi.fn().mockResolvedValue('discard' as 'save' | 'discard' | 'cancel'),
    activeRequestId: 'req-login',
    activeWorkspaceId: 'ws-1',
    collections: [collection] as Collection[],
    loadTestSaveState: 'idle' as 'idle' | 'saving' | 'saved',
    loadTestSavedTimer: null as ReturnType<typeof setTimeout> | null,
    loadTestTab: 'load' as 'flow' | 'load' | 'data',
    requests: [login, orders, socket],
    sidebarView: 'history' as 'collections' | 'environments' | 'history',
    topView: 'request' as string,
    closeFloatingMenus: vi.fn(),
    guardWorkspaceWritable: () => true,
    openPromptDialog: vi.fn().mockResolvedValue(null),
    openAlertDialog: vi.fn().mockResolvedValue(undefined),
    openConfirmDialog: vi.fn().mockResolvedValue(true),
    requestForEditing: (id: string): SavedRequest | undefined => host.requests.find(request => request.id === id),
    persistActiveRequestNow: vi.fn().mockResolvedValue(undefined),
    persistRequestStore: vi.fn(async function (this: { collections: Collection[] }) {
      saved.push(JSON.parse(JSON.stringify(host.collections)));
      return true;
    }),
  };
  return { host, collection, saved };
}

function testsOf(host: { collections: Collection[] }): LoadTest[] {
  return host.collections[0].loadTests ?? [];
}

async function createSaved(host: ReturnType<typeof makeHost>['host'], collectionId: string, requestIds?: string[], name?: string) {
  await host.createLoadTest(collectionId, requestIds);
  const draft = host.loadTestDraft!.test;
  expect(await host.saveLoadTest(collectionId, name ? { ...draft, name } : draft)).toBe(true);
}

describe('load test store', () => {
  it('opens a new test from a request as a draft that reaches the collection only when saved', async () => {
    const { host, collection, saved } = makeHost();
    await host.createLoadTestFromRequest('req-login');
    expect(testsOf(host)).toEqual([]);
    expect(saved).toEqual([]);
    const test = host.loadTestDraft!.test;
    expect(host.activeLoadTest()).toMatchObject({ isDraft: true, loadTest: { id: test.id } });
    expect(test.name).toBe('New load test');
    expect(test.scenarios[0].executor).toEqual({ type: 'constant-vus', vus: 2, durationMs: 60000 });
    expect(test.scenarios[0].steps.map(step => step.requestId)).toEqual(['req-login']);
    expect(host.topView).toBe('loadtest');
    expect(host.activeLoadTestId).toBe(test.id);
    expect(host.loadTestTab).toBe('flow');
    expect(host.sidebarView).toBe('collections');
    expect(await host.saveLoadTest(collection.id, test)).toBe(true);
    expect(saved.at(-1)?.[0].loadTests?.[0].id).toBe(test.id);
    expect(host.loadTestDraft).toBeNull();
    expect(host.activeLoadTest()).toMatchObject({ isDraft: false, loadTest: { id: test.id } });
  });

  it('starts a collection load test with every request it can run', async () => {
    const { host, collection } = makeHost();
    await host.createLoadTest(collection.id);
    expect(host.loadTestDraft!.test.scenarios[0].steps.map(step => step.requestId)).toEqual(['req-login', 'req-orders']);
  });

  it('drops an unsaved draft when another test opens', async () => {
    const { host, collection } = makeHost();
    await createSaved(host, collection.id, ['req-login'], 'Saved one');
    const kept = testsOf(host)[0];
    await host.createLoadTest(collection.id);
    await host.openLoadTest(collection.id, kept.id);
    expect(host.loadTestDraft).toBeNull();
    expect(testsOf(host).map(test => test.name)).toEqual(['Saved one']);
  });

  it('uses the current unsaved request name and URL when creating and exporting a load test', async () => {
    const { host, collection } = makeHost();
    const saved = host.requests[0];
    const edited = { ...saved, name: 'стресс', url: 'http://127.0.0.1:18080/work' };
    host.requestForEditing = id => id === saved.id ? edited : host.requests.find(request => request.id === id);
    await host.createLoadTestFromRequest(saved.id);
    const test = host.loadTestDraft!.test;
    expect(test.name).toBe('New load test');
    expect(test.scenarios[0].steps[0].requestId).toBe(saved.id);
    expect(host.loadTestRequestOptions(collection.id)[0]).toMatchObject({ name: 'стресс', url: edited.url });
    const payload = JSON.parse(host.loadTestPayload(collection.id, test)!);
    expect(payload.requests[0]).toMatchObject({ name: 'стресс', url: edited.url });
    expect(host.requests[0]).toBe(saved);
    expect(host.persistActiveRequestNow).toHaveBeenCalled();
  });

  it('refuses requests that a load test cannot run', async () => {
    const { host } = makeHost();
    await host.createLoadTestFromRequest('req-socket');
    expect(host.loadTestDraft).toBeNull();
    expect(host.openAlertDialog).toHaveBeenCalled();
  });

  it('gives new tests unique names in the collection', async () => {
    const { host, collection } = makeHost();
    await createSaved(host, collection.id);
    await host.createLoadTest(collection.id);
    expect(testsOf(host).map(test => test.name)).toEqual(['New load test']);
    expect(host.loadTestDraft!.test.name).toBe('New load test 2');
    expect(uniqueLoadTestName('Smoke', [{ id: 'a', name: 'smoke', scenarios: [], settings: {} }])).toBe('Smoke 2');
  });

  it('only offers HTTP and GraphQL requests of the collection as steps', () => {
    const { host, collection } = makeHost();
    expect(host.loadTestRequestOptions(collection.id).map(request => request.id)).toEqual(['req-login', 'req-orders']);
  });

  it('renames a test from the menu or inline without changing its flow', async () => {
    const { host, collection, saved } = makeHost();
    await createSaved(host, collection.id, ['req-login']);
    const original = testsOf(host)[0];
    host.openPromptDialog.mockResolvedValueOnce(' Checkout smoke ');
    await host.renameLoadTest(collection.id, original.id);
    expect(host.openPromptDialog).toHaveBeenCalledWith('Rename load test', original.name);
    expect(testsOf(host)[0]).toMatchObject({ id: original.id, name: 'Checkout smoke', scenarios: original.scenarios, settings: original.settings });
    expect(saved.at(-1)?.[0].loadTests?.[0].name).toBe('Checkout smoke');
    const filename = testsOf(host)[0].filesystemName;
    await host.renameLoadTest(collection.id, original.id, 'Inline name');
    expect(testsOf(host)[0].name).toBe('Inline name');
    expect(testsOf(host)[0].filesystemName).not.toBe(filename);
    host.openPromptDialog.mockResolvedValueOnce(null);
    await host.renameLoadTest(collection.id, original.id);
    await host.renameLoadTest(collection.id, original.id, '  ');
    expect(testsOf(host)[0].name).toBe('Inline name');
  });

  it('duplicates a test right after the original with fresh ids', async () => {
    const { host, collection } = makeHost();
    await createSaved(host, collection.id, ['req-login'], 'Login load test');
    await createSaved(host, collection.id);
    const original = testsOf(host)[0];
    await host.duplicateLoadTest(collection.id, original.id);
    const tests = testsOf(host);
    expect(tests.map(test => test.name)).toEqual(['Login load test', 'Login load test copy', 'New load test']);
    expect(tests[1].id).not.toBe(original.id);
    expect(tests[1].scenarios).toEqual(original.scenarios);
    expect(host.activeLoadTestId).toBe(tests[1].id);
  });

  it('deletes a test after confirmation and leaves the editor', async () => {
    const { host, collection } = makeHost();
    await createSaved(host, collection.id);
    const [test] = testsOf(host);
    await host.deleteLoadTest(collection.id, test.id);
    expect(host.collections[0].loadTests).toBeUndefined();
    expect(host.topView).toBe('request');
    expect(host.activeLoadTestId).toBe('');
  });

  it('keeps the test when deletion is cancelled', async () => {
    const { host, collection } = makeHost();
    await createSaved(host, collection.id);
    host.openConfirmDialog.mockResolvedValueOnce(false);
    await host.deleteLoadTest(collection.id, testsOf(host)[0].id);
    expect(testsOf(host)).toHaveLength(1);
  });

  it('saves edits, renames the file and survives a reload', async () => {
    const { host, collection, saved } = makeHost();
    await createSaved(host, collection.id, ['req-login']);
    const [test] = testsOf(host);
    const draft: LoadTest = {
      ...test,
      name: '  Checkout flow ',
      scenarios: [{ ...test.scenarios[0], steps: [{ ...test.scenarios[0].steps[0], once: true, extract: [{ var: 'token', from: 'json', path: '$.access_token' }] }] }],
    };
    expect(await host.saveLoadTest(collection.id, draft, loadTestFingerprint(test))).toBe(true);
    const [after] = testsOf(host);
    expect(after.name).toBe('Checkout flow');
    expect(after.filesystemName).toBe('Checkout-flow');
    expect(after.scenarios[0].steps[0]).toMatchObject({ once: true, extract: [{ var: 'token', from: 'json', path: '$.access_token' }] });
    expect(host.loadTestSaveState).toBe('saved');
    const reloaded = normalizeCollection(saved.at(-1)![0], 'ws-1');
    expect(reloaded.loadTests).toEqual([after]);
  });

  it('refuses to overwrite a test that changed elsewhere', async () => {
    const { host, collection } = makeHost();
    await createSaved(host, collection.id);
    const [test] = testsOf(host);
    const stale = loadTestFingerprint(test);
    await host.saveLoadTest(collection.id, { ...test, name: 'Edited in YAML' }, stale);
    expect(await host.saveLoadTest(collection.id, { ...test, name: 'Edited here' }, stale)).toBe(false);
    expect(testsOf(host)[0].name).toBe('Edited in YAML');
    expect(host.openAlertDialog).toHaveBeenCalled();
  });

  it('asks before closing a draft and saves, discards or stays as chosen', async () => {
    const { host, collection } = makeHost();
    await host.createLoadTest(collection.id, ['req-login']);
    const draft = host.loadTestDraft!.test;
    host.reportLoadTestEdits(collection.id, { ...draft, name: 'Checkout' }, false);
    host.openSaveChangesDialog.mockResolvedValueOnce('cancel');
    await host.closeLoadTestTab();
    expect(host.openSaveChangesDialog).toHaveBeenCalledWith('Checkout');
    expect(host.activeLoadTestId).toBe(draft.id);
    expect(host.loadTestDraft).not.toBeNull();
    host.openSaveChangesDialog.mockResolvedValueOnce('save');
    await host.closeLoadTestTab();
    expect(testsOf(host).map(test => test.name)).toEqual(['Checkout']);
    expect(host.activeLoadTestId).toBe('');
    await host.createLoadTest(collection.id);
    host.openSaveChangesDialog.mockResolvedValueOnce('discard');
    await host.closeLoadTestTab();
    expect(testsOf(host)).toHaveLength(1);
    expect(host.loadTestDraft).toBeNull();
  });

  it('asks about unsaved edits of a saved test only when autosave is off', async () => {
    const { host, collection } = makeHost();
    await createSaved(host, collection.id, ['req-login']);
    const [test] = testsOf(host);
    host.reportLoadTestEdits(collection.id, { ...test, name: 'Edited' }, true);
    host.openSaveChangesDialog.mockClear();
    host.openSaveChangesDialog.mockResolvedValueOnce('cancel');
    await host.createLoadTest(collection.id);
    expect(host.openSaveChangesDialog).toHaveBeenCalledWith('Edited');
    expect(host.activeLoadTestId).toBe(test.id);
    host.autosave = true;
    host.openSaveChangesDialog.mockClear();
    await host.closeLoadTestTab();
    expect(host.openSaveChangesDialog).not.toHaveBeenCalled();
    expect(host.activeLoadTestId).toBe('');
  });

  it('closes the editor back to the open request', async () => {
    const { host } = makeHost();
    host.topView = 'loadtest';
    host.activeLoadTestId = 'lt';
    await host.closeLoadTestTab();
    expect(host.topView).toBe('request');
    expect(host.activeLoadTestId).toBe('');
  });
});
