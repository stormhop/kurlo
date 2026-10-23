import { DEFAULT_COLLECTION, MAX_WORKSPACES } from '../../constants';
import { makeCollection, makeWorkspace } from '../../normalizers';
import type { Collection, Environment, PersistRequestStore, RequestHistoryEntry, SavedRequest, Workspace } from '../../types/models';
import type { CookieJarEntry } from '../../backend';

type WorkspaceHost = {
  activeRequestId: string;
  activeWorkspaceId: string;
  activeEnvironmentId: string;
  collections: Collection[];
  environments: Environment[];
  openRequestIds: string[];
  requestHistory: RequestHistoryEntry[];
  requests: SavedRequest[];
  requestsById: Map<string, SavedRequest>;
  topView: string;
  workspaceMenuOpen: boolean;
  workspaces: Workspace[];
  workspaceCookies: Record<string, CookieJarEntry[]>;
  activeWorkspace: Workspace | undefined;
  defaultCollectionForWorkspace: (workspaceId?: string) => Collection | undefined;
  openPromptDialog: (title: string, initialValue?: string, message?: string) => Promise<string | null>;
  openConfirmDialog: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
  openAlertDialog: (title: string, message: string) => Promise<void>;
  guardWorkspaceWritable: (action?: string) => boolean;
  guardWorkspaceListWritable: (action?: string) => boolean;
  workspaceIsBlocked: (workspaceId: string) => boolean;
  showWorkspaceBlockedToast: (action?: string, workspaceId?: string) => void;
  openGitTab?: (refresh?: boolean) => void;
  refreshGitStatus?: () => unknown;
  persistActiveRequestNow: () => Promise<void>;
  persistRequestStore: PersistRequestStore;
  captureActiveWorkspaceCookies: (workspaceId?: string) => Promise<void>;
  restoreWorkspaceCookieJar: (workspaceId?: string) => Promise<void>;
  scheduleActiveRequestPersist: () => void;
  scheduleWorkspacePersist: () => void;
  applySavedRequest: (request: SavedRequest) => void;
};

export const workspaceFeature = {
  defaultCollectionForWorkspace(this: WorkspaceHost, workspaceId = this.activeWorkspaceId) {
    return this.collections.find(collection => collection.workspaceId === workspaceId);
  },
  workspaceIdForCollection(this: WorkspaceHost, collectionId: string) {
    return this.collections.find(collection => collection.id === collectionId)?.workspaceId ?? this.activeWorkspaceId;
  },
  activeCollectionId(this: WorkspaceHost) {
    const current = this.requestsById.get(this.activeRequestId);
    if (current?.isDraft) return this.defaultCollectionForWorkspace()?.id || '';
    const collection = this.collections.find(candidate => candidate.id === current?.collectionId);
    if (this.topView === 'request' && collection?.workspaceId === this.activeWorkspaceId) return collection.id;
    return this.defaultCollectionForWorkspace()?.id || '';
  },
  collectionNameById(this: WorkspaceHost, id: string) {
    return this.collections.find(collection => collection.id === id)?.name ?? DEFAULT_COLLECTION;
  },
  workspaceRequestCountFor(this: WorkspaceHost, workspaceId: string) {
    const collectionIds = this.collections.filter(collection => collection.workspaceId === workspaceId).map(collection => collection.id);
    return this.requests.filter(request => collectionIds.includes(request.collectionId)).length;
  },
  workspaceCollectionCountFor(this: WorkspaceHost, workspaceId: string) {
    return this.collections.filter(collection => collection.workspaceId === workspaceId).length;
  },
  workspaceRequestCount(this: WorkspaceHost) {
    const collectionIds = this.collections.filter(collection => collection.workspaceId === this.activeWorkspaceId).map(collection => collection.id);
    return this.requests.filter(request => !request.isDraft && collectionIds.includes(request.collectionId)).length;
  },
  activeWorkspaceCollections(this: WorkspaceHost) {
    return this.collections.filter(collection => collection.workspaceId === this.activeWorkspaceId);
  },
  async switchWorkspace(this: WorkspaceHost, workspaceId: string) {
    if (!this.workspaces.some(workspace => workspace.id === workspaceId)) return;
    if (workspaceId === this.activeWorkspaceId) {
      this.workspaceMenuOpen = false;
      return;
    }
    const previousWorkspaceId = this.activeWorkspaceId;
    if (this.workspaceIsBlocked(workspaceId)) {
      await this.captureActiveWorkspaceCookies(previousWorkspaceId);
      this.activeWorkspaceId = workspaceId;
      if (!this.environments.some(environment => environment.id === this.activeEnvironmentId && environment.workspaceId === workspaceId)) this.activeEnvironmentId = '';
      this.workspaceMenuOpen = false;
      await this.restoreWorkspaceCookieJar(workspaceId);
      if (this.openGitTab) {
        this.openGitTab();
      } else {
        this.topView = 'git';
        void this.refreshGitStatus?.();
      }
      return;
    }
    await this.persistActiveRequestNow();
    await this.captureActiveWorkspaceCookies(previousWorkspaceId);
    this.activeWorkspaceId = workspaceId;
    if (!this.environments.some(environment => environment.id === this.activeEnvironmentId && environment.workspaceId === workspaceId)) this.activeEnvironmentId = '';
    this.topView = 'overview';
    this.workspaceMenuOpen = false;
    await this.restoreWorkspaceCookieJar(workspaceId);
    await this.persistRequestStore(this.requests, this.activeRequestId, this.openRequestIds, this.workspaces, this.collections, workspaceId);
  },
  async createWorkspace(this: WorkspaceHost) {
    if (!this.guardWorkspaceListWritable('Creating workspaces')) return;
    if (this.workspaces.length >= MAX_WORKSPACES) {
      await this.openAlertDialog('Workspace limit', `You can create up to ${MAX_WORKSPACES} workspaces in this storage. Delete an old workspace before creating another one.`);
      return;
    }
    const name = await this.openPromptDialog('New workspace', `Workspace ${this.workspaces.length + 1}`, 'Create a workspace for a separate set of collections.');
    if (!name) return;
    await this.persistActiveRequestNow();
    await this.captureActiveWorkspaceCookies();
    const workspace = makeWorkspace(name);
    const collection = makeCollection(workspace.id);
    this.workspaces = [...this.workspaces, workspace];
    this.collections = [...this.collections, collection];
    this.activeWorkspaceId = workspace.id;
    this.topView = 'overview';
    await this.restoreWorkspaceCookieJar(workspace.id);
    await this.persistRequestStore(this.requests, this.activeRequestId, this.openRequestIds, this.workspaces, this.collections, this.activeWorkspaceId);
  },
  updateWorkspaceDescription(this: WorkspaceHost, value: string) {
    if (!this.guardWorkspaceWritable('Workspace changes')) return;
    this.workspaces = this.workspaces.map(workspace => workspace.id === this.activeWorkspaceId ? { ...workspace, description: value } : workspace);
    this.scheduleWorkspacePersist();
  },
  async renameWorkspace(this: WorkspaceHost) {
    if (!this.guardWorkspaceWritable('Renaming workspaces')) return;
    if (!this.activeWorkspace) return;
    const name = await this.openPromptDialog('Rename workspace', this.activeWorkspace.name);
    if (!name) return;
    this.workspaces = this.workspaces.map(workspace => workspace.id === this.activeWorkspaceId ? { ...workspace, name } : workspace);
    await this.persistRequestStore();
  },
  async deleteWorkspace(this: WorkspaceHost, workspaceId: string) {
    if (!this.guardWorkspaceWritable('Deleting workspaces')) return;
    if (this.workspaces.length < 2) return;
    const workspace = this.workspaces.find(candidate => candidate.id === workspaceId);
    if (!workspace) return;
    const collectionIds = this.collections.filter(collection => collection.workspaceId === workspaceId).map(collection => collection.id);
    const requestCount = this.requests.filter(request => collectionIds.includes(request.collectionId)).length;
    const confirmed = await this.openConfirmDialog(
      'Delete workspace',
      `Delete "${workspace.name}" and all its ${collectionIds.length} collection${collectionIds.length === 1 ? '' : 's'} and ${requestCount} request${requestCount === 1 ? '' : 's'}? This cannot be undone.`,
      'Delete workspace'
    );
    if (!confirmed) return;
    await this.captureActiveWorkspaceCookies();
    const nextWorkspaces = this.workspaces.filter(candidate => candidate.id !== workspaceId);
    const nextCollections = this.collections.filter(collection => collection.workspaceId !== workspaceId);
    const nextEnvironments = this.environments.filter(environment => environment.workspaceId !== workspaceId);
    const removedIds = new Set(this.requests.filter(request => collectionIds.includes(request.collectionId)).map(request => request.id));
    const nextRequests = this.requests.filter(request => !removedIds.has(request.id));
    const nextOpenIds = this.openRequestIds.filter(id => !removedIds.has(id));
    const nextHistory = this.requestHistory.filter(entry => !collectionIds.includes(entry.request.collectionId));
    this.workspaces = nextWorkspaces;
    this.collections = nextCollections;
    this.environments = nextEnvironments;
    this.requests = nextRequests;
    this.openRequestIds = nextOpenIds;
    this.requestHistory = nextHistory;
    const nextWorkspaceCookies = { ...this.workspaceCookies };
    delete nextWorkspaceCookies[workspaceId];
    this.workspaceCookies = nextWorkspaceCookies;
    const switchTo = nextWorkspaces.find(candidate => candidate.id !== workspaceId) ?? nextWorkspaces[0];
    const nextActiveWorkspaceId = workspaceId === this.activeWorkspaceId && switchTo ? switchTo.id : this.activeWorkspaceId;
    this.activeWorkspaceId = nextActiveWorkspaceId;
    const nextActiveEnvironmentId = this.activeEnvironmentId && nextEnvironments.some(environment => environment.id === this.activeEnvironmentId && environment.workspaceId === nextActiveWorkspaceId)
      ? this.activeEnvironmentId
      : '';
    this.activeEnvironmentId = nextActiveEnvironmentId;
    await this.restoreWorkspaceCookieJar(nextActiveWorkspaceId);
    const nextActive = nextRequests.find(request => nextOpenIds.includes(request.id)) ?? nextRequests[0];
    if (nextActive) {
      this.openRequestIds = [...new Set([...nextOpenIds, nextActive.id])];
      this.applySavedRequest(nextActive);
      this.topView = 'request';
    } else {
      this.activeRequestId = '';
      this.topView = 'overview';
    }
    this.workspaceMenuOpen = false;
    await this.persistRequestStore(nextRequests, this.activeRequestId, this.openRequestIds, nextWorkspaces, nextCollections, nextActiveWorkspaceId, nextHistory, nextEnvironments, nextActiveEnvironmentId);
  },
};
