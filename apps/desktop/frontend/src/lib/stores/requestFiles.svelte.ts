import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { getRequestFileYAML, saveRequestFileYAML } from '../backend';
import { resolveFormRequestTab, saveRequestSectionPreference } from '../requestTabPreferences';
import { readRequestFileBar } from '../requestFileBar';
import { normalizeRequestType } from '../normalizers';
import { RequestFileDraft } from '../requestFileDraft.svelte';
import { requestDiffersFromSavedSnapshot } from '../manualSave';
import { noteSavedWorkspacePaths } from './features/git';
import { rememberSavedRequestFile } from './features/requestPersistence';
import type { vm } from './app.svelte';
import type { RequestTab, SavedRequest } from '../types/models';

export type RequestSection = RequestTab | 'file';

export class RequestFiles {
  root = $state('');
  entries = new SvelteMap<string, RequestFileDraft>();
  private selection = 0;
  pendingWrite: Promise<unknown> | null = null;

  constructor(private host: typeof vm) {}

  get active(): RequestFileDraft | undefined {
    return this.entries.get(this.host.activeRequestId);
  }

  get dirtyIds(): string[] {
    return [...this.entries].filter(([, draft]) => draft.dirty || draft.saving).map(([id]) => id);
  }

  setRoot(root?: string) {
    if (!root || root === this.root) return;
    this.entries.clear();
    this.root = root;
  }

  private pathHint(id: string) {
    const request = this.host.requestsById.get(id);
    const collection = this.host.collections.find(item => item.id === request?.collectionId);
    const workspace = this.host.workspaces.find(item => item.id === collection?.workspaceId);
    if (!workspace?.filesystemName || !collection?.filesystemName || !request?.filesystemName) return '';
    return `workspaces/${workspace.filesystemName}/collections/${collection.filesystemName}/requests/${request.filesystemName}.yml`;
  }

  async select(section: RequestSection) {
    const host = this.host;
    const id = host.activeRequestId;
    const root = this.root;
    const selection = ++this.selection;
    if (section !== 'file') {
      if (this.active && !await this.review([id])) return;
      if (selection !== this.selection || host.activeRequestId !== id || this.root !== root) return;
      this.entries.delete(id);
      host.requestTab = resolveFormRequestTab(host.requestType, host.method, section);
      this.rememberSection(id, host.requestTab);
      return;
    }
    if (!id || this.active) return;
    await host.persistActiveRequestNow();
    if (selection !== this.selection || id !== host.activeRequestId || root !== this.root) return;
    if (host.dirtyRequestIds.has(id)) {
      const request = host.requestForEditing(id);
      const choice = await host.openSaveChangesDialog(request?.name || 'this request');
      if (choice === 'cancel') return;
      if (choice === 'save' && !await host.saveRequestById(id)) return;
      if (choice === 'discard' && !await host.discardRequestChanges(id)) return;
    }
    if (selection !== this.selection || id !== host.activeRequestId || root !== this.root) return;
    let generation = 0;
    const draft: RequestFileDraft = new RequestFileDraft(
      async () => {
        const current = ++generation;
        await host.requestStorePersistQueue;
        const result = await getRequestFileYAML(root, id, this.pathHint(id) || draft.path);
        if (current === generation && result.ok && result.requestJson && root === this.root && this.entries.get(id) === draft && !this.pendingWrite) {
          this.applyDiskRequest(id, result.requestJson);
        }
        return result;
      },
      (content, revision) => {
        generation++;
        return this.write(root, id, content, revision);
      },
      () => host.keepRequestTab(id),
    );
    this.entries.set(id, draft);
    this.rememberSection(id, 'file');
  }

  private rememberSection(id: string, section: RequestSection) {
    const request = this.host.requestsById.get(id);
    const collection = this.host.collections.find(item => item.id === request?.collectionId);
    const workspaceId = collection?.workspaceId ?? this.host.activeWorkspaceId;
    saveRequestSectionPreference(this.root, workspaceId, id, section);
  }

  private applyDiskRequest(id: string, json: string, written = false) {
    const host = this.host;
    const current = host.requestsById.get(id);
    if (!current || host.dirtyRequestIds.has(id)) return;
    const updated = host.normalizeSavedRequestCtx(JSON.parse(json));
    if (updated.id !== id) return;
    const changed = requestDiffersFromSavedSnapshot(updated, current);
    if (changed) {
      host.requests = host.requests.map(request => request.id === id ? updated : request);
      host.savedRequestSnapshots.set(id, host.savedRequestSnapshot(updated));
      if (host.activeRequestId === id) host.applySavedRequest(updated);
    }
    if (written || changed) rememberSavedRequestFile(host, updated);
  }

  private async write(root: string, id: string, content: string, revision: string) {
    const host = this.host;
    const previous = this.pendingWrite;
    const queued = host.requestStorePersistQueue;
    const write = (async () => {
      await previous?.catch(() => {});
      await queued;
      if (this.root !== root || !this.entries.has(id) || !host.requestStoreLoaded || host.workspaceBlocked || host.gitAction) {
        return { ok: false, error: 'The workspace changed. Reopen the request file before saving.' };
      }
      if (host.dirtyRequestIds.has(id)) return { ok: false, error: 'Save or discard the request form changes before saving YAML.' };
      if (host.requestIsRunning(id)) {
        const bar = readRequestFileBar(content);
        if (bar.ok && normalizeRequestType(bar.values) !== host.requestsById.get(id)?.requestType) {
          return { ok: false, error: 'Stop the running request before saving a protocol change.' };
        }
      }
      const result = await saveRequestFileYAML(root, id, content, revision, this.entries.get(id)?.path || this.pathHint(id));
      if (!result.ok || root !== this.root) return result;
      if (result.requestJson) this.applyDiskRequest(id, result.requestJson, true);
      if (result.revision !== revision) {
        noteSavedWorkspacePaths(host, [result.path]);
        host.scheduleGitStatusRefreshAfterPersist();
      }
      return result;
    })();
    this.pendingWrite = write;
    try {
      return await write;
    } finally {
      if (this.pendingWrite === write) this.pendingWrite = null;
    }
  }

  async review(ids: string[] = this.dirtyIds): Promise<boolean> {
    for (const id of ids) {
      const draft = this.entries.get(id);
      if (!draft) continue;
      if (draft.saving) await draft.save();
      if (!draft.dirty) continue;
      const choice = await this.host.openSaveChangesDialog(draft.path || this.host.requestsById.get(id)?.name || 'request YAML');
      if (choice === 'cancel') return false;
      if (choice === 'save') {
        if (!await draft.save() || draft.dirty) {
          if (this.host.requestsById.has(id)) await this.host.switchRequest(id);
          return false;
        }
      } else {
        this.entries.delete(id);
      }
    }
    return true;
  }

  async afterWrites(requests: SavedRequest[]) {
    const affected = new SvelteSet<string>();
    while (this.pendingWrite) {
      for (const [id, draft] of this.entries) {
        if (draft.saving) affected.add(id);
      }
      await this.pendingWrite.catch(() => {});
    }
    return requests.map(request => affected.has(request.id) ? this.host.requestsById.get(request.id) ?? request : request);
  }
}
