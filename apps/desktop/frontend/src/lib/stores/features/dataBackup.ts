import { openFileDialog, readTextFile, saveRequestStore } from '../../backend';
import type { ProxyConfig, RequestSettings, RequestStore, SavedRequest } from '../../types/models';
import { normalizeThemeSettings, type AppTheme, type AppThemeMode } from '../../theme';
import { normalizeProxyConfig, proxyConfigForPersistence } from '../../proxy';
import { downloadTextFile } from '../../utils';

export type KurloBackupPreferences = {
  autosave?: boolean;
  appTheme?: AppTheme | AppThemeMode;
  shortcuts?: Record<string, string>;
  requestSettings?: Partial<RequestSettings>;
  proxyConfig?: ProxyConfig;
};
export type KurloBackupPayload = {
  kind: 'kurlo.backup';
  version: 1;
  exportedAt: string;
  store: RequestStore;
  preferences: KurloBackupPreferences;
};

type DataBackupHost = {
  dataTransferStatus: string;
  dataTransferStatusTimer: ReturnType<typeof setTimeout> | null;
  collectionImportToast: string;
  autosave: boolean;
  appTheme: AppTheme;
  shortcutOverrides: Record<string, string>;
  proxyConfig: ProxyConfig;
  requests: SavedRequest[];
  requestsById: Map<string, SavedRequest>;
  activeRequestId: string;
  openRequestIds: string[];
  dirtyRequestIds: Set<string>;
  savedRequestSnapshots: Map<string, SavedRequest>;
  unsavedRequestSnapshots: Map<string, SavedRequest>;
  requestStoreLoaded: boolean;
  currentRequestSettings: () => RequestSettings;
  setTheme: (settings: AppTheme) => void;
  saveShortcutSettings: () => void;
  applyRequestSettings: (settings: Partial<RequestSettings>) => void;
  saveRequestSettings: () => void;
  applySavedRequest: (req: SavedRequest) => void;
  setProxyConfig: (config: ProxyConfig) => void;
  setAutosave: (value: boolean) => void;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  closeFloatingMenus: () => void;
  hasUnsavedRequestChanges: () => boolean;
  openConfirmDialog: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
  openAlertDialog: (title: string, message: string) => Promise<void>;
  persistActiveRequestNow: (forceDisk?: boolean) => Promise<void>;
  requestsForStore: (nextRequests: SavedRequest[]) => SavedRequest[];
  requestStorePayload: (nextRequests?: SavedRequest[], activeId?: string, nextOpenIds?: string[]) => RequestStore;
  saveTextFile: (name: string, content: string) => Promise<boolean>;
  syncDirtyRequestIds: (next: Set<string>) => void;
  loadRequestWorkspace: () => Promise<void>;
  showDataTransferStatus: (message: string, timeout?: number) => void;
  kurloBackupPayload: (store: RequestStore) => KurloBackupPayload;
  requestStoreLooksImportable: (value: Record<string, unknown>) => boolean;
  parseAllDataBackup: (text: string) => { store: Partial<RequestStore>; preferences: unknown };
  applyImportedPreferences: (preferences: unknown) => void;
  importAllDataPayload: (text: string) => Promise<void>;
};

export const dataBackupFeature = {
  showDataTransferStatus(this: DataBackupHost, message: string, timeout = 3200) {
    this.dataTransferStatus = message;
    this.collectionImportToast = message;
    if (this.dataTransferStatusTimer) clearTimeout(this.dataTransferStatusTimer);
    this.dataTransferStatusTimer = setTimeout(() => {
      this.dataTransferStatus = '';
      if (this.collectionImportToast === message) this.collectionImportToast = '';
      this.dataTransferStatusTimer = null;
    }, timeout);
  },
  kurloBackupPayload(this: DataBackupHost, store: RequestStore): KurloBackupPayload {
    return {
      kind: 'kurlo.backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      store,
      preferences: {
        autosave: this.autosave,
        appTheme: this.appTheme,
        shortcuts: { ...this.shortcutOverrides },
        requestSettings: this.currentRequestSettings(),
        proxyConfig: proxyConfigForPersistence(this.proxyConfig),
      },
    };
  },
  requestStoreLooksImportable(this: DataBackupHost, value: Record<string, unknown>) {
    return ['requests', 'collections', 'workspaces', 'environments', 'history']
      .some(key => Array.isArray(value[key]))
      || this.isRecord(value.workspaceCookies);
  },
  parseAllDataBackup(this: DataBackupHost, text: string): { store: Partial<RequestStore>; preferences: unknown } {
    const parsed = JSON.parse(text) as unknown;
    if (!this.isRecord(parsed)) throw new Error('Expected a Kurlo backup JSON file');

    if (this.isRecord(parsed.store) && this.requestStoreLooksImportable(parsed.store)) {
      return { store: parsed.store as Partial<RequestStore>, preferences: parsed.preferences };
    }
    if (this.requestStoreLooksImportable(parsed)) {
      return { store: parsed as Partial<RequestStore>, preferences: null };
    }
    throw new Error('The selected file does not contain Kurlo request data');
  },
  applyImportedPreferences(this: DataBackupHost, preferences: unknown) {
    if (!this.isRecord(preferences)) return;

    if (preferences.appTheme) {
      this.setTheme(normalizeThemeSettings(preferences.appTheme));
    }
    if (this.isRecord(preferences.shortcuts)) {
      const shortcuts: Record<string, string> = {};
      for (const [id, combo] of Object.entries(preferences.shortcuts)) {
        if (typeof combo === 'string') shortcuts[id] = combo;
      }
      this.shortcutOverrides = shortcuts;
      this.saveShortcutSettings();
    }
    if (this.isRecord(preferences.requestSettings)) {
      const activeRequest = this.requestsById.get(this.activeRequestId);
      this.applyRequestSettings(preferences.requestSettings as Partial<RequestSettings>);
      this.saveRequestSettings();
      if (activeRequest) this.applySavedRequest(activeRequest);
    }
    if (this.isRecord(preferences.proxyConfig)) {
      this.setProxyConfig(normalizeProxyConfig(preferences.proxyConfig));
    }
    if (typeof preferences.autosave === 'boolean') {
      this.setAutosave(preferences.autosave);
    }
  },
  async exportAllData(this: DataBackupHost) {
    this.closeFloatingMenus();

    const unsavedCount = this.hasUnsavedRequestChanges() ? this.dirtyRequestIds.size : 0;
    const warning = 'The backup file contains secrets — auth tokens, OAuth credentials, AWS keys, and any environment values marked as secret. Treat it like a password file: keep it private and do not commit it to a public repo.';
    const manualNote = unsavedCount > 0
      ? ` You have ${unsavedCount} unsaved change${unsavedCount === 1 ? '' : 's'} in manual-save mode; only the last saved version of each request will be included.`
      : '';
    const confirmed = await this.openConfirmDialog('Export all data', warning + manualNote, 'Export');
    if (!confirmed) return;

    await this.persistActiveRequestNow();
    const storeRequests = this.requestsForStore(this.requests);
    const store = this.requestStorePayload(storeRequests, this.activeRequestId, this.openRequestIds);
    const payload = this.kurloBackupPayload(store);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const name = `kurlo-backup-${stamp}.json`;
    const content = JSON.stringify(payload, null, 2);
    try {
      if (!(await this.saveTextFile(name, content))) return;
      this.showDataTransferStatus('Exported all data');
    } catch {
      downloadTextFile(name, content);
      this.showDataTransferStatus('Exported all data');
    }
  },
  async importAllDataPayload(this: DataBackupHost, text: string) {
    const parsed = this.parseAllDataBackup(text);
    const store = { ...parsed.store, version: Number(parsed.store.version) || 2 };
    const saved = await saveRequestStore(JSON.stringify(store, null, 2));
    if (!saved.ok) throw new Error(saved.error || 'Could not write imported data');
    this.syncDirtyRequestIds(new Set());
    this.savedRequestSnapshots = new Map();
    this.unsavedRequestSnapshots = new Map();
    this.requestStoreLoaded = false;
    await this.loadRequestWorkspace();
    this.applyImportedPreferences(parsed.preferences);
  },
  async importAllData(this: DataBackupHost) {
    this.closeFloatingMenus();
    const path = await openFileDialog('Import Kurlo data backup');
    if (!path) return;
    const confirmed = await this.openConfirmDialog('Import all data', 'This will replace workspaces, collections, requests, environments, history, and cookies in this app.', 'Import');
    if (!confirmed) return;
    try {
      const text = await readTextFile(path);
      await this.importAllDataPayload(text);
      this.showDataTransferStatus('Imported all data');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.showDataTransferStatus(`Import failed: ${detail}`, 5000);
      await this.openAlertDialog('Import failed', detail);
    }
  },
};
