import { loadRequestStore, saveRequestStore, saveRequestStoreView } from '../../backend';
import { normalizeSavedRequest } from '../../normalizers';
import type {
  Collection,
  Environment,
  KVRow,
  PersistRequestStore,
  RequestHistoryEntry,
  RequestStore,
  SavedRequest,
  Workspace,
} from '../../types/models';
import { cloneRowsForStore } from '../../utils';
import type { CookieJarEntry } from '../../backend';
import type { CollectionRunRecord } from '../../collectionRuns';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

type RequestPersistenceHost = {
  activeEnvironmentId: string;
  activeRequestId: string;
  activeWorkspaceId: string;
  applyingSavedRequest: boolean;
  autosave: boolean;
  collectionImportToast: string;
  collections: Collection[];
  cookies: CookieJarEntry[];
  dirtyRecomputeTimer: ReturnType<typeof setTimeout> | null;
  dirtyRequestIds: Set<string>;
  draftRequestIds: Set<string>;
  environments: Environment[];
  globalVariables: KVRow[];
  externalWorkspaceChangePending: boolean;
  folderCollapseState: Record<string, boolean>;
  openRequestIds: string[];
  persistTimer: ReturnType<typeof setTimeout> | null;
  requestHistory: RequestHistoryEntry[];
  requestStoreLoaded: boolean;
  requestStorePersistEpoch: number;
  requestStorePersistQueue: Promise<unknown>;
  requestStorePersistTimer: ReturnType<typeof setTimeout> | null;
  requests: SavedRequest[];
  saveStatus: SaveStatus;
  saveStatusTimer: ReturnType<typeof setTimeout> | null;
  savedRequestSnapshots: Map<string, SavedRequest>;
  workspaceBlocked: boolean;
  workspaceCookies: Record<string, CookieJarEntry[]>;
  collectionLastRuns: Record<string, CollectionRunRecord>;
  workspacePersistTimer: ReturnType<typeof setTimeout> | null;
  workspaces: Workspace[];
  applySavedRequest: (request: SavedRequest) => void;
  captureActiveWorkspaceCookies: (workspaceId?: string) => Promise<void>;
  guardWorkspaceWritable: (action?: string) => boolean;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  persistRequestStore: PersistRequestStore;
  persistRequestStoreView: (activeId?: string, openIds?: string[], workspaceId?: string) => Promise<boolean>;
  persistWorkspaceNow: () => Promise<void>;
  pruneHistory: (history: RequestHistoryEntry[]) => RequestHistoryEntry[];
  recordSavedRequestSnapshots: (requestsForStore: SavedRequest[]) => void;
  refreshPendingExternalWorkspaceChangeIfClean: () => Promise<boolean>;
  removeDirtyRequest: (id: string) => void;
  requestStorePayload: (
    nextRequests?: SavedRequest[],
    activeId?: string,
    nextOpenIds?: string[],
    nextWorkspaces?: Workspace[],
    nextCollections?: Collection[],
    workspaceId?: string,
    nextHistory?: RequestHistoryEntry[],
    nextEnvironments?: Environment[],
    nextActiveEnvId?: string,
  ) => RequestStore;
  requestDiffersFromStored: (req: SavedRequest) => boolean;
  requestForEditing: (id: string) => SavedRequest | undefined;
  requestsForStore: (nextRequests: SavedRequest[]) => SavedRequest[];
  savedRequestSnapshot: (req: SavedRequest) => SavedRequest;
  savedRequestSnapshotFromStore: (id: string) => Promise<SavedRequest | null>;
  discardRequestChanges: (id: string) => Promise<boolean>;
  saveDraftToCollection: (draftId: string, cancelLabel?: string) => Promise<string | false | null | boolean>;
  saveRequestById: (id: string) => Promise<boolean>;
  scheduleGitStatusRefreshAfterPersist: () => void;
  setSaveStatus: (status: SaveStatus) => void;
  showExternalWorkspacePendingToast: (action?: string) => void;
  showWorkspaceBlockedToast: (action?: string, workspaceId?: string) => void;
  snapshotActiveRequest: (options?: { forPersistence?: boolean }) => SavedRequest;
  updateRequestDirtyState: (id: string, req?: SavedRequest) => void;
};

function cloneCookies(cookies: CookieJarEntry[]) {
  return cookies.map(cookie => ({ ...cookie }));
}

export const requestPersistenceFeature = {
  setSaveStatus(this: RequestPersistenceHost, status: SaveStatus) {
    this.saveStatus = status;
    if (this.saveStatusTimer) {
      clearTimeout(this.saveStatusTimer);
      this.saveStatusTimer = null;
    }
    if (status === 'saved' || status === 'error') {
      const hold = status === 'error' ? 4000 : 1500;
      this.saveStatusTimer = setTimeout(() => {
        this.saveStatus = 'idle';
        this.saveStatusTimer = null;
      }, hold);
    }
  },

  flushPendingPersist(this: RequestPersistenceHost) {
    if (this.dirtyRecomputeTimer) {
      clearTimeout(this.dirtyRecomputeTimer);
      this.dirtyRecomputeTimer = null;
      if (!this.autosave && this.activeRequestId && !this.applyingSavedRequest) {
        this.updateRequestDirtyState(this.activeRequestId, this.snapshotActiveRequest({ forPersistence: true }));
      }
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      void this.persistActiveRequestNow(true);
    }
  },

  requestStorePayload(
    this: RequestPersistenceHost,
    nextRequests = this.requests,
    activeId = this.activeRequestId,
    nextOpenIds = this.openRequestIds,
    nextWorkspaces = this.workspaces,
    nextCollections = this.collections,
    workspaceId = this.activeWorkspaceId,
    nextHistory = this.requestHistory,
    nextEnvironments = this.environments,
    nextActiveEnvId = this.activeEnvironmentId,
  ): RequestStore {
    const storeWorkspaces = nextWorkspaces.filter(workspace => !workspace.isInvalid);
    const storeWorkspaceIds = new Set(storeWorkspaces.map(workspace => workspace.id));
    const storeCollections = nextCollections.filter(collection => !collection.isInvalid && storeWorkspaceIds.has(collection.workspaceId));
    const storeCollectionIds = new Set(storeCollections.map(collection => collection.id));
    const storeRequests = nextRequests.filter(request => !request.isInvalid && storeCollectionIds.has(request.collectionId));
    const storeRequestIds = new Set(storeRequests.map(request => request.id));
    const storeEnvironments = nextEnvironments.filter(environment => storeWorkspaceIds.has(environment.workspaceId));
    const storeWorkspaceId = storeWorkspaceIds.has(workspaceId) ? workspaceId : storeWorkspaces[0]?.id ?? '';
    const storeActiveId = storeRequestIds.has(activeId) ? activeId : '';
    const storeOpenIds = nextOpenIds.filter(id => storeRequestIds.has(id));
    const storeActiveEnvId = storeEnvironments.some(environment => environment.id === nextActiveEnvId && environment.workspaceId === storeWorkspaceId) ? nextActiveEnvId : '';
    const workspaceCookies = {
      ...this.workspaceCookies,
      ...(storeWorkspaceId ? { [storeWorkspaceId]: cloneCookies(this.cookies) } : {}),
    };
    const storeWorkspaceCookies = Object.fromEntries(
      Object.entries(workspaceCookies)
        .filter(([workspaceId]) => storeWorkspaceIds.has(workspaceId))
        .map(([workspaceId, cookies]) => [workspaceId, cloneCookies(cookies)]),
    );
    return {
      version: 2,
      activeId: storeActiveId,
      activeWorkspaceId: storeWorkspaceId,
      activeEnvironmentId: storeActiveEnvId,
      openIds: storeOpenIds,
      folderCollapsed: this.folderCollapseState,
      workspaces: storeWorkspaces,
      collections: storeCollections,
      environments: storeEnvironments.map(e => ({ ...e, values: cloneRowsForStore(e.values) })),
      requests: storeRequests,
      history: this.pruneHistory(nextHistory),
      globals: cloneRowsForStore(this.globalVariables),
      workspaceCookies: storeWorkspaceCookies,
      collectionRuns: Object.fromEntries(
        Object.entries(this.collectionLastRuns).filter(([collectionId]) => storeCollections.some(collection => collection.id === collectionId)),
      ),
    };
  },

  async persistRequestStore(
    this: RequestPersistenceHost,
    nextRequests = this.requests,
    activeId = this.activeRequestId,
    nextOpenIds = this.openRequestIds,
    nextWorkspaces = this.workspaces,
    nextCollections = this.collections,
    workspaceId = this.activeWorkspaceId,
    nextHistory = this.requestHistory,
    nextEnvironments = this.environments,
    nextActiveEnvId = this.activeEnvironmentId,
  ) {
    if (this.externalWorkspaceChangePending) {
      if (await this.refreshPendingExternalWorkspaceChangeIfClean()) return true;
      this.showExternalWorkspacePendingToast('Saving');
      return false;
    }
    if (this.workspaceBlocked) {
      this.showWorkspaceBlockedToast('Saving');
      return false;
    }
    const storeRequests = this.requestsForStore(nextRequests);
    const payload = this.requestStorePayload(storeRequests, activeId, nextOpenIds, nextWorkspaces, nextCollections, workspaceId, nextHistory, nextEnvironments, nextActiveEnvId);
    const serialized = JSON.stringify(payload);
    const persistEpoch = this.requestStorePersistEpoch;
    const persistJob = this.requestStorePersistQueue.then(async () => {
      if (persistEpoch !== this.requestStorePersistEpoch) return false;
      const saved = await saveRequestStore(serialized);
      if (!saved.ok) throw new Error(saved.error || 'request store save failed');
      return saved.ok;
    });
    this.requestStorePersistQueue = persistJob.catch(() => {
      this.collectionImportToast = 'Warning: changes could not be saved';
      setTimeout(() => (this.collectionImportToast = ''), 5000);
    });
    try {
      const saved = await persistJob;
      if (saved && persistEpoch === this.requestStorePersistEpoch) {
        this.recordSavedRequestSnapshots(storeRequests);
        this.scheduleGitStatusRefreshAfterPersist();
        return true;
      }
      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message.trim() : String(err || '').trim();
      const detail = message && message !== 'request store save failed' ? ` — ${message.slice(0, 180)}` : ' — check disk space or permissions';
      this.collectionImportToast = `Warning: changes could not be saved${detail}`;
      setTimeout(() => (this.collectionImportToast = ''), 5000);
      return false;
    }
  },

  async persistRequestStoreView(
    this: RequestPersistenceHost,
    activeId = this.activeRequestId,
    nextOpenIds = this.openRequestIds,
    workspaceId = this.activeWorkspaceId,
  ) {
    const storeWorkspaceIds = new Set(this.workspaces.filter(workspace => !workspace.isInvalid).map(workspace => workspace.id));
    const storeCollectionIds = new Set(this.collections.filter(collection => !collection.isInvalid && storeWorkspaceIds.has(collection.workspaceId)).map(collection => collection.id));
    const storeRequestIds = new Set(this.requests.filter(request => !request.isInvalid && storeCollectionIds.has(request.collectionId)).map(request => request.id));
    const view = {
      activeId: storeRequestIds.has(activeId) ? activeId : '',
      activeWorkspaceId: storeWorkspaceIds.has(workspaceId) ? workspaceId : this.workspaces.find(workspace => storeWorkspaceIds.has(workspace.id))?.id ?? '',
      openIds: nextOpenIds.filter(id => storeRequestIds.has(id)),
    };
    const persistEpoch = this.requestStorePersistEpoch;
    const viewJob = this.requestStorePersistQueue.then(async () => {
      if (persistEpoch !== this.requestStorePersistEpoch) return false;
      return await saveRequestStoreView(view);
    });
    this.requestStorePersistQueue = viewJob.catch(() => undefined);
    let saved: Awaited<typeof viewJob>;
    try {
      saved = await viewJob;
    } catch {
      saved = { ok: false, error: '' };
    }
    if (saved === null) return await this.persistRequestStore(this.requests, activeId, nextOpenIds);
    if (saved === false) return false;
    return saved.ok || await this.persistRequestStore(this.requests, activeId, nextOpenIds);
  },

  scheduleRequestStorePersist(this: RequestPersistenceHost, delay = 160) {
    if (this.workspaceBlocked) return;
    if (this.requestStorePersistTimer) clearTimeout(this.requestStorePersistTimer);
    this.requestStorePersistTimer = setTimeout(() => {
      this.requestStorePersistTimer = null;
      void this.persistRequestStore();
    }, delay);
  },

  async persistActiveRequestNow(this: RequestPersistenceHost, forceDisk = false) {
    if (this.workspaceBlocked) return;
    if (forceDisk && this.workspacePersistTimer) await this.persistWorkspaceNow();
    if (forceDisk) await this.captureActiveWorkspaceCookies();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.activeRequestId) {
      if (forceDisk) await this.persistRequestStore();
      return;
    }
    const id = this.activeRequestId;
    const current = this.snapshotActiveRequest({ forPersistence: true });
    const idx = this.requests.findIndex(r => r.id === id);
    if (!this.autosave && !forceDisk) {
      if (current.isDraft || this.draftRequestIds.has(id)) {
        this.requests = idx >= 0 ? this.requests.map(r => r.id === id ? current : r) : [...this.requests, current];
        return;
      }
      this.updateRequestDirtyState(id, current);
      return;
    }
    if (this.autosave || forceDisk) {
      if (!this.requestDiffersFromStored(current)) {
        if (forceDisk) {
          const ok = await this.persistRequestStore(this.requests, id);
          if (ok) this.removeDirtyRequest(id);
        }
        return;
      }
      const next = idx >= 0 ? this.requests.map(r => r.id === id ? current : r) : [...this.requests, current];
      this.requests = next;
      const showStatus = this.autosave && !forceDisk;
      if (showStatus) this.setSaveStatus('saving');
      const ok = await this.persistRequestStore(next, id);
      if (ok) this.removeDirtyRequest(id);
      else this.updateRequestDirtyState(id, current);
      if (showStatus) this.setSaveStatus(ok ? 'saved' : 'error');
    }
  },

  async saveActiveRequest(this: RequestPersistenceHost) {
    if (!this.guardWorkspaceWritable('Saving')) return;
    const id = this.activeRequestId;
    if (!id) return;
    const req = this.requestForEditing(id);
    if (req?.isDraft || this.draftRequestIds.has(id)) {
      await this.persistActiveRequestNow();
      await this.saveDraftToCollection(id, 'Cancel');
      return;
    }
    await this.saveRequestById(id);
  },

  async saveRequestById(this: RequestPersistenceHost, id: string) {
    if (!this.guardWorkspaceWritable('Saving')) return false;
    if (id === this.activeRequestId && this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const current = id === this.activeRequestId ? this.snapshotActiveRequest() : this.requestForEditing(id);
    if (!current || current.isDraft) return false;
    const updatedRequests = this.requests.map(r => r.id === id ? current : r);
    this.requests = updatedRequests;
    this.removeDirtyRequest(id);
    const ok = await this.persistRequestStore(updatedRequests, this.activeRequestId);
    if (ok) {
      this.savedRequestSnapshots.set(id, this.savedRequestSnapshot(current));
    } else {
      this.updateRequestDirtyState(id, current);
    }
    return ok;
  },

  async saveDirtyRequestsToDisk(this: RequestPersistenceHost) {
    if (this.activeRequestId) await this.persistActiveRequestNow(true);
    for (const dirtyId of [...this.dirtyRequestIds]) {
      await this.saveRequestById(dirtyId);
    }
  },

  async savedRequestSnapshotFromStore(this: RequestPersistenceHost, id: string): Promise<SavedRequest | null> {
    try {
      const raw = await loadRequestStore();
      if (!raw.trim()) return null;
      const parsed = JSON.parse(raw) as Partial<RequestStore>;
      const req = (parsed.requests ?? []).find(candidate => candidate?.id === id);
      return req ? normalizeSavedRequest(req, this.collections, this.activeWorkspaceId) : null;
    } catch {
      return null;
    }
  },

  async discardRequestChanges(this: RequestPersistenceHost, id: string) {
    const snapshot = this.savedRequestSnapshots.get(id) ?? await this.savedRequestSnapshotFromStore(id);
    if (!snapshot) {
      this.removeDirtyRequest(id);
      return false;
    }
    const restored = this.savedRequestSnapshot(snapshot);
    this.requests = this.requests.map(r => r.id === id ? restored : r);
    this.savedRequestSnapshots.set(id, this.savedRequestSnapshot(restored));
    this.removeDirtyRequest(id);
    if (id === this.activeRequestId) this.applySavedRequest(restored);
    return true;
  },

  async revertActiveRequestChanges(this: RequestPersistenceHost) {
    if (!this.activeRequestId || this.autosave) return;
    if (await this.discardRequestChanges(this.activeRequestId)) {
      await this.persistRequestStore(this.requests, this.activeRequestId, this.openRequestIds);
    }
  },

  scheduleActiveRequestPersist(this: RequestPersistenceHost) {
    if (this.workspaceBlocked) return;
    if (!this.requestStoreLoaded || this.applyingSavedRequest || !this.activeRequestId) return;
    if (!this.autosave) {
      const id = this.activeRequestId;
      const isDraft = this.draftRequestIds.has(id) || (this.requestForEditing(id)?.isDraft ?? false);
      if (isDraft) {
        const current = this.snapshotActiveRequest({ forPersistence: true });
        const idx = this.requests.findIndex(r => r.id === id);
        this.requests = idx >= 0 ? this.requests.map(r => r.id === id ? current : r) : [...this.requests, current];
        return;
      }
      if (this.dirtyRecomputeTimer) clearTimeout(this.dirtyRecomputeTimer);
      this.dirtyRecomputeTimer = setTimeout(() => {
        this.dirtyRecomputeTimer = null;
        if (this.autosave || this.activeRequestId !== id) return;
        this.updateRequestDirtyState(id, this.snapshotActiveRequest({ forPersistence: true }));
      }, 250);
      return;
    }
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistActiveRequestNow();
    }, 1200);
  },
};
