import {
  cloneSavedRequestSnapshot,
  requestDirtyFingerprint as manualRequestDirtyFingerprint,
  requestDiffersFromSavedSnapshot,
  requestForEditingSnapshot,
  updateManualRequestSnapshot,
} from '../../manualSave';
import type { ManualRequestSnapshotState } from '../../manualSave';
import type { SavedRequest } from '../../types/models';

type RequestDirtyHost = {
  autosave: boolean;
  dirtyRequestIdList: string[];
  dirtyRequestIds: Set<string>;
  draftRequestIds: Set<string>;
  requests: SavedRequest[];
  requestsById: Map<string, SavedRequest>;
  savedRequestSnapshots: Map<string, SavedRequest>;
  unsavedRequestSnapshots: Map<string, SavedRequest>;
  removeDirtyRequest: (id: string) => void;
  requestForEditing: (id: string) => SavedRequest | undefined;
  requestHasContent: (req: SavedRequest) => boolean;
  savedRequestSnapshot: (req: SavedRequest) => SavedRequest;
  syncDirtyRequestIds: (nextDirtyRequestIds: Set<string>) => void;
  syncManualRequestSnapshotState: (next: ManualRequestSnapshotState) => void;
};

export const requestDirtyFeature = {
  savedRequestSnapshot(this: RequestDirtyHost, req: SavedRequest): SavedRequest {
    return cloneSavedRequestSnapshot(req);
  },

  requestForEditing(this: RequestDirtyHost, id: string): SavedRequest | undefined {
    return requestForEditingSnapshot(id, this.requests, this.unsavedRequestSnapshots);
  },

  requestDirtyFingerprint(this: RequestDirtyHost, req: SavedRequest) {
    return manualRequestDirtyFingerprint(req);
  },

  requestDiffersFromSaved(this: RequestDirtyHost, req: SavedRequest) {
    return requestDiffersFromSavedSnapshot(req, this.savedRequestSnapshots.get(req.id));
  },

  requestDiffersFromStored(this: RequestDirtyHost, req: SavedRequest) {
    const stored = this.savedRequestSnapshots.get(req.id) ?? this.requestsById.get(req.id);
    if (!stored) return this.requestHasContent(req);
    return requestDiffersFromSavedSnapshot(req, stored);
  },

  syncDirtyRequestIds(this: RequestDirtyHost, nextDirtyRequestIds: Set<string>) {
    this.dirtyRequestIds = nextDirtyRequestIds;
    this.dirtyRequestIdList = [...nextDirtyRequestIds];
  },

  syncManualRequestSnapshotState(this: RequestDirtyHost, next: ManualRequestSnapshotState) {
    this.syncDirtyRequestIds(next.dirtyRequestIds);
    this.unsavedRequestSnapshots = next.unsavedRequestSnapshots;
  },

  isRequestDirty(this: RequestDirtyHost, id: string) {
    return this.dirtyRequestIdList.includes(id);
  },

  removeDirtyRequest(this: RequestDirtyHost, id: string) {
    const next = updateManualRequestSnapshot(
      id,
      undefined,
      this.savedRequestSnapshots,
      this.dirtyRequestIds,
      this.unsavedRequestSnapshots,
      true,
    );
    this.syncManualRequestSnapshotState(next);
  },

  updateRequestDirtyState(this: RequestDirtyHost, id: string, req?: SavedRequest) {
    const current = req ?? this.requestForEditing(id);
    if (!current || current.isDraft || this.draftRequestIds.has(id)) {
      this.removeDirtyRequest(id);
      return;
    }
    const next = updateManualRequestSnapshot(
      id,
      current,
      this.savedRequestSnapshots,
      this.dirtyRequestIds,
      this.unsavedRequestSnapshots,
    );
    this.syncManualRequestSnapshotState(next);
  },

  requestsForStore(this: RequestDirtyHost, nextRequests: SavedRequest[]) {
    if (this.autosave || this.dirtyRequestIds.size === 0) return nextRequests;
    return nextRequests.map((req) => {
      if (req.isDraft || !this.dirtyRequestIds.has(req.id)) return req;
      return this.savedRequestSnapshots.get(req.id) ?? req;
    });
  },

  recordSavedRequestSnapshots(this: RequestDirtyHost, requestsForStore: SavedRequest[]) {
    const currentIds = new Set(this.requests.filter(req => !req.isDraft).map(req => req.id));
    const next = new Map(this.savedRequestSnapshots);
    for (const req of requestsForStore) {
      if (!req.isDraft) next.set(req.id, this.savedRequestSnapshot(req));
    }
    for (const id of next.keys()) {
      if (!currentIds.has(id)) next.delete(id);
    }
    this.savedRequestSnapshots = next;
    if (this.dirtyRequestIds.size) {
      this.syncDirtyRequestIds(new Set([...this.dirtyRequestIds].filter(id => currentIds.has(id))));
    }
  },
};
