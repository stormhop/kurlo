import { afterEach, describe, expect, it, vi } from 'vitest';
import { vm } from '../lib/stores/app.svelte';
import { makeCollection, normalizeSavedRequest } from '../lib/normalizers';
import { emptyHttpResponse } from '../lib/wire';

function seed() {
  vm.activeWorkspaceId = 'w-clean';
  vm.workspaces = [{ id: 'w-clean', name: 'Main' } as never];
  vm.collections = [{ ...makeCollection('w-clean', 'API'), id: 'c-clean' }, { ...makeCollection('w-clean', 'Other'), id: 'c-other' }];
  const make = (id: string, collectionId: string, folderPath: string[] = []) =>
    normalizeSavedRequest({ id, name: id, collectionId, folderPath, method: 'GET', url: `https://example.test/${id}` }, vm.collections, 'w-clean');
  vm.requests = [make('keep', 'c-clean'), make('gone', 'c-clean'), make('in-folder', 'c-clean', ['Old']), make('other-1', 'c-other')];
  vm.activeRequestId = 'keep';
  vm.openRequestIds = ['keep'];
  const body = { ...emptyHttpResponse(), body: 'x'.repeat(3_000_000) };
  const all = new Map(vm.requests.map(req => [req.id, body]));
  vm.responses = new Map(all);
  vm.previousResponses = new Map(all);
  vi.spyOn(vm, 'openConfirmDialog').mockResolvedValue(true);
  vi.spyOn(vm, 'persistRequestStore').mockResolvedValue(true);
  vi.spyOn(vm, 'guardWorkspaceWritable').mockReturnValue(true);
}

afterEach(() => vi.restoreAllMocks());

describe('responses of removed requests', () => {
  it('are dropped with the request, including the previous response', async () => {
    seed();
    await vm.deleteRequest('gone');
    expect([...vm.responses.keys()]).not.toContain('gone');
    expect([...vm.previousResponses.keys()]).not.toContain('gone');
    expect([...vm.previousResponses.keys()]).toContain('keep');
  });

  it('are dropped with a folder or a collection', async () => {
    seed();
    await vm.deleteFolder('c-clean', ['Old']);
    expect([...vm.previousResponses.keys()]).not.toContain('in-folder');
    await vm.deleteCollection('c-other');
    expect([...vm.responses.keys()].sort()).toEqual(['gone', 'keep']);
    expect([...vm.previousResponses.keys()].sort()).toEqual(['gone', 'keep']);
  });
});
