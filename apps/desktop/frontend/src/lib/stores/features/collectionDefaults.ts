import {
  applyCollectionDefaultsToRequest,
  collectionDefaultsHaveContent,
  folderDefaultsChain,
  inheritedAuth,
  inheritedAuthSource,
  inheritedHeaderRows,
  REQUEST_SETTING_KEYS,
} from '../../collectionDefaults';
import { DEFAULT_REQUEST_SETTINGS } from '../../constants';
import type { AuthState, AuthType, Collection, KVRow, RequestSettings, RequestSettingsOverrides, SavedRequest } from '../../types/models';
import { rowHasContent, scriptLineCount } from '../../utils';

type CollectionDefaultsHost = {
  activeCollectionSettingsId: string;
  activeWorkspaceId: string;
  authType: AuthType;
  collections: Collection[];
  reqHeaders: KVRow[];
  requestSettingsOverrides: RequestSettingsOverrides;
  activeCollectionId: () => string;
  activeRequestCollection: () => Collection | undefined;
  authLabel: (type: AuthType) => string;
  authStateHasData: (auth: AuthState, type: AuthType) => boolean;
  collectionForRequest: (req: Pick<SavedRequest, 'collectionId'>) => Collection | undefined;
  collectionSettingDisplayName: (key: keyof RequestSettings) => string;
  collectionSettingDisplayValue: (key: keyof RequestSettings, value: RequestSettings[keyof RequestSettings]) => string;
  collectionSettingHasCustomDefault: (key: keyof RequestSettings) => boolean;
  collectionSettingIsInherited: (key: keyof RequestSettings) => boolean;
  maskedProxyUrl: (value: string) => string;
  previewNames: (names: string[], limit?: number) => string;
  snapshotActiveRequest: (options?: { forPersistence?: boolean }) => SavedRequest;
  persistRequestStore: () => Promise<boolean>;
  guardWorkspaceWritable: (action?: string) => boolean;
};

export const collectionDefaultsFeature = {
  async applyCollectionVariableUpdates(
    this: CollectionDefaultsHost,
    req: Pick<SavedRequest, 'collectionId'>,
    updates: Record<string, string> | undefined,
    removed: string[] | undefined,
  ): Promise<boolean> {
    const hasUpdates = updates && Object.keys(updates).length > 0;
    const hasRemovals = removed && removed.length > 0;
    if (!hasUpdates && !hasRemovals) return false;

    const collection = this.collectionForRequest(req);
    if (!collection) return false;
    if (!this.guardWorkspaceWritable('Collection variables')) return false;

    const rows = [...(collection.defaults.variables ?? [])];
    let changed = false;

    for (const key of removed ?? []) {
      const index = rows.findIndex(row => row.key.trim() === key);
      if (index >= 0) {
        rows.splice(index, 1);
        changed = true;
      }
    }
    for (const [key, value] of Object.entries(updates ?? {})) {
      const index = rows.findIndex(row => row.key.trim() === key);
      if (index >= 0) {
        if (rows[index].value === value) continue;
        rows[index] = { ...rows[index], value };
      } else {
        const nextId = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
        rows.push({ id: nextId, enabled: true, key, value, description: '' });
      }
      changed = true;
    }
    if (!changed) return false;

    this.collections = this.collections.map(candidate =>
      candidate.id === collection.id
        ? { ...candidate, defaults: { ...candidate.defaults, variables: rows } }
        : candidate,
    );
    await this.persistRequestStore();
    return true;
  },

  currentRequestSettingsOverrides(this: CollectionDefaultsHost): RequestSettingsOverrides {
    const overrides: RequestSettingsOverrides = {};
    for (const key of REQUEST_SETTING_KEYS) {
      if (this.requestSettingsOverrides[key]) overrides[key] = true;
    }
    return overrides;
  },

  markRequestSettingOverride(this: CollectionDefaultsHost, key: keyof RequestSettings) {
    this.requestSettingsOverrides = { ...this.requestSettingsOverrides, [key]: true };
  },

  clearRequestSettingOverrides(this: CollectionDefaultsHost) {
    this.requestSettingsOverrides = {};
  },

  collectionForRequest(this: CollectionDefaultsHost, req: Pick<SavedRequest, 'collectionId'>): Collection | undefined {
    return this.collections.find(collection => collection.id === req.collectionId);
  },

  requestWithCollectionDefaults(this: CollectionDefaultsHost, req: SavedRequest): SavedRequest {
    return applyCollectionDefaultsToRequest(req, this.collectionForRequest(req));
  },

  activeRequestCollection(this: CollectionDefaultsHost): Collection | undefined {
    const collectionId = this.activeCollectionId();
    return this.collections.find(collection => collection.id === collectionId && collection.workspaceId === this.activeWorkspaceId)
      ?? this.collectionForRequest(this.snapshotActiveRequest());
  },

  previewNames(this: CollectionDefaultsHost, names: string[], limit = 4): string {
    const visible = names.slice(0, limit).join(', ');
    const extra = names.length - limit;
    return extra > 0 ? `${visible}, +${extra}` : visible;
  },

  maskedProxyUrl(this: CollectionDefaultsHost, value: string): string {
    return value.replace(/:\/\/([^:@/?#]+):([^@/?#]*)@/, '://$1:***@');
  },

  collectionSettingDisplayName(this: CollectionDefaultsHost, key: keyof RequestSettings): string {
    const labels: Record<keyof RequestSettings, string> = {
      httpVersion: 'HTTP version',
      enableSSLVerification: 'SSL verification',
      followRedirects: 'Follow redirects',
      followOriginalMethod: 'Follow original method',
      followAuthorizationHeader: 'Follow Authorization header',
      removeRefererHeader: 'Remove Referer on redirect',
      encodeUrlAutomatically: 'Encode URL',
      disableCookieJar: 'Disable cookie jar',
      maxRedirects: 'Max redirects',
      timeoutMs: 'Timeout',
      scriptTimeoutMs: 'Script timeout',
      allowSendRequest: 'Allow pm.sendRequest',
      proxyUrl: 'HTTP proxy',
      clientCertPath: 'Client certificate',
      clientKeyPath: 'Client key',
      clientKeyPassword: 'Client key passphrase',
      browserEmulation: 'Browser emulation',
      browserOrigin: 'Browser origin',
      browserWithCredentials: 'Browser credentials',
      browserEnforceCORS: 'CORS checks',
      browserEnforceCSP: 'CSP checks',
      browserCSP: 'CSP policy',
      wsHandshakeTimeoutMs: 'WS handshake timeout',
      wsReconnectAttempts: 'WS reconnect attempts',
      wsReconnectIntervalMs: 'WS reconnect interval',
      wsMaxMessageSizeMb: 'WS max message size',
      wsKeepAliveIntervalMs: 'WS keep-alive interval',
      sseDisableReconnect: 'SSE reconnect',
      sseReconnectIntervalMs: 'SSE reconnect interval',
      sioClientVersion: 'Socket.IO client',
      sioPath: 'Socket.IO path',
      sioNamespace: 'Socket.IO namespace',
      grpcUseTls: 'gRPC TLS',
      grpcUseReflection: 'gRPC reflection',
      grpcServerName: 'gRPC server name',
      grpcIncludeDefaultValues: 'gRPC default values',
      grpcMaxResponseMessageSizeMb: 'gRPC max response size',
    };
    return labels[key];
  },

  collectionSettingDisplayValue(this: CollectionDefaultsHost, key: keyof RequestSettings, value: RequestSettings[keyof RequestSettings]): string {
    if (key === 'httpVersion') {
      if (value === '1.1') return 'HTTP/1.1';
      if (value === '2') return 'HTTP/2 preferred';
      return 'Auto';
    }
    if (key === 'timeoutMs' || key === 'scriptTimeoutMs' || key === 'wsHandshakeTimeoutMs' || key === 'wsReconnectIntervalMs') return `${value} ms`;
    if (key === 'wsMaxMessageSizeMb') return `${value} MB`;
    if (key === 'grpcMaxResponseMessageSizeMb') return `${value} MB`;
    if (key === 'proxyUrl') return this.maskedProxyUrl(String(value).trim());
    if (key === 'clientKeyPassword') return String(value) ? '••••••' : '';
    if (key === 'clientCertPath' || key === 'clientKeyPath') {
      const path = String(value).trim();
      return path ? (path.split(/[\\/]/).pop() ?? path) : '';
    }
    if (typeof value === 'boolean') return value ? 'ON' : 'OFF';
    return String(value);
  },

  collectionSettingHasCustomDefault(this: CollectionDefaultsHost, key: keyof RequestSettings): boolean {
    const settings = this.activeRequestCollection()?.defaults.settings;
    return Boolean(settings && settings[key] !== DEFAULT_REQUEST_SETTINGS[key]);
  },

  collectionSettingIsInherited(this: CollectionDefaultsHost, key: keyof RequestSettings): boolean {
    return this.collectionSettingHasCustomDefault(key) && !this.requestSettingsOverrides[key];
  },

  collectionSettingDefaultNote(this: CollectionDefaultsHost, key: keyof RequestSettings): string {
    const settings = this.activeRequestCollection()?.defaults.settings;
    if (!settings || !this.collectionSettingHasCustomDefault(key)) return '';
    const value = settings[key];
    if (key === 'proxyUrl' && !String(value).trim()) return '';
    const prefix = this.collectionSettingIsInherited(key) ? 'Applied from collection' : 'Collection default';
    return `${prefix}: ${this.collectionSettingDisplayValue(key, value)}`;
  },

  get appliedCollectionDefaultNotes(): string[] {
    const host = this as unknown as CollectionDefaultsHost;
    const collection = host.activeRequestCollection();
    const defaults = collection?.defaults;
    const folderPath = host.snapshotActiveRequest().folderPath;
    const folders = folderDefaultsChain(collection, folderPath);
    if (!defaults || (!collectionDefaultsHaveContent(defaults) && !folders.length)) return [];
    const notes: string[] = [];
    const requestHeaderKeys = new Set(
      host.reqHeaders
        .filter(rowHasContent)
        .map(row => row.key.trim().toLowerCase())
        .filter(Boolean),
    );
    const headerNames = inheritedHeaderRows(collection, folderPath)
      .filter(row => row.enabled && row.key.trim() && !requestHeaderKeys.has(row.key.trim().toLowerCase()))
      .map(row => row.key.trim());
    if (headerNames.length) notes.push(`Headers: ${host.previewNames(headerNames)}`);
    const variableNames = defaults.variables
      .filter(row => row.enabled && row.key.trim())
      .map(row => `${row.key.trim()}${row.secret ? ' (secret)' : ''}`);
    if (variableNames.length) notes.push(`Variables: ${host.previewNames(variableNames)}`);
    const auth = inheritedAuth(collection, folderPath);
    if (host.authType === 'inherit' && auth && host.authStateHasData(auth, auth.type)) {
      const source = inheritedAuthSource(collection, folderPath);
      notes.push(`Auth: ${host.authLabel(auth.type)}${source.kind === 'folder' ? ` from folder ${source.folder.path.join(' / ')}` : ''}`);
    }
    const scriptSources = [defaults, ...folders];
    const preRequestLines = scriptSources.reduce((total, source) => total + scriptLineCount(source.preRequestScript) + scriptLineCount(source.preRequestScriptJs), 0);
    if (preRequestLines) notes.push(`Pre-request script: ${preRequestLines}L`);
    const testLines = scriptSources.reduce((total, source) => total + scriptLineCount(source.testScript) + scriptLineCount(source.testScriptJs), 0);
    if (testLines) notes.push(`Test script: ${testLines}L`);
    const settings = REQUEST_SETTING_KEYS
      .filter(key => host.collectionSettingIsInherited(key))
      .map(key => `${host.collectionSettingDisplayName(key)} ${host.collectionSettingDisplayValue(key, defaults.settings[key])}`);
    if (settings.length) notes.push(`Settings: ${host.previewNames(settings, 3)}`);
    return notes;
  },
};
