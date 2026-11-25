import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toStore } from 'svelte/store';
import { vm } from '../lib/stores/app.svelte';
import { makeCollection, normalizeSavedRequest } from '../lib/normalizers';

describe('sidebar derived data', () => {
  let unsubscribe: Array<() => void> = [];

  beforeEach(() => {
    vi.restoreAllMocks();
    vm.activeWorkspaceId = 'sidebar-workspace';
    vm.collections = [{ ...makeCollection(vm.activeWorkspaceId, 'API'), id: 'sidebar-collection' }];
    vm.requests = [normalizeSavedRequest({ id: 'sidebar-request', name: 'First request', collectionId: 'sidebar-collection', folderPath: ['Accounts'], method: 'GET', url: 'https://example.test/accounts' }, vm.collections, vm.activeWorkspaceId)];
    vm.requestSortMode = 'manual';
    vm.environments = [{ id: 'sidebar-environment', workspaceId: vm.activeWorkspaceId, name: 'Development', values: [] }];
    vm.sidebarSearch = '';
    vm.workspaceDiagnostics = [];
    vm.folderCollapseState = {};
    vm.historyDayCollapseState = {};
    vm.requestHistory = [];
    unsubscribe = [
      toStore(() => vm.collectionGroups).subscribe(() => {}),
      toStore(() => vm.historyGroups).subscribe(() => {}),
      toStore(() => vm.activeWorkspaceEnvironments).subscribe(() => {}),
    ];
  });

  afterEach(() => {
    for (const stop of unsubscribe) stop();
    vi.restoreAllMocks();
  });

  it('builds the collection tree once across repeated row lookups', () => {
    const build = vi.spyOn(vm, 'buildCollectionGroups');
    const groups = vm.collectionGroups;

    for (let index = 0; index < 100; index++) {
      expect(vm.collectionGroups).toBe(groups);
      expect(vm.collectionGroups[0].requests[0].id).toBe('sidebar-request');
    }
    vm.activeRequestId = 'sidebar-request';
    vm.openRequestMenuId = 'request:sidebar-request';
    expect(vm.collectionGroups).toBe(groups);
    expect(build).not.toHaveBeenCalled();
  });

  it('keeps the tree when an edit leaves every sidebar row unchanged', () => {
    const groups = vm.collectionGroups;
    const build = vi.spyOn(vm, 'buildCollectionGroups');

    vm.requests = [{ ...vm.requests[0], url: 'https://example.test/accounts?page=2', body: '{"a":1}' }];
    expect(vm.collectionGroups).toBe(groups);
    expect(build).not.toHaveBeenCalled();

    vm.requests = [{ ...vm.requests[0], method: 'POST' }];
    expect(vm.collectionGroups).not.toBe(groups);
    expect(vm.collectionGroups[0].folders[0].requests[0].method).toBe('POST');

    const renamed = vm.collectionGroups;
    vm.requests = [{ ...vm.requests[0], name: '' }];
    expect(vm.collectionGroups).not.toBe(renamed);
    const unnamed = vm.collectionGroups;
    vm.requests = [{ ...vm.requests[0], url: 'https://example.test/customers' }];
    expect(vm.collectionGroups).not.toBe(unnamed);

    vm.sidebarSearch = 'customers';
    const searched = vm.collectionGroups;
    vm.requests = [{ ...vm.requests[0], name: 'Named', url: 'https://example.test/customers/1' }];
    expect(vm.collectionGroups).not.toBe(searched);
    expect(vm.collectionGroups[0].requests[0].name).toBe('Named');
    vm.requests = [{ ...vm.requests[0], url: 'https://example.test/orders' }];
    expect(vm.collectionGroups).toEqual([]);

    vm.sidebarSearch = '';
    const cleared = vm.collectionGroups;
    vm.requests = [...vm.requests, normalizeSavedRequest({ id: 'sidebar-second', name: 'Second', collectionId: 'sidebar-collection', method: 'GET', url: '' }, vm.collections, vm.activeWorkspaceId)];
    expect(vm.collectionGroups).not.toBe(cleared);
    expect(vm.collectionGroups[0].rootRequests.map(request => request.id)).toEqual(['sidebar-second']);
  });

  it('refreshes the tree after folder, filter, collapse and collection changes', () => {
    expect(vm.collectionGroups[0].folders[0].name).toBe('Accounts');
    vm.requests = [{ ...vm.requests[0], folderPath: ['Customers'] }];
    expect(vm.collectionGroups[0].folders[0].name).toBe('Customers');

    const folder = vm.collectionGroups[0].folders[0];
    vm.folderCollapseState[folder.key] = true;
    expect(vm.collectionGroups[0].folders[0].collapsed).toBe(true);

    vm.sidebarSearch = 'missing';
    expect(vm.collectionGroups).toEqual([]);
    vm.requests = [{ ...vm.requests[0], name: 'Missing account' }];
    expect(vm.collectionGroups[0].requests[0].name).toBe('Missing account');

    vm.sidebarSearch = '';
    vm.collections[0].isInvalid = true;
    expect(vm.collectionGroups[0].collection.isInvalid).toBe(true);
    vm.activeWorkspaceId = 'another-workspace';
    expect(vm.collectionGroups).toEqual([]);
  });

  it('reuses history groups and refreshes them after entries and collapse changes', () => {
    const build = vi.spyOn(vm, 'buildHistoryGroups');
    const empty = vm.historyGroups;
    expect(vm.historyGroups).toBe(empty);
    expect(build).not.toHaveBeenCalled();

    vm.requestHistory = [{ id: 'sidebar-history', request: vm.requests[0], createdAt: Date.now(), statusCode: 200, status: '200 OK', duration: 1, responseSize: 0 }];
    const groups = vm.historyGroups;
    expect(groups[0].entries[0].id).toBe('sidebar-history');
    expect(vm.historyGroups).toBe(groups);
    vm.historyDayCollapseState[groups[0].key] = true;
    expect(vm.historyGroups[0].collapsed).toBe(true);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('updates request order, membership and diagnostics without keeping stale rows', () => {
    const first = vm.requests[0];
    vm.requests = [...vm.requests, { ...first, id: 'second-request', name: 'Second request' }];
    expect(vm.collectionGroups[0].folders[0].requests.map(request => request.id)).toEqual(['sidebar-request', 'second-request']);
    vm.requests = [...vm.requests].reverse();
    expect(vm.collectionGroups[0].folders[0].requests.map(request => request.id)).toEqual(['second-request', 'sidebar-request']);
    vm.workspaceDiagnostics = [{ scope: 'request', severity: 'error', path: '/API/request.yml', message: 'Invalid YAML', requestId: first.id, collectionId: first.collectionId, blocking: false }];
    expect(vm.collectionGroups[0].requests.find(request => request.id === first.id)?.workspaceDiagnostics?.[0].message).toBe('Invalid YAML');
    vm.workspaceDiagnostics = [];
    expect(vm.collectionGroups[0].requests.find(request => request.id === first.id)?.workspaceDiagnostics).toBeUndefined();
    vm.requests = vm.requests.filter(request => request.id !== first.id);
    expect(vm.collectionGroups[0].folders[0].requests.map(request => request.id)).toEqual(['second-request']);
  });

  it('sorts each displayed request group by name and restores canonical order in manual mode', () => {
    const accountsPath = ['Accounts'];
    const nestedPath = ['Accounts', 'Active'];
    const request = (id: string, name: string, folderPath: string[] = [], url = '') =>
      ({ ...vm.requests[0], id, name, folderPath, url });
    const requests = [
      request('root-10', 'Request 10'),
      request('folder-same-first', 'Same label', accountsPath),
      request('nested-z', 'Zulu', nestedPath),
      request('nested-a', 'Alpha', nestedPath),
      request('root-2', 'request 2'),
      request('folder-2', 'Folder 2', accountsPath),
      request('folder-url', '', accountsPath, 'https://example.test/accounts/Aardvark'),
      request('folder-same-second', 'Same label', accountsPath),
    ];
    vm.requests = requests;
    const nestedKey = vm.folderCollapseKey(vm.collections[0].id, nestedPath);
    vm.folderCollapseState[nestedKey] = false;

    vm.requestSortMode = 'name';
    const sorted = vm.collectionGroups[0];
    const accounts = sorted.folders[0];
    expect(sorted.requests.map(request => request.id)).toEqual(requests.map(request => request.id));
    expect(accounts.requests.map(request => request.id)).toEqual(['folder-2', 'folder-url', 'folder-same-first', 'folder-same-second']);
    expect(accounts.children[0].requests.map(request => request.id)).toEqual(['nested-a', 'nested-z']);
    expect(sorted.rootRequests.map(request => request.id)).toEqual(['root-2', 'root-10']);
    expect(vm.visibleSidebarRequests().map(request => request.id)).toEqual([
      'nested-a', 'nested-z', 'folder-2', 'folder-url', 'folder-same-first', 'folder-same-second', 'root-2', 'root-10',
    ]);

    vm.requestSortMode = 'manual';
    const manual = vm.collectionGroups[0];
    expect(manual.requests.map(request => request.id)).toEqual(requests.map(request => request.id));
    expect(manual.rootRequests.map(request => request.id)).toEqual(['root-10', 'root-2']);
    expect(manual.folders[0].requests.map(request => request.id)).toEqual(['folder-same-first', 'folder-2', 'folder-url', 'folder-same-second']);
    expect(vm.visibleSidebarRequests().map(request => request.id)).toEqual([
      'nested-z', 'nested-a', 'folder-same-first', 'folder-2', 'folder-url', 'folder-same-second', 'root-10', 'root-2',
    ]);
    expect(vm.requests.map(request => request.id)).toEqual(requests.map(request => request.id));
  });

  it('does not persist request reordering while name sorting is active', async () => {
    vm.requestSortMode = 'name';
    vm.requests = [...vm.requests, { ...vm.requests[0], id: 'sidebar-request-2', name: 'Second request' }];
    const requestsBeforeMove = vm.requests;
    const persist = vi.spyOn(vm, 'persistRequestStore');

    await vm.moveRequest('sidebar-request-2', 'sidebar-request', 'before');

    expect(vm.requests).toBe(requestsBeforeMove);
    expect(persist).not.toHaveBeenCalled();
  });

  it('reuses environment lists and updates them when workspace membership changes', () => {
    const environments = vm.activeWorkspaceEnvironments;
    expect(vm.activeWorkspaceEnvironments).toBe(environments);
    vm.environments[0].name = 'Production';
    expect(vm.activeWorkspaceEnvironments[0].name).toBe('Production');
    vm.environments[0].workspaceId = 'another-workspace';
    expect(vm.activeWorkspaceEnvironments).toEqual([]);
    vm.activeWorkspaceId = 'another-workspace';
    expect(vm.activeWorkspaceEnvironments[0].name).toBe('Production');
  });
});
