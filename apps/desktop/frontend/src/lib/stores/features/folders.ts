import { MAX_FOLDER_DEPTH, MAX_FOLDER_REQUESTS } from '../../constants';
import {
  addCollectionFolderPath,
  folderCollapsedByDefault,
  removeCollectionFolderPathTree,
  renameCollectionFolderPath,
} from '../../collections';
import { removeFolderDefaultsTree, renameFolderDefaults } from '../../collectionDefaults';
import type { Collection, PersistRequestStore, RequestType, SavedRequest } from '../../types/models';
import type { TopView } from '../ui';

type FolderHost = {
  autosave: boolean;
  openNewDraft: (request: import('../../types/models').SavedRequest, target?: { collectionId: string; folderPath: string[] }) => Promise<void>;
  trashFolder: (collection: import('../../types/models').Collection, folderPath: string[], requestIds: string[]) => void;
  activeRequestId: string;
  activeCollectionSettingsId: string;
  activeFolderSettingsPath: string[];
  closeCollectionSettingsTab: () => void;
  activeWorkspaceId: string;
  collections: Collection[];
  folderCollapseState: Record<string, boolean>;
  openRequestIds: string[];
  requests: SavedRequest[];
  topView: TopView;
  applySavedRequest: (request: SavedRequest) => void;
  blankSavedRequest: (collectionId?: string, requestType?: RequestType) => SavedRequest;
  closeFloatingMenus: () => void;
  disposeRealtimeSession: (id: string) => void;
  guardWorkspaceWritable: (action?: string) => boolean;
  openAlertDialog: (title: string, message: string) => Promise<void>;
  openConfirmDialog: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
  openPromptDialog: (title: string, initialValue?: string, message?: string) => Promise<string | null>;
  openNameDialog: (title: string, initialValue?: string, message?: string) => Promise<string | null>;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  persistRequestStore: PersistRequestStore;
  scheduleRequestStorePersist: (delay?: number) => void;
  workspaceIdForCollection: (collectionId: string) => string;
  folderCollapseKey: (collectionId: string, path: string[]) => string;
  folderPathEquals: (path?: string[], target?: string[]) => boolean;
  folderPathMatches: (path?: string[], prefix?: string[]) => boolean;
  folderRequestCount: (collectionId: string, folderPath: string[]) => number;
  createRequestInFolder: (collectionId: string, folderPath: string[], requestType?: RequestType) => Promise<void>;
};

export const folderFeature = {
  folderCollapseKey(this: FolderHost, collectionId: string, path: string[]) {
    return `${collectionId}:${path.map(part => encodeURIComponent(part)).join('/')}`;
  },
  folderDisplayName(this: FolderHost, path: string[]) {
    return path.at(-1) ?? 'Folder';
  },
  folderPathMatches(this: FolderHost, path: string[] = [], prefix: string[] = []) {
    return prefix.length > 0 && prefix.every((part, index) => path[index] === part);
  },
  folderPathEquals(this: FolderHost, path: string[] = [], target: string[] = []) {
    return path.length === target.length && target.every((part, index) => path[index] === part);
  },
  folderRequestCount(this: FolderHost, collectionId: string, folderPath: string[]) {
    return this.requests.filter(request =>
      !request.isDraft && request.collectionId === collectionId && this.folderPathEquals(request.folderPath ?? [], folderPath)
    ).length;
  },
  async toggleFolderCollapsed(this: FolderHost, collectionId: string, path: string[]) {
    const key = this.folderCollapseKey(collectionId, path);
    const collapsed = this.folderCollapseState[key] ?? folderCollapsedByDefault(path);
    this.folderCollapseState = { ...this.folderCollapseState, [key]: !collapsed };
    this.scheduleRequestStorePersist();
  },
  async createRequestInFolder(this: FolderHost, collectionId: string, folderPath: string[], requestType: RequestType = 'http') {
    if (!this.guardWorkspaceWritable('Creating requests')) return;
    this.closeFloatingMenus();
    await this.persistActiveRequestNow();
    if (folderPath.length > MAX_FOLDER_DEPTH) {
      await this.openAlertDialog('Folder limit', `Folders can be nested up to ${MAX_FOLDER_DEPTH} levels.`);
      return;
    }
    if (this.folderRequestCount(collectionId, folderPath) >= MAX_FOLDER_REQUESTS) {
      await this.openAlertDialog('Folder limit', `A folder can contain up to ${MAX_FOLDER_REQUESTS} requests.`);
      return;
    }
    this.collections = this.collections.map(collection =>
      collection.id === collectionId ? addCollectionFolderPath(collection, folderPath) : collection
    );
    const wsId = this.workspaceIdForCollection(collectionId);
    if (!this.autosave) {
      if (wsId) this.activeWorkspaceId = wsId;
      await this.openNewDraft({ ...this.blankSavedRequest(collectionId, requestType), folderPath }, { collectionId, folderPath });
      return;
    }
    const next = { ...this.blankSavedRequest(collectionId, requestType), folderPath };
    this.requests = [...this.requests, next];
    this.openRequestIds = [...new Set([...this.openRequestIds, next.id])];
    if (wsId) this.activeWorkspaceId = wsId;
    this.applySavedRequest(next);
    this.topView = 'request';
    await this.persistRequestStore(this.requests, next.id, this.openRequestIds);
  },
  async createSubfolder(this: FolderHost, collectionId: string, parentPath: string[]) {
    if (!this.guardWorkspaceWritable('Creating folders')) return;
    this.closeFloatingMenus();
    if (parentPath.length >= MAX_FOLDER_DEPTH) {
      await this.openAlertDialog('Folder limit', `Folders can be nested up to ${MAX_FOLDER_DEPTH} levels.`);
      return;
    }
    const name = await this.openNameDialog('New subfolder', 'New Folder');
    const trimmed = name?.trim();
    if (!trimmed) return;
    const path = [...parentPath, trimmed];
    this.collections = this.collections.map(collection =>
      collection.id === collectionId ? addCollectionFolderPath(collection, path) : collection
    );
    const parentKey = this.folderCollapseKey(collectionId, parentPath);
    const key = this.folderCollapseKey(collectionId, path);
    this.folderCollapseState = { ...this.folderCollapseState, [parentKey]: false, [key]: false };
    await this.persistRequestStore();
  },
  async createFolderInCollection(this: FolderHost, collectionId: string) {
    if (!this.guardWorkspaceWritable('Creating folders')) return;
    this.closeFloatingMenus();
    const name = await this.openNameDialog('New folder', 'New Folder');
    const trimmed = name?.trim();
    if (!trimmed) return;
    this.collections = this.collections.map(collection =>
      collection.id === collectionId ? addCollectionFolderPath(collection, [trimmed]) : collection
    );
    const key = this.folderCollapseKey(collectionId, [trimmed]);
    this.folderCollapseState = { ...this.folderCollapseState, [key]: false };
    await this.persistRequestStore();
  },
  async renameFolder(this: FolderHost, collectionId: string, folderPath: string[]) {
    if (!this.guardWorkspaceWritable('Renaming folders')) return;
    this.closeFloatingMenus();
    const oldName = folderPath.at(-1) ?? '';
    const name = await this.openNameDialog('Rename folder', oldName);
    if (!name || name === oldName) return;
    const newPath = [...folderPath.slice(0, -1), name];
    this.collections = this.collections.map(collection =>
      collection.id === collectionId ? renameFolderDefaults(renameCollectionFolderPath(collection, folderPath, newPath), folderPath, newPath) : collection
    );
    this.requests = this.requests.map(request =>
      request.collectionId === collectionId && this.folderPathMatches(request.folderPath ?? [], folderPath)
        ? { ...request, folderPath: [...newPath, ...(request.folderPath ?? []).slice(folderPath.length)] }
        : request
    );
    if (this.activeCollectionSettingsId === collectionId && this.folderPathMatches(this.activeFolderSettingsPath, folderPath)) {
      this.activeFolderSettingsPath = [...newPath, ...this.activeFolderSettingsPath.slice(folderPath.length)];
    }
    await this.persistRequestStore();
  },
  async deleteFolder(this: FolderHost, collectionId: string, folderPath: string[]) {
    if (!this.guardWorkspaceWritable('Deleting folders')) return;
    this.closeFloatingMenus();
    const folderName = folderPath.at(-1) ?? 'this folder';
    const count = this.requests.filter(request => request.collectionId === collectionId && this.folderPathMatches(request.folderPath ?? [], folderPath)).length;
    const confirmed = await this.openConfirmDialog('Delete folder', `Delete "${folderName}" and its ${count} request${count === 1 ? '' : 's'}? You can restore it from Recently deleted until you quit Kurlo.`);
    if (!confirmed) return;
    const removed = this.requests
      .filter(request => request.collectionId === collectionId && this.folderPathMatches(request.folderPath ?? [], folderPath))
      .map(request => request.id);
    const owner = this.collections.find(collection => collection.id === collectionId);
    if (owner) this.trashFolder(owner, folderPath, removed);
    this.collections = this.collections.map(collection =>
      collection.id === collectionId ? removeFolderDefaultsTree(removeCollectionFolderPathTree(collection, folderPath), folderPath) : collection
    );
    this.requests = this.requests.filter(request => !removed.includes(request.id));
    if (this.activeCollectionSettingsId === collectionId && this.folderPathMatches(this.activeFolderSettingsPath, folderPath)) {
      this.closeCollectionSettingsTab();
    }
    for (const requestId of removed) this.disposeRealtimeSession(requestId);
    if (removed.includes(this.activeRequestId)) {
      const fallback = this.requests.find(request => !request.isDraft);
      if (fallback) {
        this.applySavedRequest(fallback);
        this.topView = 'request';
      } else {
        this.topView = 'overview';
      }
    }
    this.openRequestIds = this.openRequestIds.filter(id => !removed.includes(id));
    await this.persistRequestStore();
  },
};
