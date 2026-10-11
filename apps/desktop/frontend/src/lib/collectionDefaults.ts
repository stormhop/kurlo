import { DEFAULT_REQUEST_SETTINGS } from './constants';
import type { AuthState, Collection, CollectionDefaults, KVRow, RequestSettings, RequestSettingsOverrides, SavedRequest } from './types/models';
import { authStateHasData, cloneRowsForStore, emptyAuthState, rowHasContent, sanitizeLike } from './utils';

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

export function collectionSettingsFingerprint(input: Pick<Collection, 'name' | 'description' | 'defaults'> | undefined): string {
  if (!input) return '';




  return JSON.stringify(
    {
      name: input.name ?? '',
      description: input.description ?? '',
      defaults: normalizeCollectionDefaults(input.defaults),
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

export function valuesWithBrunoPriority(
  collection: Collection | undefined,
  environmentValues: Record<string, string>,
  globalValues: Record<string, string> = {},
): Record<string, string> {
  return { ...globalValues, ...collectionVariableValues(collection), ...environmentValues };
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

export function applyCollectionDefaultsToRequest(req: SavedRequest, collection: Collection | undefined): SavedRequest {
  const defaults = collection?.defaults;
  if (!defaults) return req.auth.type === 'inherit' ? { ...req, auth: emptyAuthState() } : req;
  if (!collectionDefaultsHaveContent(defaults) && req.auth.type !== 'inherit') return req;
  return {
    ...req,
    headers: mergeDefaultRows(defaults.headers, req.headers),
    auth: mergeCollectionAuth(defaults.auth, req.auth),
    preRequestScript: joinScripts(defaults.preRequestScript, req.preRequestScript),
    testScript: joinScripts(req.testScript, defaults.testScript),
    preRequestScriptJs: joinScripts(defaults.preRequestScriptJs, req.preRequestScriptJs ?? ''),
    testScriptJs: joinScripts(req.testScriptJs ?? '', defaults.testScriptJs),
    settings: mergeCollectionSettings(defaults.settings, req.settings, req.settingsOverrides),
  };
}
