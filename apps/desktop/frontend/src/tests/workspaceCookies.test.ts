import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearCookies, deleteCookie, listCookies, upsertCookie } from '../lib/backend';
import { cookieFeature } from '../lib/stores/features/cookies';
import { requestPersistenceFeature } from '../lib/stores/features/requestPersistence';
import { workspaceFeature } from '../lib/stores/features/workspace';
import type { CookieJarEntry, Workspace } from '../lib/types/models';

vi.mock('../lib/backend', () => ({
  clearCookies: vi.fn(), deleteCookie: vi.fn(), listCookies: vi.fn(), upsertCookie: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

function workspace(id: string): Workspace {
  return { id, name: id, filesystemName: id, description: '' };
}

function cookie(name: string, value: string): CookieJarEntry {
  return {
    name,
    value,
    domain: 'example.test',
    path: '/',
    expiresAt: 0,
    session: true,
    secure: false,
    httpOnly: false,
    sameSite: '',
    hostOnly: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('workspace scoped cookies', () => {
  function host() {
    return {
      ...cookieFeature,
      activeWorkspaceId: 'workspace-1',
      cookies: [cookie('sid', 'old-a')],
      workspaceCookies: { 'workspace-1': [cookie('sid', 'old-a')], 'workspace-2': [cookie('sid', 'b')] } as Record<string, CookieJarEntry[]>,
      cookieJarError: '', cookieJarLoading: false, cookieJarSaving: false,
      scheduleRequestStorePersist: vi.fn(), pointCookieSyncAtActiveWorkspace: vi.fn(),
    };
  }

  it.each(['refresh', 'capture', 'save', 'remove', 'clear'] as const)('keeps a pending %s in its original workspace', async operation => {
    let resolve!: (cookies: CookieJarEntry[]) => void;
    const pending = new Promise<CookieJarEntry[]>(done => { resolve = done; });
    vi.mocked(listCookies).mockReturnValue(pending);
    vi.mocked(clearCookies).mockReturnValue(pending);
    vi.mocked(upsertCookie).mockImplementation(() => pending.then(cookies => ({ cookies, error: '' })));
    vi.mocked(deleteCookie).mockImplementation(() => pending.then(cookies => ({ cookies, error: '' })));
    const h = host();
    const operations = {
      refresh: () => cookieFeature.refreshCookieJar.call(h as never, true, true),
      capture: () => cookieFeature.captureActiveWorkspaceCookies.call(h as never),
      save: () => cookieFeature.saveCookie.call(h as never, cookie('sid', 'new-a')),
      remove: () => cookieFeature.removeCookie.call(h as never, cookie('sid', 'old-a')),
      clear: () => cookieFeature.clearCookieJar.call(h as never),
    };
    const updating = operations[operation]();
    h.activeWorkspaceId = 'workspace-2';
    h.cookies = [cookie('sid', 'b')];
    resolve([cookie('sid', 'new-a')]);
    await updating;

    expect(h.cookies).toEqual([cookie('sid', 'b')]);
    expect(h.workspaceCookies['workspace-2']).toEqual([cookie('sid', 'b')]);
    expect(h.workspaceCookies['workspace-1']).toEqual([cookie('sid', 'new-a')]);
  });

  it('keeps every restore write on the selected workspace after switching away', async () => {
    let resolve!: (cookies: CookieJarEntry[]) => void;
    vi.mocked(clearCookies).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    vi.mocked(upsertCookie).mockResolvedValue({ cookies: [cookie('sid', 'restored-a')], error: '' });
    const h = host();
    h.workspaceCookies['workspace-1'] = [cookie('sid', 'restored-a')];
    const restoring = cookieFeature.restoreWorkspaceCookieJar.call(h as never, 'workspace-1');
    h.activeWorkspaceId = 'workspace-2';
    h.cookies = [cookie('sid', 'b')];
    resolve([]);
    await restoring;

    expect(clearCookies).toHaveBeenCalledWith('workspace-1');
    expect(upsertCookie).toHaveBeenCalledWith('workspace-1', cookie('sid', 'restored-a'));
    expect(h.cookies).toEqual([cookie('sid', 'b')]);
    expect(h.workspaceCookies['workspace-2']).toEqual([cookie('sid', 'b')]);
    expect(h.pointCookieSyncAtActiveWorkspace).not.toHaveBeenCalled();
  });

  it('captures an explicitly named workspace instead of the active one', async () => {
    vi.mocked(listCookies).mockResolvedValue([cookie('sid', 'a')]);
    const h = host();
    h.activeWorkspaceId = 'workspace-2';
    h.cookies = [cookie('sid', 'b')];
    await cookieFeature.captureActiveWorkspaceCookies.call(h as never, 'workspace-1');
    expect(listCookies).toHaveBeenCalledWith('workspace-1');
    expect(h.cookies).toEqual([cookie('sid', 'b')]);
    expect(h.workspaceCookies['workspace-1']).toEqual([cookie('sid', 'a')]);
  });

  it('normalizes only workspace cookie buckets from the request store', () => {
    const host = {
      activeWorkspaceId: 'workspace-1',
      workspaceCookies: {},
      cookies: [],
      isRecord: (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value)),
      normalizeCookieEntry: cookieFeature.normalizeCookieEntry,
    };

    const normalized = cookieFeature.normalizeWorkspaceCookieStore.call(host as never, {
      'workspace-2': [cookie('scoped', 'kept')],
      'workspace-3': [{ name: '', value: 'invalid' }],
    });

    expect(normalized['workspace-1']).toBeUndefined();
    expect(normalized['workspace-2']).toEqual([cookie('scoped', 'kept')]);
    expect(normalized['workspace-3']).toBeUndefined();
  });

  it('persists current cookies under the active workspace without dropping other workspace jars', () => {
    const host = {
      activeWorkspaceId: 'workspace-1',
      activeRequestId: '',
      activeEnvironmentId: '',
      cookies: [cookie('sid', 'active')],
      workspaceCookies: { 'workspace-2': [cookie('sid', 'other')] },
      folderCollapseState: {},
      starredRequestIds: new Set<string>(),
      workspaces: [workspace('workspace-1'), workspace('workspace-2')],
      collections: [],
      requests: [],
      environments: [],
      globalVariables: [],
      openRequestIds: [],
      requestHistory: [],
      collectionLastRuns: {},
      pruneHistory: (history: unknown[]) => history,
      environmentsForStore: (environments: unknown[]) => environments,
      globalsForStore: () => [],
    };

    const payload = requestPersistenceFeature.requestStorePayload.call(host as never);

    expect(payload.workspaceCookies).toEqual({
      'workspace-1': [cookie('sid', 'active')],
      'workspace-2': [cookie('sid', 'other')],
    });
  });

  it('captures the old jar and restores the selected workspace jar when switching workspaces', async () => {
    const calls: Array<[string, string | undefined]> = [];
    const persistRequestStore = vi.fn().mockResolvedValue(true);
    const host = {
      activeRequestId: '',
      activeWorkspaceId: 'workspace-1',
      activeEnvironmentId: '',
      collections: [],
      environments: [],
      openRequestIds: [],
      requestHistory: [],
      requests: [],
      topView: 'request',
      workspaceMenuOpen: true,
      workspaces: [workspace('workspace-1'), workspace('workspace-2')],
      workspaceCookies: { 'workspace-2': [cookie('sid', 'other')] },
      defaultCollectionForWorkspace: () => undefined,
      openPromptDialog: vi.fn(),
      openConfirmDialog: vi.fn(),
      openAlertDialog: vi.fn(),
      guardWorkspaceWritable: () => true,
      guardWorkspaceListWritable: () => true,
      workspaceIsBlocked: () => false,
      showWorkspaceBlockedToast: vi.fn(),
      persistActiveRequestNow: vi.fn().mockResolvedValue(undefined),
      persistRequestStore,
      captureActiveWorkspaceCookies: vi.fn(async (workspaceId?: string) => { calls.push(['capture', workspaceId]); }),
      restoreWorkspaceCookieJar: vi.fn(async (workspaceId?: string) => { calls.push(['restore', workspaceId]); }),
      scheduleActiveRequestPersist: vi.fn(),
      scheduleWorkspacePersist: vi.fn(),
      applySavedRequest: vi.fn(),
    };

    await workspaceFeature.switchWorkspace.call(host as never, 'workspace-2');

    expect(calls).toEqual([
      ['capture', 'workspace-1'],
      ['restore', 'workspace-2'],
    ]);
    expect(host.activeWorkspaceId).toBe('workspace-2');
    expect(host.topView).toBe('overview');
    expect(host.workspaceMenuOpen).toBe(false);
    expect(persistRequestStore).toHaveBeenCalledWith(
      host.requests,
      host.activeRequestId,
      host.openRequestIds,
      host.workspaces,
      host.collections,
      'workspace-2',
    );
  });

  it('force persistence captures and writes cookies even when the active request is unchanged', async () => {
    const request = { id: 'request-1', isDraft: false };
    const persistRequestStore = vi.fn().mockResolvedValue(true);
    const captureActiveWorkspaceCookies = vi.fn().mockResolvedValue(undefined);
    const removeDirtyRequest = vi.fn();
    const host = {
      workspaceBlocked: false,
      workspacePersistTimer: null,
      persistTimer: null,
      activeRequestId: request.id,
      requests: [request],
      autosave: false,
      draftRequestIds: new Set<string>(),
      captureActiveWorkspaceCookies,
      persistWorkspaceNow: vi.fn(),
      snapshotActiveRequest: () => request,
      requestDiffersFromStored: () => false,
      removeDirtyRequest,
      persistRequestStore,
    };

    await requestPersistenceFeature.persistActiveRequestNow.call(host as never, true);

    expect(captureActiveWorkspaceCookies).toHaveBeenCalledTimes(1);
    expect(removeDirtyRequest).toHaveBeenCalledWith(request.id);
    expect(persistRequestStore).toHaveBeenCalledWith(host.requests, request.id);
  });
});
