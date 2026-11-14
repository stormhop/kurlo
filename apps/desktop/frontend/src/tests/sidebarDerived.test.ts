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
