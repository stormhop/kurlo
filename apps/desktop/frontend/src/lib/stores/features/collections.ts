import type { WorkspaceDiagnostic } from '../../backend';
import { collectionDefaultsHaveContent, collectionSettingsFingerprint, emptyCollectionDefaults, normalizeCollectionDefaults } from '../../collectionDefaults';
import {
  folderCollapsedByDefault,
  normalizeCollectionFolderPaths,
  reorderWorkspaceCollections,
  type DropPlacement,
} from '../../collections';
import { makeCollection } from '../../normalizers';
import type { Collection, CollectionGroup, FolderGroup, PersistRequestStore, RequestType, SavedRequest, SidebarView } from '../../types/models';
import { requestTabLabel } from '../../utils';
import type { TopView } from '../ui';

const FOLDER_MAP_SEPARATOR = '\u001f';

type CollectionSettingsTab = 'overview' | 'headers' | 'vars' | 'auth' | 'script' | 'tests' | 'proxy';

type CollectionHost = {
  activeCollectionSettingsId: string;
  activeRequestId: string;
  activeWorkspaceId: string;
  collectionGroups: CollectionGroup[];
  collections: Collection[];
  collectionSettingsSavedTimer: ReturnType<typeof setTimeout> | null;
  collectionSettingsSaveState: 'idle' | 'saving' | 'saved';
  collectionSettingsTab: CollectionSettingsTab;
  folderCollapseState: Record<string, boolean>;
  openCollectionMenuId: string;
  openRequestIds: string[];
  requests: SavedRequest[];
  sidebarSearch: string;
  sidebarView: SidebarView;
  topView: TopView;
  workspaceDiagnostics: WorkspaceDiagnostic[];
  workspaces: Array<{ id: string }>;
  activeCollectionId: () => string;
  allFolderGroups: (groups: CollectionGroup[]) => FolderGroup[];
  applySavedRequest: (request: SavedRequest) => void;
  blankSavedRequest: (collectionId?: string, requestType?: RequestType) => SavedRequest;
  closeFloatingMenus: () => void;
  closeCollectionSettingsTab: () => void;
  diagnosticsForCollection: (collectionId: string) => WorkspaceDiagnostic[];
  diagnosticsForRequest: (requestId: string) => WorkspaceDiagnostic[];
  disposeRealtimeSession: (id: string) => void;
  folderCollapseKey: (collectionId: string, path: string[]) => string;
  folderDisplayName: (path: string[]) => string;
  guardWorkspaceWritable: (action?: string) => boolean;
  invalidCollectionFromDiagnostic: (diagnostic: WorkspaceDiagnostic) => Collection;
  invalidRequestFromDiagnostic: (diagnostic: WorkspaceDiagnostic, collection: Collection) => SavedRequest;
  openAlertDialog: (title: string, message: string) => Promise<void>;
  openConfirmDialog: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
  openPromptDialog: (title: string, initialValue?: string, message?: string) => Promise<string | null>;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  persistRequestStore: PersistRequestStore;
  requestsForDisplay: () => SavedRequest[];
  scheduleRequestStorePersist: (delay?: number) => void;
  workspaceDiagnosticKey: (diagnostic: WorkspaceDiagnostic) => string;
  workspaceIdForCollection: (collectionId: string) => string;
};

function sortFolders(folders: FolderGroup[]) {
  folders.sort((a, b) => a.name.localeCompare(b.name));
  for (const folder of folders) sortFolders(folder.children);
}

function updateRequestCount(folder: FolderGroup): number {
  folder.requestCount = folder.requests.length + folder.children.reduce((sum, child) => sum + updateRequestCount(child), 0);
  return folder.requestCount;
}

export function requestMatchesSidebarQuery(request: SavedRequest, query: string): boolean {
  if (!query) return true;
  return requestTabLabel(request).toLowerCase().includes(query)
    || request.url.toLowerCase().includes(query)
    || (request.grpcMethod ?? '').toLowerCase().includes(query)
    || (request.grpcProtoFileName ?? '').toLowerCase().includes(query)
    || (request.folderPath ?? []).join(' / ').toLowerCase().includes(query);
}

export const collectionFeature = {
  async toggleCollectionCollapsed(this: CollectionHost, collectionId: string) {
    this.collections = this.collections.map(collection => collection.id === collectionId ? { ...collection, collapsed: !collection.collapsed } : collection);
    this.scheduleRequestStorePersist();
  },
  async createCollection(this: CollectionHost) {
    if (!this.guardWorkspaceWritable('Creating collections')) return;
    const workspaceId = this.activeWorkspaceId || this.workspaces[0]?.id;
    if (!workspaceId) return;
    const name = await this.openPromptDialog('New collection', `Collection ${this.collections.filter(collection => collection.workspaceId === workspaceId).length + 1}`, 'Collections group related requests inside the current workspace.');
    if (!name) return;
    this.collections = [...this.collections, makeCollection(workspaceId, name)];
    await this.persistRequestStore();
  },
  async renameCollection(this: CollectionHost, collectionId: string, nextName?: string) {
    if (!this.guardWorkspaceWritable('Renaming collections')) return;
    const collection = this.collections.find(candidate => candidate.id === collectionId);
    if (!collection) return;
    const name = typeof nextName === 'string'
      ? nextName.trim()
      : await this.openPromptDialog('Rename collection', collection.name);
    if (!name || name === collection.name) return;
    this.collections = this.collections.map(candidate => candidate.id === collectionId ? { ...candidate, name } : candidate);
    await this.persistRequestStore();
  },
  async openCollectionSettings(this: CollectionHost, collectionId: string) {
    if (!this.guardWorkspaceWritable('Collection settings')) return;
    const collection = this.collections.find(candidate => candidate.id === collectionId);
    if (!collection || collection.isInvalid) return;
    this.closeFloatingMenus();
    await this.persistActiveRequestNow();
    this.activeWorkspaceId = collection.workspaceId;
    this.activeCollectionSettingsId = collectionId;
    this.collectionSettingsTab = 'overview';
    this.sidebarView = 'collections';
    this.topView = 'collection';
    await this.persistRequestStore();
  },
  closeCollectionSettingsTab(this: CollectionHost) {
    this.activeCollectionSettingsId = '';
    if (this.activeRequestId) this.topView = 'request';
    else this.topView = 'overview';
  },
  collectionRequestCount(this: CollectionHost, collectionId: string) {
    return this.requests.filter(request => !request.isDraft && request.collectionId === collectionId).length;
  },
  async saveCollectionSettings(this: CollectionHost, collectionId: string, patch: Pick<Collection, 'name' | 'description' | 'defaults'> & { baseFingerprint?: string }): Promise<boolean> {
    if (!this.guardWorkspaceWritable('Saving collection settings')) return false;
    const collection = this.collections.find(candidate => candidate.id === collectionId);
    if (!collection || collection.isInvalid) return false;
    if (patch.baseFingerprint && collectionSettingsFingerprint(collection) !== patch.baseFingerprint) {
      await this.openAlertDialog(
        'Collection changed',
        'This collection was updated outside the open settings form. Reload the collection settings before saving so the newer YAML changes are not overwritten.'
      );
      return false;
    }
    const name = patch.name.trim() || collection.name;
    const defaults = normalizeCollectionDefaults(patch.defaults);
    this.collections = this.collections.map(candidate => candidate.id === collectionId
      ? { ...candidate, name, description: patch.description, defaults }
      : candidate);
    this.collectionSettingsSaveState = 'saving';
    if (this.collectionSettingsSavedTimer) {
      clearTimeout(this.collectionSettingsSavedTimer);
      this.collectionSettingsSavedTimer = null;
    }
    const ok = await this.persistRequestStore();
    this.collectionSettingsSaveState = ok ? 'saved' : 'idle';
    if (ok) {
      this.collectionSettingsSavedTimer = setTimeout(() => {
        this.collectionSettingsSaveState = 'idle';
        this.collectionSettingsSavedTimer = null;
      }, 1800);
    }
    return ok;
  },
  async resetCollectionSettings(this: CollectionHost, collectionId: string): Promise<boolean> {
    if (!this.guardWorkspaceWritable('Resetting collection settings')) return false;
    const collection = this.collections.find(candidate => candidate.id === collectionId);
    if (!collection || collection.isInvalid) return false;
    const confirmed = collectionDefaultsHaveContent(collection.defaults)
      ? await this.openConfirmDialog('Reset collection defaults', `Clear headers, variables, auth, scripts, tests, and proxy defaults for "${collection.name}"?`, 'Reset')
      : true;
    if (!confirmed) return false;
    this.collections = this.collections.map(candidate => candidate.id === collectionId
      ? { ...candidate, defaults: emptyCollectionDefaults() }
      : candidate);
    await this.persistRequestStore();
    return true;
  },
  async deleteCollection(this: CollectionHost, collectionId: string) {
    if (!this.guardWorkspaceWritable('Deleting collections')) return;
    const collection = this.collections.find(candidate => candidate.id === collectionId);
    if (!collection) return;
    const confirmed = await this.openConfirmDialog('Delete collection', `Delete "${collection.name}" and all requests inside it? This removes them from local storage.`);
    if (!confirmed) return;
    const requestIds = this.requests.filter(request => request.collectionId === collectionId).map(request => request.id);
    this.collections = this.collections.filter(candidate => candidate.id !== collectionId);
    this.requests = this.requests.filter(request => request.collectionId !== collectionId);
    if (this.activeCollectionSettingsId === collectionId) this.closeCollectionSettingsTab();
    for (const requestId of requestIds) this.disposeRealtimeSession(requestId);
    this.openRequestIds = this.openRequestIds.filter(id => !requestIds.includes(id));
    if (requestIds.includes(this.activeRequestId)) {
      const workspaceCollectionIds = this.collections.filter(candidate => candidate.workspaceId === collection.workspaceId).map(candidate => candidate.id);
      const next = this.requests.find(request => workspaceCollectionIds.includes(request.collectionId)) ?? this.requests[0];
      if (next) {
        this.openRequestIds = [...new Set([...this.openRequestIds, next.id])];
        this.activeWorkspaceId = this.workspaceIdForCollection(next.collectionId);
        this.applySavedRequest(next);
      } else {
        this.activeRequestId = '';
        this.topView = 'overview';
      }
    }
    await this.persistRequestStore();
  },
  async moveCollection(this: CollectionHost, sourceId: string, targetId: string, placement: DropPlacement) {
    if (sourceId === targetId) return;
    const source = this.collections.find(collection => collection.id === sourceId);
    const target = this.collections.find(collection => collection.id === targetId);
    if (!source || !target || source.workspaceId !== target.workspaceId) return;
    this.collections = reorderWorkspaceCollections(this.collections, source.workspaceId, sourceId, targetId, placement);
    this.openCollectionMenuId = '';
    await this.persistRequestStore();
  },
  invalidCollectionFromDiagnostic(this: CollectionHost, diagnostic: WorkspaceDiagnostic): Collection {
    const id = diagnostic.collectionId || `invalid-collection-${this.workspaceDiagnosticKey(diagnostic)}`;
    const name = diagnostic.path.split('/').filter(Boolean).at(-2) || 'Invalid collection';
    return {
      id,
      workspaceId: diagnostic.workspaceId || this.activeWorkspaceId,
      name,
      filesystemName: name,
      description: '',
      collapsed: false,
      defaults: emptyCollectionDefaults(),
      isInvalid: true,
      workspaceDiagnostics: [diagnostic],
    };
  },
  invalidRequestFromDiagnostic(this: CollectionHost, diagnostic: WorkspaceDiagnostic, collection: Collection): SavedRequest {
    const id = diagnostic.requestId || `invalid-request-${this.workspaceDiagnosticKey(diagnostic)}`;
    const name = diagnostic.path.split('/').filter(Boolean).at(-1) || 'Invalid request';
    return {
      ...this.blankSavedRequest(collection.id, 'http'),
      id,
      name,
      filesystemName: name.replace(/\.ya?ml$/i, ''),
      nameAuto: false,
      collectionId: collection.id,
      collection: collection.name,
      url: diagnostic.path,
      isInvalid: true,
      workspaceDiagnostics: [diagnostic],
    };
  },
  buildCollectionGroups(this: CollectionHost): CollectionGroup[] {
    const query = this.sidebarSearch.trim().toLowerCase();
    const requests = this.requestsForDisplay();
    const collections = [...this.collections.filter(collection => collection.workspaceId === this.activeWorkspaceId)];
    const existingCollectionIds = new Set(collections.map(collection => collection.id));
    for (const diagnostic of this.workspaceDiagnostics) {
      if (diagnostic.scope !== 'collection' || diagnostic.blocking) continue;
      if (diagnostic.workspaceId && diagnostic.workspaceId !== this.activeWorkspaceId) continue;
      if (!diagnostic.collectionId || existingCollectionIds.has(diagnostic.collectionId)) continue;
      const invalidCollection = this.invalidCollectionFromDiagnostic(diagnostic);
      collections.push(invalidCollection);
      existingCollectionIds.add(invalidCollection.id);
    }
    return collections.map(collection => {
      const collectionDiagnostics = [
        ...(collection.workspaceDiagnostics ?? []),
        ...this.diagnosticsForCollection(collection.id),
      ];
      collection = collectionDiagnostics.length ? { ...collection, workspaceDiagnostics: collectionDiagnostics } : collection;
      const groupRequests = requests.filter(request => {
        if (request.isDraft || request.collectionId !== collection.id) return false;
        return requestMatchesSidebarQuery(request, query);
      }).map(request => {
        const requestDiagnostics = this.diagnosticsForRequest(request.id);
        return requestDiagnostics.length ? { ...request, workspaceDiagnostics: requestDiagnostics } : request;
      });
      const existingRequestIds = new Set(groupRequests.map(request => request.id));
      for (const diagnostic of this.workspaceDiagnostics) {
        if (diagnostic.scope !== 'request' || diagnostic.blocking || diagnostic.collectionId !== collection.id) continue;
        const requestId = diagnostic.requestId || '';
        if (requestId && existingRequestIds.has(requestId)) continue;
        const invalidRequest = this.invalidRequestFromDiagnostic(diagnostic, collection);
        if (query) {
          const label = requestTabLabel(invalidRequest).toLowerCase();
          const haystack = `${label} ${invalidRequest.url} ${(invalidRequest.folderPath ?? []).join(' / ')}`.toLowerCase();
          if (!haystack.includes(query)) continue;
        }
        groupRequests.push(invalidRequest);
        existingRequestIds.add(invalidRequest.id);
      }
      const folderMap = new Map<string, FolderGroup>();
      const rootRequests: SavedRequest[] = [];
      const ensureFolderPath = (path: string[]) => {
        for (let depth = 1; depth <= path.length; depth += 1) {
          const currentPath = path.slice(0, depth);
          const mapKey = currentPath.join(FOLDER_MAP_SEPARATOR);
          if (folderMap.has(mapKey)) continue;
          const key = this.folderCollapseKey(collection.id, currentPath);
          const folder: FolderGroup = {
            key,
            path: currentPath,
            name: this.folderDisplayName(currentPath),
            requests: [],
            children: [],
            collapsed: this.folderCollapseState[key] ?? folderCollapsedByDefault(currentPath),
            requestCount: 0,
          };
          folderMap.set(mapKey, folder);
          const parent = folderMap.get(currentPath.slice(0, -1).join(FOLDER_MAP_SEPARATOR));
          if (parent) parent.children.push(folder);
        }
      };
      const collectionFolderPaths = normalizeCollectionFolderPaths(collection.folderPaths)
        .filter(path => !query || path.join(' / ').toLowerCase().includes(query));
      for (const folderPath of collectionFolderPaths) ensureFolderPath(folderPath);
      for (const request of groupRequests) {
        const path = (request.folderPath ?? []).filter(Boolean);
        if (!path.length) {
          rootRequests.push(request);
          continue;
        }
        ensureFolderPath(path);
        folderMap.get(path.join(FOLDER_MAP_SEPARATOR))?.requests.push(request);
      }
      const folders = Array.from(folderMap.values()).filter(folder => folder.path.length === 1);
      sortFolders(folders);
      for (const folder of folders) updateRequestCount(folder);
      return { collection, requests: groupRequests, rootRequests, folders };
    }).filter(group => group.requests.length || group.folders.length || !query);
  },
  allFolderGroups(this: CollectionHost, groups: CollectionGroup[]) {
    const folders: FolderGroup[] = [];
    const walk = (folder: FolderGroup) => {
      folders.push(folder);
      for (const child of folder.children) walk(child);
    };
    for (const group of groups) {
      for (const folder of group.folders) walk(folder);
    }
    return folders;
  },
  async expandActiveCollection(this: CollectionHost) {
    const id = this.activeCollectionId();
    if (!id) return;
    this.collections = this.collections.map(collection => collection.id === id ? { ...collection, collapsed: false } : collection);
    await this.persistRequestStore();
  },
  async collapseActiveCollection(this: CollectionHost) {
    const id = this.activeCollectionId();
    if (!id) return;
    this.collections = this.collections.map(collection => collection.id === id ? { ...collection, collapsed: true } : collection);
    await this.persistRequestStore();
  },
  async expandAllCollections(this: CollectionHost) {
    this.collections = this.collections.map(collection => collection.workspaceId === this.activeWorkspaceId ? { ...collection, collapsed: false } : collection);
    const next: Record<string, boolean> = {};
    for (const folder of this.allFolderGroups(this.collectionGroups)) next[folder.key] = false;
    this.folderCollapseState = next;
    await this.persistRequestStore();
  },
  async collapseAllCollections(this: CollectionHost) {
    this.collections = this.collections.map(collection => collection.workspaceId === this.activeWorkspaceId ? { ...collection, collapsed: true } : collection);
    const next: Record<string, boolean> = {};
    for (const folder of this.allFolderGroups(this.collectionGroups)) next[folder.key] = true;
    this.folderCollapseState = next;
    await this.persistRequestStore();
  },
};
