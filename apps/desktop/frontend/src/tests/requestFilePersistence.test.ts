import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCollection, makeWorkspace, normalizeSavedRequest } from '../lib/normalizers';
import { vm } from '../lib/stores/app.svelte';
import type { RequestFileYAMLResult } from '../lib/wire';

const bridge = vi.hoisted(() => ({
  getRequestFileYAML: vi.fn(),
  saveRequestFileYAML: vi.fn(),
  saveRequestStore: vi.fn(async (_payload: string) => ({ ok: true })),
  cancelQuit: vi.fn(async () => {}),
  confirmQuit: vi.fn(async () => {}),
}));
vi.mock('../lib/backend', async original => ({ ...await original<object>(), ...bridge }));

function result(url: string): RequestFileYAMLResult {
  const request = { ...vm.requests[0], id: 'one', url };
  return {
    ok: true, id: 'one', revision: url, path: 'requests/one.yml', content: url,
    requestJson: JSON.stringify(request),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const workspace = makeWorkspace('Test');
  const collection = makeCollection(workspace.id, 'API');
  vm.workspaces = [workspace];
  vm.activeWorkspaceId = workspace.id;
  vm.collections = [collection];
  vm.requests = ['one', 'two'].map(id => normalizeSavedRequest({ id, url: id, collectionId: collection.id }, [collection], workspace.id));
  vm.requestFiles.entries.clear();
  vm.requestFiles.root = '/test';
  vm.requestStoreLoaded = true;
  vm.requestStorePersistEpoch++;
  vm.autosave = true;
  vm.syncManualRequestSnapshotState({ dirtyRequestIds: new Set(), unsavedRequestSnapshots: new Map() });
  vm.savedRequestSnapshots = new Map(vm.requests.map(request => [request.id, vm.savedRequestSnapshot(request)]));
  vm.openRequestIds = ['one', 'two'];
  vm.applySavedRequest(vm.requests[0]);
  bridge.getRequestFileYAML.mockResolvedValue(result('one'));
});

afterEach(() => {
  vm.cancelPersistTimersOnly();
  vi.restoreAllMocks();
});

describe('request file persistence', () => {
  it('keeps a targeted draft on disk failure, blocks close and quit, then saves on retry', async () => {
    const target = { collectionId: vm.collections[0].id, folderPath: [] };
    await vm.openNewDraft(vm.blankSavedRequest('', 'http'));
    const draftId = vm.activeRequestId;
    vm.setRequestHeaderName('Retry from File');
    vm.url = 'https://retry.kurlo.test';
    await vm.persistActiveRequestNow();
    await vm.requestStorePersistQueue;
    vi.spyOn(vm, 'openSelectDialog').mockResolvedValue(target.collectionId);
    vi.spyOn(vm, 'openSaveChangesDialog').mockResolvedValue('save');

    bridge.saveRequestStore.mockResolvedValueOnce({ ok: false, error: 'disk unavailable' });
    await vm.closeRequestTab(draftId);
    expect(vm.openRequestIds).toContain(draftId);
    expect(vm.requestsById.get(draftId)).toMatchObject({ isDraft: true, name: 'Retry from File', url: 'https://retry.kurlo.test' });
    expect(vm.draftTarget(draftId)).toEqual(target);

    bridge.saveRequestStore.mockResolvedValueOnce({ ok: false, error: 'disk unavailable' });
    await vm.reviewDraftsBeforeQuit();
    expect(bridge.cancelQuit).toHaveBeenCalled();
    expect(bridge.confirmQuit).not.toHaveBeenCalled();
    expect(vm.openRequestIds).toContain(draftId);
    expect(vm.requestsById.get(draftId)).toMatchObject({ isDraft: true, name: 'Retry from File', url: 'https://retry.kurlo.test' });
    expect(vm.draftTarget(draftId)).toEqual(target);

    expect(await vm.saveDraftToCollection(draftId)).toBe(true);
    expect(vm.requestsById.get(draftId)).toMatchObject({
      isDraft: false,
      collectionId: target.collectionId,
      folderPath: target.folderPath,
      name: 'Retry from File',
      url: 'https://retry.kurlo.test',
    });
    expect(vm.draftTarget(draftId)).toBeUndefined();
    expect(vm.draftRequestIds.has(draftId)).toBe(false);
  });

  it('uses the new request in queued store saves and keeps another open request active', async () => {
    await vm.requestFiles.select('file');
    const draft = vm.requestFiles.active!;
    await draft.open();
    draft.edit('changed');
    let finish!: (value: RequestFileYAMLResult) => void;
    bridge.saveRequestFileYAML.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const saving = draft.save();
    await vi.waitFor(() => expect(bridge.saveRequestFileYAML).toHaveBeenCalledWith('/test', 'one', 'changed', 'one', 'requests/one.yml'));
    vm.applySavedRequest(vm.requests[1]);
    const storeSaving = vm.persistRequestStore(vm.requests);
    const written = result('changed');
    written.requestJson = JSON.stringify({ ...JSON.parse(written.requestJson!), 'x-owner': { team: 'mobile' } });
    finish(written);
    expect(await saving).toBe(true);
    expect(await storeSaving).toBe(true);
    expect(vm.activeRequestId).toBe('two');
    expect(vm.url).toBe('two');
    expect(vm.savedRequestSnapshots.get('one')?.url).toBe('changed');
    const stores = bridge.saveRequestStore.mock.calls.map(([payload]) => JSON.parse(payload));
    expect(stores.at(-1).requests.find((request: { id: string }) => request.id === 'one')).toMatchObject({
      url: 'changed', 'x-owner': { team: 'mobile' },
    });
    vm.applySavedRequest(vm.requestsById.get('one')!);
    expect(vm.snapshotActiveRequest()).toHaveProperty('x-owner.team', 'mobile');
  });

  it('saves a protocol change once a running request stops', async () => {
    const content = 'version: 1\nrequest: {id: one, url: "https://one.test"}\n';
    bridge.getRequestFileYAML.mockResolvedValueOnce({ ...result('one'), content });
    await vm.requestFiles.select('file');
    const draft = vm.requestFiles.active!;
    await draft.open();
    draft.changeProtocol('ws');
    vm.markRequestLoading('one', true);
    try {
      expect(await draft.save()).toBe(false);
      expect(draft.error).toContain('Stop the running request');
      expect(bridge.saveRequestFileYAML).not.toHaveBeenCalled();
    } finally {
      vm.markRequestLoading('one', false);
    }
    const updated = { ...vm.requestsById.get('one'), requestType: 'ws', url: 'wss://one.test' };
    bridge.saveRequestFileYAML.mockResolvedValueOnce({ ...result('r2'), content: draft.content, requestJson: JSON.stringify(updated) });
    expect(await draft.save()).toBe(true);
    expect(vm.requestType).toBe('ws');
    expect(vm.url).toBe('wss://one.test');
  });

  it('clears a formatting-only edit when Save returns the same disk revision', async () => {
    const content = 'version: 1\nrequest:\n    id: one\n    url: one\n';
    const disk = { ...result('one'), content };
    bridge.getRequestFileYAML.mockResolvedValueOnce(disk);
    await vm.requestFiles.select('file');
    const draft = vm.requestFiles.active!;
    await draft.open();
    const refresh = vi.spyOn(vm, 'scheduleGitStatusRefreshAfterPersist');
    draft.edit(content.replace('url: one', 'url: "one"'));
    bridge.saveRequestFileYAML.mockResolvedValueOnce(disk);
    expect(await draft.save()).toBe(true);
    expect(draft.content).toBe(content);
    expect(draft.canRevert).toBe(false);
    expect(vm.requestFiles.dirtyIds).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reviews dirty YAML before importing a pasted cURL command into the form', async () => {
    await vm.requestFiles.select('file');
    const draft = vm.requestFiles.active!;
    await draft.open();
    draft.edit('version: 1\nrequest: {id: one, url: edited}\n');
    const review = vi.spyOn(vm, 'openSaveChangesDialog').mockResolvedValueOnce('cancel').mockResolvedValueOnce('discard');
    const paste = { clipboardData: { getData: () => 'curl -X PUT https://pasted.test/path' }, preventDefault: vi.fn() } as unknown as ClipboardEvent;
    await vm.onUrlPaste(paste);
    expect(review).toHaveBeenCalledTimes(1);
    expect(vm.requestFiles.active).toBe(draft);
    expect(draft.content).toContain('url: edited');
    expect(vm.url).toBe('one');
    await vm.onUrlPaste(paste);
    expect(vm.requestFiles.active).toBeUndefined();
    expect(vm.url).toBe('https://pasted.test/path');
    expect(vm.method).toBe('PUT');
  });

  it('keeps manual form edits when opening File is cancelled', async () => {
    vm.autosave = false;
    vm.url = 'form change';
    vi.spyOn(vm, 'openSaveChangesDialog').mockResolvedValue('cancel');
    await vm.requestFiles.select('file');
    expect(vm.requestFiles.active).toBeUndefined();
    expect(vm.url).toBe('form change');
    expect(vm.dirtyRequestIds.has('one')).toBe(true);
    expect(bridge.getRequestFileYAML).not.toHaveBeenCalled();
  });

  it('blocks a stale read from changing the form after a file save', async () => {
    await vm.requestFiles.select('file');
    const draft = vm.requestFiles.active!;
    await draft.open();
    let finish!: (value: RequestFileYAMLResult) => void;
    bridge.getRequestFileYAML.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const refreshing = draft.open();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(await draft.open()).toBe(true);
    draft.edit('latest');
    bridge.saveRequestFileYAML.mockResolvedValue(result('latest'));
    expect(await draft.save()).toBe(true);
    finish(result('before save'));
    await refreshing;
    expect(vm.url).toBe('latest');
    expect(draft.content).toBe('latest');
  });
});
