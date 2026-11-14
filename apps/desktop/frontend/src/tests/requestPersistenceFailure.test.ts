import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/backend', () => ({
  cancelQuit: vi.fn(),
  confirmQuit: vi.fn(),
  loadRequestStore: vi.fn(),
  saveRequestStore: vi.fn(),
  saveRequestStoreDelta: vi.fn(async () => ({ ok: false, error: '', needFull: true })),
}));

import { cancelQuit, confirmQuit } from '../lib/backend';
import { requestCrudFeature } from '../lib/stores/features/requestCrud';
import { requestPersistenceFeature } from '../lib/stores/features/requestPersistence';

function request(name: string) {
  return { id: 'request-1', name, isDraft: false };
}

describe('request persistence failures', () => {
  it('keeps an autosaved request dirty when persistence fails', async () => {
    const current = request('Edited');
    const host = {
      workspaceBlocked: false,
      workspacePersistTimer: null,
      persistTimer: null,
      activeRequestId: current.id,
      requests: [request('Saved')],
      autosave: true,
      draftRequestIds: new Set<string>(),
      dirtyRequestIds: new Set([current.id]),
      captureActiveWorkspaceCookies: vi.fn(),
      persistWorkspaceNow: vi.fn(),
      snapshotActiveRequest: () => current,
      requestDiffersFromStored: () => true,
      removeDirtyRequest(id: string) {
        this.dirtyRequestIds.delete(id);
      },
      updateRequestDirtyState(id: string) {
        this.dirtyRequestIds.add(id);
      },
      persistRequestStore: vi.fn().mockResolvedValue(false),
      setSaveStatus: vi.fn(),
    };

    await requestPersistenceFeature.persistActiveRequestNow.call(host as never);

    expect(host.dirtyRequestIds.has(current.id)).toBe(true);
    expect(host.setSaveStatus).toHaveBeenLastCalledWith('error');
  });

  it('does not replace the saved snapshot when an explicit save fails', async () => {
    const saved = request('Saved');
    const current = request('Edited');
    const host = {
      activeRequestId: current.id,
      persistTimer: null,
      requests: [saved],
      dirtyRequestIds: new Set([current.id]),
      savedRequestSnapshots: new Map([[current.id, saved]]),
      guardWorkspaceWritable: vi.fn(() => true),
      snapshotActiveRequest: () => current,
      requestForEditing: () => current,
      savedRequestSnapshot: (value: typeof current) => ({ ...value }),
      removeDirtyRequest(id: string) {
        this.dirtyRequestIds.delete(id);
      },
      updateRequestDirtyState(id: string) {
        this.dirtyRequestIds.add(id);
      },
      persistRequestStore: vi.fn().mockResolvedValue(false),
    };

    await requestPersistenceFeature.saveRequestById.call(host as never, current.id);

    expect(host.dirtyRequestIds.has(current.id)).toBe(true);
    expect(host.savedRequestSnapshots.get(current.id)).toEqual(saved);
  });

  it('cancels quit when a requested save cannot be persisted', async () => {
    vi.mocked(cancelQuit).mockReset();
    vi.mocked(confirmQuit).mockReset();
    const current = request('Edited');
    const host = {
      autosave: false,
      activeRequestId: current.id,
      applyingSavedRequest: false,
      dirtyRequestIds: new Set([current.id]),
      quitReviewInProgress: false,
      requests: [current],
      topView: 'request',
      persistActiveRequestNow: vi.fn().mockResolvedValue(undefined),
      requestForEditing: () => current,
      removeDirtyRequest: vi.fn(),
      openSaveChangesDialog: vi.fn().mockResolvedValue('save'),
      saveRequestById: vi.fn().mockResolvedValue(false),
      discardRequestChanges: vi.fn(),
      openDraftRequests: () => [],
      requestHasContent: () => true,
      discardDraftRequest: vi.fn(),
      saveDraftToCollection: vi.fn(),
      persistRequestStore: vi.fn().mockResolvedValue(true),
    };

    await requestCrudFeature.reviewDraftsBeforeQuit.call(host as never);

    expect(cancelQuit).toHaveBeenCalledTimes(1);
    expect(confirmQuit).not.toHaveBeenCalled();
    expect(host.persistRequestStore).not.toHaveBeenCalled();
  });
});
