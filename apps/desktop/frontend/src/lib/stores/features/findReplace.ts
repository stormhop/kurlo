import type { Collection, PersistRequestStore, SavedRequest } from '../../types/models';

export type FindReplaceScope = { collectionId: string; folderPath: string[] };

export type FindReplaceUndo = { before: SavedRequest[]; after: SavedRequest[]; replaced: number };

type FindReplaceHost = {
  activeRequestId: string;
  autosave: boolean;
  collections: Collection[];
  dirtyRequestIds: Set<string>;
  draftRequestIds: Set<string>;
  findReplaceScope: FindReplaceScope | null;
  findReplaceUndo: FindReplaceUndo | null;
  requests: SavedRequest[];
  applySavedRequest: (request: SavedRequest) => void;
  closeFloatingMenus: () => void;
  flushPendingPersist: () => void;
  folderPathMatches: (path?: string[], prefix?: string[]) => boolean;
  guardWorkspaceWritable: (action?: string) => boolean;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  persistRequestStore: PersistRequestStore;
  findReplaceUnsavedIds: () => Set<string>;
};

export const findReplaceFeature = {
  async openFindReplace(this: FindReplaceHost, collectionId: string, folderPath: string[] = []) {
    if (!this.guardWorkspaceWritable('Find and replace')) return;
    this.closeFloatingMenus();
    this.flushPendingPersist();
    if (this.autosave) await this.persistActiveRequestNow();
    this.findReplaceUndo = null;
    this.findReplaceScope = { collectionId, folderPath: [...folderPath] };
  },

  closeFindReplace(this: FindReplaceHost) {
    this.findReplaceScope = null;
    this.findReplaceUndo = null;
  },

  findReplaceScopeLabel(this: FindReplaceHost) {
    const scope = this.findReplaceScope;
    if (!scope) return '';
    const collection = this.collections.find(candidate => candidate.id === scope.collectionId)?.name ?? 'Collection';
    return scope.folderPath.length ? `${collection} / ${scope.folderPath.join(' / ')}` : collection;
  },

  findReplaceRequests(this: FindReplaceHost): SavedRequest[] {
    const scope = this.findReplaceScope;
    if (!scope) return [];
    return this.requests.filter(req =>
      req.collectionId === scope.collectionId
      && !req.isDraft
      && !req.isInvalid
      && (!scope.folderPath.length || this.folderPathMatches(req.folderPath ?? [], scope.folderPath)),
    );
  },

  findReplaceUnsavedIds(this: FindReplaceHost): Set<string> {
    if (this.autosave) return new Set();
    return new Set([...this.dirtyRequestIds].filter(id => !this.draftRequestIds.has(id)));
  },

  async applyFindReplace(this: FindReplaceHost, changed: SavedRequest[], replaced: number): Promise<boolean> {
    if (!changed.length || !this.guardWorkspaceWritable('Find and replace')) return false;
    const unsaved = this.findReplaceUnsavedIds();
    const next = new Map(changed.filter(req => !unsaved.has(req.id)).map(req => [req.id, req]));
    if (!next.size) return false;
    const previous = this.requests;
    const before = previous.filter(req => next.has(req.id));
    this.requests = previous.map(req => next.get(req.id) ?? req);
    if (!(await this.persistRequestStore())) {
      this.requests = previous;
      return false;
    }
    const active = next.get(this.activeRequestId);
    if (active) this.applySavedRequest(active);
    this.findReplaceUndo = { before, after: [...next.values()], replaced };
    return true;
  },

  async undoFindReplace(this: FindReplaceHost): Promise<boolean> {
    const undo = this.findReplaceUndo;
    if (!undo || !this.guardWorkspaceWritable('Undo replace')) return false;
    const after = new Map(undo.after.map(req => [req.id, JSON.stringify(req)]));
    const restore = new Map(undo.before
      .filter(req => {
        const current = this.requests.find(candidate => candidate.id === req.id);
        return current && JSON.stringify(current) === after.get(req.id);
      })
      .map(req => [req.id, req]));
    const previous = this.requests;
    this.requests = previous.map(req => restore.get(req.id) ?? req);
    if (!(await this.persistRequestStore())) {
      this.requests = previous;
      return false;
    }
    const active = restore.get(this.activeRequestId);
    if (active) this.applySavedRequest(active);
    this.findReplaceUndo = null;
    return true;
  },
};
