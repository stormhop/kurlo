import { DEFAULT_REQUEST_SETTINGS } from './constants';
import type { AuthState, Collection, CollectionDefaults, FolderDefaults, KVRow, RequestSettings, RequestSettingsOverrides, SavedRequest } from './types/models';
import { authStateHasData, cloneRowsForStore, emptyAuthState, newEntityId, rowHasContent, sanitizeLike } from './utils';
import { folderPathKey, folderPathStartsWith, normalizeFolderPath } from './collections';
import { normalizeCollectionEnvironmentPins } from './collectionEnvironments';

type RequestSettingKey = keyof RequestSettings;

export const REQUEST_SETTING_KEYS: RequestSettingKey[] = [
  'httpVersion',
  'enableSSLVerification',
  'followRedirects',
  'followOriginalMethod',
  'followAuthorizationHeader',
  'removeRefererHeader',
  'encodeUrlAutomatically',
  'disableCookieJar',
  'maxRedirects',
  'timeoutMs',
  'scriptTimeoutMs',
  'allowSendRequest',
  'proxyUrl',
  'clientCertPath',
  'clientKeyPath',
  'clientKeyPassword',
  'browserEmulation',
  'browserOrigin',
  'browserWithCredentials',
  'browserEnforceCORS',
  'browserEnforceCSP',
  'browserCSP',
  'wsHandshakeTimeoutMs',
  'wsReconnectAttempts',
  'wsReconnectIntervalMs',
  'wsMaxMessageSizeMb',
  'wsKeepAliveIntervalMs',
  'sseDisableReconnect',
  'sseReconnectIntervalMs',
  'sioClientVersion',
  'sioPath',
  'sioNamespace',
  'grpcUseTls',
  'grpcUseReflection',
  'grpcServerName',
  'grpcIncludeDefaultValues',
  'grpcMaxResponseMessageSizeMb',
];

export function emptyCollectionDefaults(): CollectionDefaults {
  return {
    headers: [],
    variables: [],
    auth: emptyAuthState(),
    preRequestScript: '',
    testScript: '',
    preRequestScriptJs: '',
    testScriptJs: '',
    settings: { ...DEFAULT_REQUEST_SETTINGS },
  };
}

export function normalizeCollectionDefaults(raw?: Partial<CollectionDefaults>): CollectionDefaults {
  const input = sanitizeLike(raw, emptyCollectionDefaults());
  return {
    headers: cloneRowsForStore(input.headers ?? []),
    variables: cloneRowsForStore(input.variables ?? []),
    auth: { ...emptyAuthState(), ...sanitizeLike(input.auth, emptyAuthState()) },
    preRequestScript: input.preRequestScript ?? '',
    testScript: input.testScript ?? '',
    preRequestScriptJs: input.preRequestScriptJs ?? '',
    testScriptJs: input.testScriptJs ?? '',
    settings: { ...DEFAULT_REQUEST_SETTINGS, ...sanitizeLike(input.settings, DEFAULT_REQUEST_SETTINGS) },
  };
}

export function collectionSettingsFingerprint(input: Pick<Collection, 'name' | 'description' | 'defaults' | 'environmentIds' | 'defaultEnvironmentId'> | undefined): string {
  if (!input) return '';
  const pins = normalizeCollectionEnvironmentPins(input);
  return JSON.stringify(
    {
      name: input.name ?? '',
      description: input.description ?? '',
      defaults: normalizeCollectionDefaults(input.defaults),
      environmentIds: pins.environmentIds ?? [],
      defaultEnvironmentId: pins.defaultEnvironmentId ?? '',
    },
    (key, value) => (key === 'id' ? undefined : value),
  );
}

export function collectionDefaultsHaveContent(defaults: CollectionDefaults | undefined): boolean {
  if (!defaults) return false;
  return Boolean(
    defaults.headers.some(rowHasContent)
    || defaults.variables.some(rowHasContent)
    || authStateHasData(defaults.auth, defaults.auth.type)
    || defaults.preRequestScript.trim()
    || defaults.testScript.trim()
    || defaults.preRequestScriptJs.trim()
    || defaults.testScriptJs.trim()
    || REQUEST_SETTING_KEYS.some(key => defaults.settings[key] !== DEFAULT_REQUEST_SETTINGS[key])
  );
}

export function collectionVariableValues(collection: Collection | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  for (const row of collection?.defaults.variables ?? []) {
    if (row.enabled && row.key.trim()) values[row.key.trim()] = row.value;
  }
  return values;
}

const REQUEST_VARIABLE_PATTERN = /\{\{([^{}]*)\}\}/g;

function substituteKnownVariables(value: string, values: Record<string, string>): string {
  let resolved = value;
  for (let depth = 0; depth < 20 && resolved.includes('{{'); depth += 1) {
    const next = resolved.replace(REQUEST_VARIABLE_PATTERN, (match, raw: string) => {
      const key = raw.trim();
      return key && Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
    });
    if (next === resolved) break;
    resolved = next;
  }
  return resolved;
}

export function requestVariableValues(
  rows: KVRow[] | undefined,
  scopeValues: Record<string, string> = {},
): Record<string, string> {
  const values: Record<string, string> = {};
  const scope = { ...scopeValues };
  for (const row of rows ?? []) {
    const key = row.key.trim();
    if (!row.enabled || !key) continue;
    const value = substituteKnownVariables(row.value, scope);
    values[key] = value;
    scope[key] = value;
  }
  return values;
}

export function requestSecretVariableKeys(rows: KVRow[] | undefined): string[] {
  return (rows ?? []).filter(row => row.enabled && row.secret && row.key.trim()).map(row => row.key.trim());
}

export function requestSecretVariableValues(rows: KVRow[] | undefined): string[] {
  return (rows ?? []).filter(row => row.enabled && row.secret && row.value).map(row => row.value);
}

export function valuesWithBrunoPriority(
  collection: Collection | undefined,
  environmentValues: Record<string, string>,
  globalValues: Record<string, string> = {},
  requestVariables?: KVRow[],
): Record<string, string> {
  const scoped = { ...globalValues, ...collectionVariableValues(collection), ...environmentValues };
  if (!requestVariables?.length) return scoped;
  return { ...scoped, ...requestVariableValues(requestVariables, scoped) };
}

export function collectionSecretVariableKeys(collection: Collection | undefined): string[] {
  return (collection?.defaults.variables ?? [])
    .filter(row => row.enabled && row.secret && row.key.trim())
    .map(row => row.key.trim());
}

export function collectionSecretVariableValues(collection: Collection | undefined): string[] {
  return (collection?.defaults.variables ?? [])
    .filter(row => row.enabled && row.secret && row.value)
    .map(row => row.value);
}

export function mergeDefaultRows(defaultRows: KVRow[] = [], requestRows: KVRow[] = []): KVRow[] {
  const requestKeys = new Set(
    requestRows
      .filter(rowHasContent)
      .map(row => row.key.trim().toLowerCase())
      .filter(Boolean),
  );
  return [
    ...cloneRowsForStore(defaultRows.filter(row => {
      const key = row.key.trim().toLowerCase();
      return key && !requestKeys.has(key);
    })),
    ...cloneRowsForStore(requestRows),
  ];
}

export function mergeCollectionAuth(defaultAuth: AuthState, requestAuth: AuthState): AuthState {
  if (requestAuth.type !== 'inherit') return { ...requestAuth };
  if (defaultAuth.type !== 'none' && authStateHasData(defaultAuth, defaultAuth.type)) return { ...defaultAuth };
  return emptyAuthState();
}

export function requestSettingsOverridesFromSettings(settings: RequestSettings, inherited?: Partial<RequestSettings>): RequestSettingsOverrides {
  const overrides: RequestSettingsOverrides = {};
  for (const key of REQUEST_SETTING_KEYS) {
    if (settings[key] === DEFAULT_REQUEST_SETTINGS[key]) continue;
    if (inherited && Object.prototype.hasOwnProperty.call(inherited, key) && settings[key] === inherited[key]) continue;
    overrides[key] = true;
  }
  return overrides;
}

export function normalizeRequestSettingsOverrides(
  overrides: RequestSettingsOverrides | undefined,
  settings: RequestSettings,
  inherited?: Partial<RequestSettings>,
): RequestSettingsOverrides {
  if (!overrides) return requestSettingsOverridesFromSettings(settings, inherited);
  const normalized: RequestSettingsOverrides = {};
  for (const key of REQUEST_SETTING_KEYS) {
    if (overrides[key]) normalized[key] = true;
  }
  return normalized;
}

export function requestSettingsOverridesFromPatch(patch: Partial<RequestSettings>): RequestSettingsOverrides {
  const overrides: RequestSettingsOverrides = {};
  for (const key of REQUEST_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) overrides[key] = true;
  }
  return overrides;
}

export function mergeCollectionSettings(
  defaultSettings: RequestSettings,
  requestSettings: RequestSettings,
  requestOverrides: RequestSettingsOverrides = requestSettingsOverridesFromSettings(requestSettings),
): RequestSettings {
  const merged = { ...requestSettings };
  for (const key of REQUEST_SETTING_KEYS) {
    if (!requestOverrides[key]) {
      merged[key] = defaultSettings[key] as never;
    }
  }
  return merged;
}

function joinScripts(...scripts: string[]) {
  const parts = scripts.map(script => script.trim()).filter(Boolean);
  return parts.join('\n\n');
}

export function emptyFolderDefaults(path: string[], id = newEntityId('folder')): FolderDefaults {
  return {
    id,
    path: normalizeFolderPath(path),
    headers: [],
    auth: { ...emptyAuthState(), type: 'inherit' },
    preRequestScript: '',
    testScript: '',
    preRequestScriptJs: '',
    testScriptJs: '',
  };
}

export function folderDefaultsFingerprint(folder: FolderDefaults | undefined): string {
  if (!folder || !folderDefaultsHaveContent(folder)) return '';
  const normalized = normalizeFolderDefaults(folder);
  return JSON.stringify(normalized, (key, value) => (key === 'id' ? undefined : value));
}

export function folderDefaultsHaveContent(folder: FolderDefaults | undefined): boolean {
  if (!folder) return false;
  return Boolean(
    folder.headers.some(rowHasContent)
    || folder.auth.type !== 'inherit'
    || folder.preRequestScript.trim()
    || folder.testScript.trim()
    || folder.preRequestScriptJs.trim()
    || folder.testScriptJs.trim()
  );
}

export function normalizeFolderDefaults(raw: unknown): FolderDefaults | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Partial<FolderDefaults>;
  const path = normalizeFolderPath(Array.isArray(input.path) ? input.path.map(String) : []);
  if (!path.length) return null;
  const empty = emptyFolderDefaults(path, typeof input.id === 'string' && input.id.trim() ? input.id.trim() : undefined);
  const auth = { ...empty.auth, ...sanitizeLike(input.auth, empty.auth) };
  return {
    ...empty,
    headers: cloneRowsForStore(Array.isArray(input.headers) ? input.headers : []),
    auth: { ...auth, type: auth.type || 'inherit' },
    preRequestScript: typeof input.preRequestScript === 'string' ? input.preRequestScript : '',
    testScript: typeof input.testScript === 'string' ? input.testScript : '',
    preRequestScriptJs: typeof input.preRequestScriptJs === 'string' ? input.preRequestScriptJs : '',
    testScriptJs: typeof input.testScriptJs === 'string' ? input.testScriptJs : '',
  };
}

export function normalizeFolderDefaultsList(raw: unknown): FolderDefaults[] {
  const byPath = new Map<string, FolderDefaults>();
  for (const item of Array.isArray(raw) ? raw : []) {
    const folder = normalizeFolderDefaults(item);
    if (!folder || !folderDefaultsHaveContent(folder)) continue;
    const key = folderPathKey(folder.path);
    byPath.delete(key);
    byPath.set(key, folder);
  }
  return [...byPath.values()];
}

export function folderDefaultsFor(collection: Collection | undefined, path: string[] | undefined): FolderDefaults | undefined {
  const key = folderPathKey(path);
  if (!key) return undefined;
  return collection?.folderDefaults?.find(folder => folderPathKey(folder.path) === key);
}

export function folderDefaultsChain(collection: Collection | undefined, path: string[] | undefined): FolderDefaults[] {
  const normalized = normalizeFolderPath(path);
  const chain: FolderDefaults[] = [];
  for (let depth = 1; depth <= normalized.length; depth += 1) {
    const folder = folderDefaultsFor(collection, normalized.slice(0, depth));
    if (folder) chain.push(folder);
  }
  return chain;
}

export function withFolderDefaults(collection: Collection, folder: FolderDefaults): Collection {
  const key = folderPathKey(folder.path);
  const others = (collection.folderDefaults ?? []).filter(candidate => folderPathKey(candidate.path) !== key);
  return { ...collection, folderDefaults: normalizeFolderDefaultsList([...others, folder]) };
}

export function renameFolderDefaults(collection: Collection, oldPath: string[], newPath: string[]): Collection {
  if (!collection.folderDefaults?.length) return collection;
  const from = normalizeFolderPath(oldPath);
  const to = normalizeFolderPath(newPath);
  const moved: FolderDefaults[] = [];
  const kept: FolderDefaults[] = [];
  for (const folder of collection.folderDefaults) {
    if (folderPathStartsWith(folder.path, from)) moved.push({ ...folder, path: [...to, ...folder.path.slice(from.length)] });
    else kept.push(folder);
  }
  return { ...collection, folderDefaults: normalizeFolderDefaultsList([...kept, ...moved]) };
}

export function removeFolderDefaultsTree(collection: Collection, path: string[]): Collection {
  if (!collection.folderDefaults?.length) return collection;
  return { ...collection, folderDefaults: collection.folderDefaults.filter(folder => !folderPathStartsWith(folder.path, path)) };
}

export type InheritedAuthSource = { kind: 'collection' } | { kind: 'folder'; folder: FolderDefaults };

export function inheritedAuthSource(collection: Collection | undefined, path: string[] | undefined): InheritedAuthSource {
  const chain = folderDefaultsChain(collection, path);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (chain[index].auth.type !== 'inherit') return { kind: 'folder', folder: chain[index] };
  }
  return { kind: 'collection' };
}

export function inheritedAuth(collection: Collection | undefined, path: string[] | undefined): AuthState | undefined {
  const source = inheritedAuthSource(collection, path);
  return source.kind === 'folder' ? source.folder.auth : collection?.defaults.auth;
}

export function withInheritedAuth(collection: Collection, path: string[] | undefined, change: (auth: AuthState) => AuthState): Collection {
  const source = inheritedAuthSource(collection, path);
  if (source.kind === 'folder') return withFolderDefaults(collection, { ...source.folder, auth: change(source.folder.auth) });
  return { ...collection, defaults: { ...collection.defaults, auth: change(collection.defaults.auth) } };
}

export function inheritedHeaderRows(collection: Collection | undefined, path: string[] | undefined): KVRow[] {
  let rows = collection?.defaults.headers ?? [];
  for (const folder of folderDefaultsChain(collection, path)) rows = mergeDefaultRows(rows, folder.headers);
  return rows;
}

export function applyCollectionDefaultsToRequest(req: SavedRequest, collection: Collection | undefined): SavedRequest {
  const defaults = collection?.defaults;
  if (!defaults) return req.auth.type === 'inherit' ? { ...req, auth: emptyAuthState() } : req;
  const folders = folderDefaultsChain(collection, req.folderPath);
  if (!folders.length && !collectionDefaultsHaveContent(defaults) && req.auth.type !== 'inherit') return req;
  const outerFirst = folders;
  const innerFirst = [...folders].reverse();
  return {
    ...req,
    headers: mergeDefaultRows(inheritedHeaderRows(collection, req.folderPath), req.headers),
    auth: mergeCollectionAuth(inheritedAuth(collection, req.folderPath) ?? defaults.auth, req.auth),
    preRequestScript: joinScripts(defaults.preRequestScript, ...outerFirst.map(folder => folder.preRequestScript), req.preRequestScript),
    testScript: joinScripts(req.testScript, ...innerFirst.map(folder => folder.testScript), defaults.testScript),
    preRequestScriptJs: joinScripts(defaults.preRequestScriptJs, ...outerFirst.map(folder => folder.preRequestScriptJs), req.preRequestScriptJs ?? ''),
    testScriptJs: joinScripts(req.testScriptJs ?? '', ...innerFirst.map(folder => folder.testScriptJs), defaults.testScriptJs),
    settings: mergeCollectionSettings(defaults.settings, req.settings, req.settingsOverrides),
  };
}
