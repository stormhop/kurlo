import { readWorkspaceYAMLFile, writeWorkspaceYAMLFile } from '../../backend';
import type { WorkspaceDiagnostic, WorkspaceOpenResult } from '../../backend';
import { filesystemNameFromName } from '../../normalizers';
import type { Workspace } from '../../types/models';
import type { TopView } from '../ui';

type WorkspaceDiagnosticsHost = {
  activeWorkspaceId: string;
  collectionImportToast: string;
  externalWorkspaceChangePending: boolean;
  externalWorkspaceChangeReason: string;
  focusedWorkspaceDiagnosticKey: string;
  gitAction: string;
  gitError: string;
  gitLoading: boolean;
  requestStoreLoaded: boolean;
  topView: TopView;
  workspaces: Workspace[];
  workspaceBlocked: boolean;
  workspaceBlockingDiagnostics: WorkspaceDiagnostic[];
  workspaceDiagnostics: WorkspaceDiagnostic[];
  workspaceGlobalBlockingDiagnostics: WorkspaceDiagnostic[];
  yamlEditorContent: string;
  yamlEditorDiagnostic: WorkspaceDiagnostic | null;
  yamlEditorError: string;
  yamlEditorLoading: boolean;
  yamlEditorOpen: boolean;
  yamlEditorPath: string;
  yamlEditorSaving: boolean;
  applyWorkspaceOpenResult: (result: WorkspaceOpenResult, successMessage: string) => Promise<boolean>;
  cancelPersistTimersOnly: () => void;
  clearExternalWorkspaceChangePending: () => void;
  closeWorkspaceYAMLEditor: () => void;
  externalWorkspacePendingMessage: (action?: string) => string;
  hasUnsavedDrafts: () => boolean;
  hasUnsavedRequestChanges: () => boolean;
  handleExternalWorkspaceChange: (reason: string) => Promise<void>;
  loadRequestWorkspace: (rawOverride?: string, diagnosticsOverride?: WorkspaceDiagnostic[]) => Promise<void>;
  markExternalWorkspaceChangePending: (reason: string) => void;
  openGitTab: (refresh?: boolean) => void;
  refreshPendingExternalWorkspaceChangeIfClean: () => Promise<boolean>;
  reloadWorkspaceAfterExternalChange: (reason: string) => Promise<void>;
  showExternalWorkspacePendingToast: (action?: string) => void;
  showWorkspaceBlockedToast: (action?: string, workspaceId?: string) => void;
  workspaceBlockingDiagnosticsFor: (workspaceId: string) => WorkspaceDiagnostic[];
  workspaceBlockSummary: () => string;
  workspaceDiagnosticIsGlobal: (diagnostic: WorkspaceDiagnostic) => boolean;
  workspaceDiagnosticKey: (diagnostic: WorkspaceDiagnostic) => string;
  workspaceDiagnosticLocation: (diagnostic: WorkspaceDiagnostic) => string;
  workspaceDiagnosticSummary: (diagnostic: WorkspaceDiagnostic) => string;
  workspaceDiagnosticTargetsWorkspace: (diagnostic: WorkspaceDiagnostic, workspaceId: string) => boolean;
  workspaceDiagnosticTitle: (diagnostic: WorkspaceDiagnostic) => string;
};

function workspacePathSegment(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const index = parts.lastIndexOf('workspaces');
  return index >= 0 ? parts[index + 1] ?? '' : '';
}

function invalidWorkspaceIdForDiagnostic(diagnostic: WorkspaceDiagnostic): string {
  if (diagnostic.workspaceId) return diagnostic.workspaceId;
  const segment = workspacePathSegment(diagnostic.path);
  return segment ? `invalid-workspace-${filesystemNameFromName(segment, 'workspace')}` : '';
}

function invalidWorkspaceNameForDiagnostic(diagnostic: WorkspaceDiagnostic): string {
  const segment = workspacePathSegment(diagnostic.path);
  return segment ? segment.replace(/[-_]+/g, ' ') : 'Invalid workspace';
}

export const workspaceDiagnosticsFeature = {
  get workspaceBlocked(): boolean {
    const host = this as unknown as WorkspaceDiagnosticsHost;
    return host.workspaceBlockingDiagnostics.length > 0;
  },

  get workspaceGlobalBlockingDiagnostics(): WorkspaceDiagnostic[] {
    const host = this as unknown as WorkspaceDiagnosticsHost;
    return host.workspaceDiagnostics.filter(diagnostic => Boolean(diagnostic.blocking) && host.workspaceDiagnosticIsGlobal(diagnostic));
  },

  get workspaceBlockingDiagnostics(): WorkspaceDiagnostic[] {
    const host = this as unknown as WorkspaceDiagnosticsHost;
    return host.workspaceBlockingDiagnosticsFor(host.activeWorkspaceId);
  },

  workspaceDiagnosticScopeLabel(this: WorkspaceDiagnosticsHost, diagnostic: WorkspaceDiagnostic): string {
    if (this.workspaceDiagnosticIsGlobal(diagnostic) || this.workspaceDiagnosticTargetsWorkspace(diagnostic, this.activeWorkspaceId)) return '';
    const id = invalidWorkspaceIdForDiagnostic(diagnostic);
    const name = this.workspaces.find(workspace => workspace.id === id)?.name || invalidWorkspaceNameForDiagnostic(diagnostic);
    return diagnostic.blocking ? `Workspace “${name}” stays locked until this is fixed` : `In workspace “${name}”`;
  },

  workspaceDiagnosticKey(this: WorkspaceDiagnosticsHost, diagnostic: WorkspaceDiagnostic): string {
    return `${diagnostic.scope}:${diagnostic.path}:${diagnostic.line ?? 0}:${diagnostic.collectionId ?? ''}:${diagnostic.requestId ?? ''}:${diagnostic.message}`;
  },

  workspaceDiagnosticLocation(this: WorkspaceDiagnosticsHost, diagnostic: WorkspaceDiagnostic): string {
    const line = diagnostic.line ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ''}` : '';
    return `${diagnostic.path}${line}`;
  },

  workspaceDiagnosticTitle(this: WorkspaceDiagnosticsHost, diagnostic: WorkspaceDiagnostic): string {
    if (diagnostic.scope === 'store') return 'Workspace files';
    if (diagnostic.scope === 'workspace') return diagnostic.blocking ? 'Workspace blocked' : 'Workspace YAML';
    if (diagnostic.scope === 'collection') return 'Collection YAML';
    if (diagnostic.scope === 'request') return 'Request YAML';
    return 'Environment YAML';
  },

  workspaceDiagnosticSummary(this: WorkspaceDiagnosticsHost, diagnostic: WorkspaceDiagnostic): string {
    return `${this.workspaceDiagnosticTitle(diagnostic)}: ${this.workspaceDiagnosticLocation(diagnostic)} — ${diagnostic.message}`;
  },

  workspaceDiagnosticIsGlobal(this: WorkspaceDiagnosticsHost, diagnostic: WorkspaceDiagnostic): boolean {
    return diagnostic.scope === 'store' || (!diagnostic.workspaceId && !workspacePathSegment(diagnostic.path));
  },

  workspaceDiagnosticTargetsWorkspace(this: WorkspaceDiagnosticsHost, diagnostic: WorkspaceDiagnostic, workspaceId: string): boolean {
    if (!workspaceId) return false;
    return invalidWorkspaceIdForDiagnostic(diagnostic) === workspaceId;
  },

  workspaceBlockingDiagnosticsFor(this: WorkspaceDiagnosticsHost, workspaceId: string): WorkspaceDiagnostic[] {
    return this.workspaceDiagnostics.filter(diagnostic =>
      Boolean(diagnostic.blocking) && (this.workspaceDiagnosticIsGlobal(diagnostic) || this.workspaceDiagnosticTargetsWorkspace(diagnostic, workspaceId))
    );
  },

  workspaceIsBlocked(this: WorkspaceDiagnosticsHost, workspaceId: string): boolean {
    return this.workspaceBlockingDiagnosticsFor(workspaceId).length > 0;
  },

  guardWorkspaceListWritable(this: WorkspaceDiagnosticsHost, action = 'Workspace management') {
    if (!this.workspaceGlobalBlockingDiagnostics.length) return true;
    this.showWorkspaceBlockedToast(action);
    return false;
  },

  workspaceBlockSummary(this: WorkspaceDiagnosticsHost): string {
    const diagnostic = this.workspaceBlockingDiagnostics[0] ?? this.workspaceDiagnostics[0];
    if (!diagnostic) return 'Workspace files or references are invalid.';
    return this.workspaceDiagnosticSummary(diagnostic);
  },

  showWorkspaceBlockedToast(this: WorkspaceDiagnosticsHost, action = 'Workspace editing', workspaceId = this.activeWorkspaceId) {
    const diagnostics = this.workspaceBlockingDiagnosticsFor(workspaceId);
    const count = diagnostics.length || this.workspaceDiagnostics.length;
    this.collectionImportToast = `${action} is paused until ${count} blocking workspace issue${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} fixed.`;
    const diagnostic = diagnostics[0] ?? this.workspaceDiagnostics[0];
    if (diagnostic) this.focusedWorkspaceDiagnosticKey = this.workspaceDiagnosticKey(diagnostic);
    if (this.topView !== 'git') this.openGitTab(false);
    setTimeout(() => (this.collectionImportToast = ''), 5200);
  },

  guardWorkspaceWritable(this: WorkspaceDiagnosticsHost, action = 'Workspace editing') {
    if (this.externalWorkspaceChangePending) {
      void this.refreshPendingExternalWorkspaceChangeIfClean();
      this.showExternalWorkspacePendingToast(action);
      return false;
    }
    if (!this.workspaceBlocked) return true;
    this.showWorkspaceBlockedToast(action);
    return false;
  },

  guardGitWorkspaceMutable(this: WorkspaceDiagnosticsHost, action = 'Git action') {
    if (this.externalWorkspaceChangePending) {
      void this.refreshPendingExternalWorkspaceChangeIfClean();
      this.gitError = this.externalWorkspacePendingMessage(action);
      this.showExternalWorkspacePendingToast(action);
      return false;
    }
    if (!this.workspaceBlocked) return true;
    this.gitError = `${action} is paused because workspace files or references are invalid. ${this.workspaceBlockSummary()}`;
    this.showWorkspaceBlockedToast(action);
    return false;
  },

  diagnosticsForCollection(this: WorkspaceDiagnosticsHost, collectionId: string): WorkspaceDiagnostic[] {
    return this.workspaceDiagnostics.filter(diagnostic => diagnostic.collectionId === collectionId || (diagnostic.scope === 'collection' && diagnostic.path.includes(collectionId)));
  },

  diagnosticsForRequest(this: WorkspaceDiagnosticsHost, requestId: string): WorkspaceDiagnostic[] {
    return this.workspaceDiagnostics.filter(diagnostic => diagnostic.requestId === requestId);
  },

  openWorkspaceDiagnostic(this: WorkspaceDiagnosticsHost, diagnostics: WorkspaceDiagnostic[] = []) {
    if (!diagnostics.length) return;
    this.focusedWorkspaceDiagnosticKey = this.workspaceDiagnosticKey(diagnostics[0]);
    this.openGitTab();
    this.collectionImportToast = this.workspaceDiagnosticSummary(diagnostics[0]);
    setTimeout(() => {
      if (this.collectionImportToast === this.workspaceDiagnosticSummary(diagnostics[0])) this.collectionImportToast = '';
    }, 5200);
  },

  async openWorkspaceYAMLEditor(this: WorkspaceDiagnosticsHost, diagnostic: WorkspaceDiagnostic) {
    this.focusedWorkspaceDiagnosticKey = this.workspaceDiagnosticKey(diagnostic);
    this.yamlEditorOpen = true;
    this.yamlEditorDiagnostic = diagnostic;
    this.yamlEditorPath = diagnostic.path;
    this.yamlEditorContent = '';
    this.yamlEditorError = '';
    this.yamlEditorLoading = true;
    try {
      const result = await readWorkspaceYAMLFile(diagnostic.path);
      if (!result.ok) {
        this.yamlEditorError = result.error || 'Could not read YAML file.';
        return;
      }
      this.yamlEditorPath = result.path || diagnostic.path;
      this.yamlEditorContent = result.content ?? '';
    } catch (error) {
      this.yamlEditorError = error instanceof Error ? error.message : String(error);
    } finally {
      this.yamlEditorLoading = false;
    }
  },

  closeWorkspaceYAMLEditor(this: WorkspaceDiagnosticsHost) {
    if (this.yamlEditorSaving) return;
    this.yamlEditorOpen = false;
    this.yamlEditorDiagnostic = null;
    this.yamlEditorPath = '';
    this.yamlEditorContent = '';
    this.yamlEditorError = '';
    this.yamlEditorLoading = false;
  },

  async saveWorkspaceYAMLEditor(this: WorkspaceDiagnosticsHost) {
    if (!this.yamlEditorOpen || !this.yamlEditorPath || this.yamlEditorSaving) return;
    this.yamlEditorSaving = true;
    this.yamlEditorError = '';
    try {
      const result = await writeWorkspaceYAMLFile(this.yamlEditorPath, this.yamlEditorContent);
      await this.applyWorkspaceOpenResult(result, 'Saved YAML');
      const ownError = this.workspaceDiagnostics.find(
        diagnostic => diagnostic.path === this.yamlEditorPath,
      );
      if (ownError) {
        this.yamlEditorDiagnostic = ownError;
        this.focusedWorkspaceDiagnosticKey = this.workspaceDiagnosticKey(ownError);
        this.yamlEditorError = this.workspaceDiagnosticSummary(ownError);
        this.collectionImportToast = '';
        return;
      }
      this.yamlEditorSaving = false;
      this.closeWorkspaceYAMLEditor();
      const remaining = this.workspaceDiagnostics.length;
      this.collectionImportToast = remaining
        ? `Saved. ${remaining} workspace ${remaining === 1 ? 'file still needs' : 'files still need'} fixing.`
        : 'Saved. The workspace loads cleanly again.';
      setTimeout(() => (this.collectionImportToast = ''), 3600);
    } catch (error) {
      this.yamlEditorError = error instanceof Error ? error.message : String(error);
    } finally {
      this.yamlEditorSaving = false;
    }
  },

  invalidWorkspacesFromDiagnostics(this: WorkspaceDiagnosticsHost, existingWorkspaces: Workspace[], diagnostics = this.workspaceDiagnostics): Workspace[] {
    const existingIds = new Set(existingWorkspaces.map(workspace => workspace.id));
    const invalidWorkspaces: Workspace[] = [];
    for (const diagnostic of diagnostics) {
      const workspaceFile = diagnostic.scope === 'store' && diagnostic.path.endsWith('/workspace.yml');
      if (!diagnostic.blocking || (!workspaceFile && (diagnostic.scope !== 'workspace' || this.workspaceDiagnosticIsGlobal(diagnostic)))) continue;
      const id = invalidWorkspaceIdForDiagnostic(diagnostic);
      if (!id || existingIds.has(id)) continue;
      existingIds.add(id);
      invalidWorkspaces.push({
        id,
        name: invalidWorkspaceNameForDiagnostic(diagnostic),
        filesystemName: filesystemNameFromName(workspacePathSegment(diagnostic.path) || id, id),
        description: '',
        workspaceDiagnostics: [diagnostic],
        isInvalid: true,
      });
    }
    return invalidWorkspaces;
  },

  initWorkspaceListeners(this: WorkspaceDiagnosticsHost) {
    const runtime = window.runtime;
    if (!runtime?.EventsOn) return;
    let pending: ReturnType<typeof setTimeout> | null = null;
    runtime.EventsOn('kurlo:workspace-changed', (reason: string) => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        void this.handleExternalWorkspaceChange(typeof reason === 'string' ? reason : '');
      }, 250);
    });
  },

  externalWorkspacePendingMessage(this: WorkspaceDiagnosticsHost, action = 'Workspace editing') {
    const friendly = this.externalWorkspaceChangeReason ? ` (${this.externalWorkspaceChangeReason})` : '';
    return `${action} is paused because workspace changed on disk${friendly}. Discard local unsaved edits to refresh before writing again.`;
  },

  showExternalWorkspacePendingToast(this: WorkspaceDiagnosticsHost, action = 'Workspace editing') {
    this.collectionImportToast = this.externalWorkspacePendingMessage(action);
  },

  markExternalWorkspaceChangePending(this: WorkspaceDiagnosticsHost, reason: string) {
    this.externalWorkspaceChangePending = true;
    this.externalWorkspaceChangeReason = reason.trim();
    this.cancelPersistTimersOnly();
    this.showExternalWorkspacePendingToast('Workspace editing');
  },

  clearExternalWorkspaceChangePending(this: WorkspaceDiagnosticsHost) {
    this.externalWorkspaceChangePending = false;
    this.externalWorkspaceChangeReason = '';
  },

  async refreshPendingExternalWorkspaceChangeIfClean(this: WorkspaceDiagnosticsHost) {
    if (!this.externalWorkspaceChangePending) return false;
    if (this.gitLoading || this.gitAction) return false;
    if (this.hasUnsavedDrafts() || this.hasUnsavedRequestChanges()) return false;
    const reason = this.externalWorkspaceChangeReason;
    this.clearExternalWorkspaceChangePending();
    await this.reloadWorkspaceAfterExternalChange(reason);
    return true;
  },

  async reloadWorkspaceAfterExternalChange(this: WorkspaceDiagnosticsHost, reason: string) {
    this.requestStoreLoaded = false;
    await this.loadRequestWorkspace();
    const friendly = reason ? ` (${reason})` : '';
    if (this.workspaceDiagnostics.length) {
      this.collectionImportToast = `Workspace refreshed${friendly}; ${this.workspaceDiagnostics.length} YAML error${this.workspaceDiagnostics.length === 1 ? '' : 's'} found.`;
      setTimeout(() => (this.collectionImportToast = ''), 6000);
    } else {
      this.collectionImportToast = `Workspace refreshed${friendly}.`;
      setTimeout(() => (this.collectionImportToast = ''), 2500);
    }
  },

  async handleExternalWorkspaceChange(this: WorkspaceDiagnosticsHost, reason: string) {
    if (this.gitLoading || this.gitAction) return;
    if (this.hasUnsavedDrafts() || this.hasUnsavedRequestChanges()) {
      this.markExternalWorkspaceChangePending(reason);
      return;
    }
    this.clearExternalWorkspaceChangePending();
    await this.reloadWorkspaceAfterExternalChange(reason);
  },
};
