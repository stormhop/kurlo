import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceDiagnosticsFeature } from '../lib/stores/features/workspaceDiagnostics';
import { requestPersistenceFeature } from '../lib/stores/features/requestPersistence';
import type { WorkspaceDiagnostic } from '../lib/backend';

function diagnostic(overrides: Partial<WorkspaceDiagnostic> = {}): WorkspaceDiagnostic {
  return {
    scope: 'store', severity: 'error', blocking: true,
    path: 'workspaces/Main/collections/Core/collection.yml',
    message: 'This collection has the same id "collection-main" as workspaces/Main/collections/API/collection.yml, so the folder looks like a copy.',
    ...overrides,
  };
}

function hostWithDiagnostics(diagnostics: WorkspaceDiagnostic[]) {
  return Object.assign(Object.create(workspaceDiagnosticsFeature), {
    activeWorkspaceId: 'workspace-other',
    workspaceDiagnostics: diagnostics,
    externalWorkspaceChangePending: false,
    collectionImportToast: '', focusedWorkspaceDiagnosticKey: '',
    topView: 'git', openGitTab: vi.fn(),
    showExternalWorkspacePendingToast: vi.fn(),
    requestStorePayload: vi.fn(),
    requestsForStore: vi.fn(),
    requests: [], workspaces: [], collections: [], environments: [],
  });
}

afterEach(() => vi.useRealTimers());

describe('workspace structure diagnostics', () => {
  it('blocks all workspaces in the folder and resumes after repair', () => {
    vi.useFakeTimers();
    const host = hostWithDiagnostics([diagnostic()]);
    expect(host.workspaceBlocked).toBe(true);
    expect(host.workspaceIsBlocked('workspace-main')).toBe(true);
    expect(host.guardWorkspaceWritable('Editing')).toBe(false);
    expect(host.guardWorkspaceListWritable('Creating')).toBe(false);
    expect(host.guardGitWorkspaceMutable('Commit')).toBe(false);
    expect(host.workspaceDiagnosticTitle(host.workspaceDiagnostics[0])).toBe('Workspace files');
    host.workspaceDiagnostics = [];
    expect(host.workspaceBlocked).toBe(false);
    expect(host.guardWorkspaceWritable('Editing')).toBe(true);
  });

  it('rejects autosave before building a payload for a different active workspace', async () => {
    vi.useFakeTimers();
    const host = hostWithDiagnostics([diagnostic()]);
    expect(await requestPersistenceFeature.persistRequestStore.call(host)).toBe(false);
    expect(host.requestStorePayload).not.toHaveBeenCalled();
    expect(host.requestsForStore).not.toHaveBeenCalled();
  });

  it('shows a recovery entry for a copied workspace next to the original', () => {
    const host = hostWithDiagnostics([
      diagnostic({ path: 'workspaces/Copy/workspace.yml', message: 'This workspace has the same id "workspace-main" as workspaces/Main/workspace.yml, so the folder looks like a copy.' }),
    ]);
    const entries = host.invalidWorkspacesFromDiagnostics([{ id: 'workspace-main', name: 'Main' }]);
    expect(entries.map((entry: { name: string }) => entry.name)).toEqual(['Copy']);
    expect(entries[0].id).not.toBe('workspace-main');
    expect(entries[0].isInvalid).toBe(true);
  });

  it('names the workspace a broken file locks when another workspace is open', () => {
    const broken = diagnostic({
      scope: 'workspace', path: 'workspaces/My-Workspace/workspace.yml',
      workspaceId: 'invalid-workspace-my-workspace', message: "line 5: could not find expected ':'",
    });
    const host = hostWithDiagnostics([broken]);
    host.workspaces = [{ id: 'invalid-workspace-my-workspace', name: 'My Workspace' }];
    expect(host.workspaceBlocked).toBe(false);
    expect(host.workspaceDiagnosticScopeLabel(broken)).toBe('Workspace “My Workspace” stays locked until this is fixed');
    host.activeWorkspaceId = 'invalid-workspace-my-workspace';
    expect(host.workspaceDiagnosticScopeLabel(broken)).toBe('');
    expect(host.workspaceDiagnosticScopeLabel(diagnostic())).toBe('');
  });

  it('keeps existing syntax errors scoped to their affected workspace', () => {
    const host = hostWithDiagnostics([diagnostic({ scope: 'workspace', workspaceId: 'workspace-main' })]);
    expect(host.workspaceBlocked).toBe(false);
    expect(host.workspaceIsBlocked('workspace-main')).toBe(true);
  });
});
