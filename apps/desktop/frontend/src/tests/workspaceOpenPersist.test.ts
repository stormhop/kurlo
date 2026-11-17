import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  saveRequestStore: vi.fn(async () => ({ ok: true, error: '' })),
  saveRequestStoreDelta: vi.fn(async () => ({ ok: true, error: '' })),
}));
vi.mock('../lib/backend', async importOriginal => ({ ...(await importOriginal<object>()), ...backend }));

import { vm } from '../lib/stores/app.svelte';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('opening a workspace from Git', () => {
  it('drops autosaves queued for the workspace being replaced', async () => {
    vi.useFakeTimers();
    vm.requestStoreLoaded = true;
    vm.persistTimer = setTimeout(() => {}, 1000);
    vm.requestStorePersistTimer = setTimeout(() => {}, 1000);
    vm.workspacePersistTimer = setTimeout(() => {}, 1000);
    const epoch = vm.requestStorePersistEpoch;
    let seen: Record<string, unknown> = {};
    vi.spyOn(vm, 'showGitToast').mockImplementation(() => {});
    vi.spyOn(vm, 'loadRequestWorkspace').mockImplementation(async () => {
      seen = {
        persistTimer: vm.persistTimer,
        requestStorePersistTimer: vm.requestStorePersistTimer,
        workspacePersistTimer: vm.workspacePersistTimer,
        epochBumped: vm.requestStorePersistEpoch > epoch,
        saved: await vm.persistRequestStore(),
      };
      vm.requestStoreLoaded = true;
    });

    const opened = await vm.applyWorkspaceOpenResult({ ok: true, payload: '{}', git: { isRepo: false } as never, diagnostics: [], output: '', error: '' } as never, 'Checked out');

    expect(opened).toBe(true);
    expect(seen).toEqual({ persistTimer: null, requestStorePersistTimer: null, workspacePersistTimer: null, epochBumped: true, saved: false });
    expect(backend.saveRequestStore).not.toHaveBeenCalled();
    expect(backend.saveRequestStoreDelta).not.toHaveBeenCalled();
  });
});
