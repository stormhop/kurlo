import { addCollectionFolderPath, folderPathStartsWith } from '../../collections';
import { normalizeCollectionEnvironmentPins } from '../../collectionEnvironments';
import type { Collection, Environment, FolderDefaults, SavedRequest, Workspace } from '../../types/models';

export const TRASH_LIMIT = 20;
export const UNDO_TOAST_MS = 8000;

export type TrashKind = 'request' | 'folder' | 'collection' | 'environment';

type PlacedRequest = { request: SavedRequest; index: number };

export type TrashEntry = {
  id: string;
  kind: TrashKind;
  name: string;
  detail: string;
  workspaceId: string;
  deletedAt: number;
  requests: PlacedRequest[];
  collectionId?: string;
  collection?: { collection: Collection; index: number };
  folderPath?: string[];
  folderPaths?: string[][];
  folderDefaults?: FolderDefaults[];
  environment?: { environment: Environment; index: number; childIds: string[]; pins: { collectionId: string; isDefault: boolean }[] };
};

type TrashHost = {
  trash: TrashEntry[];
  undoEntryId: string;
  requests: SavedRequest[];
  collections: Collection[];
  environments: Environment[];
  workspaces: Workspace[];
  activeWorkspaceId: string;
  collectionImportToast: string;
  guardWorkspaceWritable: (action: string) => boolean;
  changeEnvironmentsEverywhere: (change: (environment: Environment) => Environment) => void;
  persistRequestStore: () => Promise<unknown>;
  openAlertDialog: (title: string, message: string) => Promise<void>;
};

type RememberHost = TrashHost & { rememberDeleted: (entry: Omit<TrashEntry, 'id' | 'deletedAt'>) => TrashEntry };

let undoTimer: ReturnType<typeof setTimeout> | undefined;
let entryCounter = 0;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function placed(requests: SavedRequest[], ids: Set<string>): PlacedRequest[] {
  return requests.flatMap((request, index) => ids.has(request.id) ? [{ request: clone(request), index }] : []);
}

function insertAt<T>(list: T[], items: { item: T; index: number }[]): T[] {
  const next = [...list];
  for (const { item, index } of [...items].sort((a, b) => a.index - b.index)) {
    next.splice(Math.min(Math.max(index, 0), next.length), 0, item);
  }
  return next;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function trashEntryLabel(entry: Pick<TrashEntry, 'kind' | 'name'>) {
  return `${entry.kind[0].toUpperCase()}${entry.kind.slice(1)} “${entry.name}”`;
}

export const trashFeature = {
  rememberDeleted(this: TrashHost, entry: Omit<TrashEntry, 'id' | 'deletedAt'>) {
    const full: TrashEntry = { ...entry, id: `trash-${Date.now()}-${++entryCounter}`, deletedAt: Date.now() };
    this.trash = [full, ...this.trash].slice(0, TRASH_LIMIT);
    this.undoEntryId = full.id;
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(() => {
      if (this.undoEntryId === full.id) this.undoEntryId = '';
    }, UNDO_TOAST_MS);
    return full;
  },

  trashRequest(this: RememberHost, request: SavedRequest, workspaceId: string) {
    this.rememberDeleted({
      kind: 'request', name: request.name || request.url || 'Untitled request', detail: request.collection,
      workspaceId, requests: placed(this.requests, new Set([request.id])), collectionId: request.collectionId,
    });
  },

  trashFolder(this: RememberHost, collection: Collection, folderPath: string[], requestIds: string[]) {
    this.rememberDeleted({
      kind: 'folder', name: folderPath.at(-1) ?? 'Folder',
      detail: `${collection.name} · ${plural(requestIds.length, 'request')}`,
      workspaceId: collection.workspaceId,
      requests: placed(this.requests, new Set(requestIds)),
      collectionId: collection.id,
      folderPath: [...folderPath],
      folderPaths: clone((collection.folderPaths ?? []).filter(path => folderPathStartsWith(path, folderPath))),
      folderDefaults: clone((collection.folderDefaults ?? []).filter(folder => folderPathStartsWith(folder.path, folderPath))),
    });
  },

  trashCollection(this: RememberHost, collection: Collection, requestIds: string[]) {
    this.rememberDeleted({
      kind: 'collection', name: collection.name, detail: plural(requestIds.length, 'request'),
      workspaceId: collection.workspaceId,
      requests: placed(this.requests, new Set(requestIds)),
      collectionId: collection.id,
      collection: { collection: clone(collection), index: this.collections.findIndex(candidate => candidate.id === collection.id) },
    });
  },

  trashEnvironment(this: RememberHost, environment: Environment) {
    this.rememberDeleted({
      kind: 'environment', name: environment.name, detail: plural(environment.values.filter(row => row.key).length, 'variable'),
      workspaceId: environment.workspaceId, requests: [],
      environment: {
        environment: clone(environment),
        index: this.environments.findIndex(candidate => candidate.id === environment.id),
        childIds: this.environments.filter(candidate => candidate.parentId === environment.id).map(candidate => candidate.id),
        pins: this.collections.filter(collection => collection.environmentIds?.includes(environment.id))
          .map(collection => ({ collectionId: collection.id, isDefault: collection.defaultEnvironmentId === environment.id })),
      },
    });
  },

  dismissUndo(this: TrashHost) {
    this.undoEntryId = '';
  },

  forgetDeleted(this: TrashHost, entryId: string) {
    this.trash = this.trash.filter(entry => entry.id !== entryId);
    if (this.undoEntryId === entryId) this.undoEntryId = '';
  },

  trashForWorkspace(this: TrashHost, workspaceId: string, kinds: TrashKind[]) {
    return this.trash.filter(entry => entry.workspaceId === workspaceId && kinds.includes(entry.kind));
  },

  trashRestoreProblem(this: TrashHost, entry: TrashEntry): string {
    if (!this.workspaces.some(workspace => workspace.id === entry.workspaceId)) return 'Its workspace no longer exists.';
    if (entry.kind === 'request' || entry.kind === 'folder') {
      const collection = this.collections.find(candidate => candidate.id === entry.collectionId);
      if (!collection) return `Its collection “${entry.detail.split(' · ')[0]}” was deleted. Restore the collection first.`;
    }
    if (entry.kind === 'collection' && this.collections.some(candidate => candidate.id === entry.collectionId)) return 'This collection is already back.';
    if (entry.kind === 'environment' && this.environments.some(candidate => candidate.id === entry.environment?.environment.id)) return 'This environment is already back.';
    return '';
  },

  async restoreDeleted(this: TrashHost & { trashRestoreProblem: (entry: TrashEntry) => string }, entryId: string) {
    const entry = this.trash.find(candidate => candidate.id === entryId);
    if (!entry || !this.guardWorkspaceWritable('Restoring')) return false;
    const problem = this.trashRestoreProblem(entry);
    if (problem) {
      await this.openAlertDialog(`Cannot restore ${entry.kind}`, problem);
      return false;
    }
    const existing = new Set(this.requests.map(request => request.id));
    const requests = entry.requests.filter(({ request }) => !existing.has(request.id)).map(({ request, index }) => ({ item: clone(request), index }));

    if (entry.kind === 'collection' && entry.collection) {
      this.collections = insertAt(this.collections, [{ item: clone(entry.collection.collection), index: entry.collection.index }]);
    }
    if (entry.kind === 'request' || entry.kind === 'folder') {
      this.collections = this.collections.map(collection => {
        if (collection.id !== entry.collectionId) return collection;
        let next = collection;
        for (const path of entry.folderPaths ?? []) next = addCollectionFolderPath(next, path);
        for (const { item } of requests) next = addCollectionFolderPath(next, item.folderPath);
        if (entry.folderDefaults?.length) {
          const have = new Set((next.folderDefaults ?? []).map(folder => folder.path.join('\u0000')));
          const missing = entry.folderDefaults.filter(folder => !have.has(folder.path.join('\u0000')));
          if (missing.length) next = { ...next, folderDefaults: [...(next.folderDefaults ?? []), ...clone(missing)] };
        }
        return next;
      });
    }
    if (requests.length) this.requests = insertAt(this.requests, requests);

    if (entry.kind === 'environment' && entry.environment) {
      const { environment, index, childIds, pins } = entry.environment;
      this.environments = insertAt(this.environments, [{ item: clone(environment), index }]);
      const children = new Set(childIds);
      this.changeEnvironmentsEverywhere(candidate => children.has(candidate.id) ? { ...candidate, parentId: environment.id } : candidate);
      const pinned = new Map(pins.map(pin => [pin.collectionId, pin.isDefault]));
      this.collections = this.collections.map(collection => {
        if (!pinned.has(collection.id) || collection.environmentIds?.includes(environment.id)) return collection;
        const isDefault = pinned.get(collection.id) && !collection.defaultEnvironmentId;
        return {
          ...collection,
          ...normalizeCollectionEnvironmentPins({
            environmentIds: [...(collection.environmentIds ?? []), environment.id],
            defaultEnvironmentId: isDefault ? environment.id : collection.defaultEnvironmentId,
          }),
        };
      });
    }

    this.trash = this.trash.filter(candidate => candidate.id !== entryId);
    if (this.undoEntryId === entryId) this.undoEntryId = '';
    await this.persistRequestStore();
    this.collectionImportToast = `Restored ${trashEntryLabel(entry).replace(/^\w/, letter => letter.toLowerCase())}`;
    setTimeout(() => { if (this.collectionImportToast.startsWith('Restored ')) this.collectionImportToast = ''; }, 1800);
    return true;
  },
};
