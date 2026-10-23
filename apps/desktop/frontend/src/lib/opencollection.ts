import { DEFAULT_REQUEST_SETTINGS, mkRow } from './constants';
import { normalizeCollectionDefaults, requestSettingsOverridesFromPatch, REQUEST_SETTING_KEYS } from './collectionDefaults';
import { normalizeRequestExample } from './examples';
import { safeExportRow, safeExportUrl, safeExportValue, sanitizeExportExample } from './secretExport';
import type { AuthState, AuthType, BodyType, CollectionDefaults, Environment, KVRow, Method, RawBodyType, RequestExample, RequestSettings, RequestSettingsOverrides, RequestTab, RequestType, SavedRequest, SIOArg } from './types/models';
import { asArray, asText, authStateHasData, emptyAuthState, inheritAuthState, isRecord, newEntityId, newRequestId, safeFileName } from './utils';
import { filesystemNameFromName } from './normalizers';
import { DEFAULT_GRPC_MESSAGE } from './requestBodyDefaults';
import { parseYaml } from './yaml';
import { pathParamsFromUrl } from './pathParams';

export type CollectionTextFile = {
  path: string;
  content: string;
};

export type OpenCollectionImportBundle = {
  name: string;
  description: string;
  defaults: CollectionDefaults;
  folderPaths: string[][];
  requests: SavedRequest[];
  environments: Environment[];
};

type ScriptEntry = {
  type?: unknown;
  code?: unknown;
};

type CollectionDefaultsInput = {
  headers?: KVRow[];
  variables?: KVRow[];
  auth?: AuthState;
  preRequestScript?: string;
  testScript?: string;
  settings?: Partial<RequestSettings>;
};

const HTTP_METHODS = new Set<Method>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const AUTH_TYPES = new Set<AuthType>(['inherit', 'none', 'bearer', 'basic', 'apikey', 'oauth2', 'aws', 'digest']);
const BRU_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace', 'connect']);
const BRU_REQUEST_BLOCKS = new Set(['graphql', 'grpc', 'websocket', 'ws', 'socketio', 'socket_io', 'sio']);
const REQUEST_TYPES = new Set<RequestType>(['http', 'graphql', 'ws', 'socketio', 'grpc']);
const REQUEST_TABS = new Set<RequestTab>(['docs', 'params', 'query', 'auth', 'headers', 'metadata', 'body', 'schema', 'service', 'events', 'scripts', 'settings']);

function basename(path: string) {
  return path.split('/').pop() ?? path;
}

function dirname(path: string) {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/');
}

function withoutExtension(path: string) {
  return basename(path).replace(/\.[^.]+$/, '');
}

function displayNameFromSegment(segment: string) {
  return segment.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || segment;
}

function fileSegment(name: string, fallback = 'request') {
  return safeFileName(name || fallback).replace(/\s+/g, '-') || fallback;
}

function rowFromOpenCollection(value: unknown, fallbackType = 'query'): KVRow {
  const row = isRecord(value) ? value : {};
  const key = asText(row.name ?? row.key);
  return {
    ...mkRow(),
    key,
    value: asText(row.value ?? row.data),
    description: asText(row.description),
    enabled: row.disabled !== true && row.enabled !== false,
    secret: row.secret === true,
    isFile: asText(row.type) === 'file',
    fileName: asText(row.fileName),
    contentType: asText(row.contentType),
    ...(fallbackType === 'file' ? { isFile: true } : {}),
  };
}

function rowToOpenCollection(row: KVRow, type?: 'query' | 'path', includeSecrets = false) {
  const item: Record<string, unknown> = {
    name: row.key,
    value: safeExportValue(row.key, row.value, includeSecrets, row.secret === true),
  };
  if (type) item.type = type;
  if (!row.enabled) item.disabled = true;
  if (row.description) item.description = row.description;
  if (row.secret) item.secret = true;
  if (row.isFile) {
    item.type = 'file';
    if (row.fileName) item.fileName = row.fileName;
  }
  if (row.contentType) item.contentType = row.contentType;
  return item;
}

function rowsFromOpenCollectionList(value: unknown, fallbackType = 'query') {
  return asArray(value)
    .map(row => rowFromOpenCollection(row, fallbackType))
    .filter(row => row.key || row.value);
}

function rowsFromOpenCollectionValue(value: unknown, fallbackType = 'query') {
  if (Array.isArray(value)) return rowsFromOpenCollectionList(value, fallbackType);
  if (!isRecord(value)) return [];
  const rows: KVRow[] = [];
  for (const [key, raw] of Object.entries(value)) {
    rows.push({ ...mkRow(), key, value: asText(raw), enabled: true });
  }
  return rows.filter(row => row.key || row.value);
}

function requestTypeFromOpenCollection(value: unknown): RequestType | '' {
  const type = asText(value).toLowerCase();
  if (type === 'websocket') return 'ws';
  if (type === 'socket.io' || type === 'socket_io' || type === 'sio') return 'socketio';
  return REQUEST_TYPES.has(type as RequestType) ? type as RequestType : '';
}

function requestTabFromOpenCollection(value: unknown): RequestTab | '' {
  const tab = asText(value).toLowerCase();
  return REQUEST_TABS.has(tab as RequestTab) ? tab as RequestTab : '';
}

function sioArgsFromOpenCollection(value: unknown): SIOArg[] {
  return asArray(value).map(item => {
    if (!isRecord(item)) return null;
    return {
      id: asText(item.id) || newRequestId(),
      content: asText(item.content ?? item.value ?? item.data),
      bodyType: (['text', 'json', 'html', 'xml', 'binary'].includes(asText(item.bodyType ?? item.type)) ? asText(item.bodyType ?? item.type) : 'text') as SIOArg['bodyType'],
      encoding: asText(item.encoding) === 'hex' ? 'hex' : 'base64',
    };
  }).filter((item): item is SIOArg => Boolean(item));
}

function paramsFromOpenCollection(value: unknown): { query: KVRow[]; path: KVRow[] } {
  if (Array.isArray(value)) {
    const isPath = (item: unknown) => isRecord(item) && asText(item.type) === 'path';
    return {
      query: rowsFromOpenCollectionList(value.filter(item => !isPath(item)), 'query'),
      path: rowsFromOpenCollectionList(value.filter(isPath), 'path'),
    };
  }
  if (!isRecord(value)) return { query: [], path: [] };
  return {
    query: rowsFromOpenCollectionList(value.query, 'query'),
    path: rowsFromOpenCollectionList(value.path, 'path'),
  };
}

function importedPathParams(requestType: RequestType, url: string, rows: KVRow[]) {
  if (requestType !== 'http' && requestType !== 'graphql') return {};
  const pathParams = pathParamsFromUrl(url, rows);
  return pathParams.length ? { pathParams } : {};
}

function rowsFromBruBlock(block = '') {
  return block.split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const index = line.indexOf(':');
      if (index < 0) return null;
      return { ...mkRow(), key: line.slice(0, index).trim(), value: line.slice(index + 1).trim(), enabled: true };
    })
    .filter((row): row is KVRow => Boolean(row && (row.key || row.value)));
}

function kvArrayToRecord(arr: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of arr) {
    if (!isRecord(item)) continue;
    const k = asText(item.key);
    if (!k) continue;
    out[k] = item.value;
  }
  return out;
}

function openCollectionAuth(value: unknown): SavedRequest['auth'] {
  const auth = emptyAuthState();
  if (typeof value === 'string') {
    const type = value.toLowerCase();
    auth.type = AUTH_TYPES.has(type as AuthType) ? type as AuthType : 'none';
    return auth;
  }
  if (!isRecord(value)) return auth;
  const type = asText(value.type).toLowerCase();
  const nested = isRecord(value[type]) ? value[type] as Record<string, unknown> : {};
  if (type === 'inherit') return inheritAuthState();
  if (type === 'none') return auth;
  if (type === 'bearer') return { ...auth, type: 'bearer', bearerToken: asText(value.token ?? value.bearerToken ?? nested.token ?? nested.bearerToken) };
  if (type === 'basic') return { ...auth, type: 'basic', basicUser: asText(value.username ?? nested.username), basicPass: asText(value.password ?? nested.password) };
  if (type === 'digest') return { ...auth, type: 'digest', basicUser: asText(value.username ?? nested.username), basicPass: asText(value.password ?? nested.password) };
  if (type === 'apikey' || type === 'api-key') {
    const apiKey = isRecord(value.apikey) ? value.apikey : nested;
    return {
      ...auth,
      type: 'apikey',
      apiKeyName: asText(value.key ?? value.name ?? apiKey.key ?? apiKey.name),
      apiKeyValue: asText(value.value ?? apiKey.value),
      apiKeyIn: asText(value.placement ?? value.in ?? apiKey.placement ?? apiKey.in) === 'query' ? 'query' : 'header',
    };
  }
  if (type === 'oauth2') {
    const oauth2 = isRecord(value.oauth2) ? value.oauth2 : nested;
    return {
      ...auth,
      type: 'oauth2',
      oauth2TokenURL: asText(value.tokenUrl ?? value.accessTokenUrl ?? oauth2.tokenUrl ?? oauth2.accessTokenUrl),
      oauth2ClientID: asText(value.clientId ?? oauth2.clientId),
      oauth2Secret: asText(value.clientSecret ?? oauth2.clientSecret),
      oauth2Scope: asText(value.scope ?? oauth2.scope),
      oauth2Token: asText(value.accessToken ?? value.token ?? oauth2.accessToken ?? oauth2.token),
    };
  }
  if (type === 'awsv4' || type === 'aws') {
    const awsArr = Array.isArray(value.awsv4) ? kvArrayToRecord(value.awsv4) :
                   Array.isArray(value.aws) ? kvArrayToRecord(value.aws) : null;
    const aws = isRecord(value.awsv4) ? value.awsv4 :
                isRecord(value.aws) ? value.aws :
                awsArr ?? nested;
    return {
      ...auth,
      type: 'aws',
      awsAccessKey: asText(value.accessKeyId ?? value.accessKey ?? aws.accessKeyId ?? aws.accessKey),
      awsSecretKey: asText(value.secretAccessKey ?? value.secretKey ?? aws.secretAccessKey ?? aws.secretKey),
      awsRegion: asText(value.region ?? aws.region),
      awsService: asText(value.service ?? aws.service),
    };
  }
  return auth;
}

function authToOpenCollection(auth: SavedRequest['auth'], includeSecrets = false) {
  if (auth.type === 'inherit') return 'inherit';
  if (auth.type === 'bearer') return { type: 'bearer', token: safeExportValue('token', auth.bearerToken, includeSecrets) };
  if (auth.type === 'basic') return { type: 'basic', username: auth.basicUser, password: safeExportValue('password', auth.basicPass, includeSecrets) };
  if (auth.type === 'digest') return { type: 'digest', username: auth.basicUser, password: safeExportValue('password', auth.basicPass, includeSecrets) };
  if (auth.type === 'apikey') {
    return {
      type: 'apikey',
      key: auth.apiKeyName,
      value: safeExportValue(auth.apiKeyName || 'apiKey', auth.apiKeyValue, includeSecrets),
      placement: auth.apiKeyIn,
    };
  }
  if (auth.type === 'oauth2') {
    return {
      type: 'oauth2',
      accessTokenUrl: auth.oauth2TokenURL,
      clientId: auth.oauth2ClientID,
      clientSecret: safeExportValue('clientSecret', auth.oauth2Secret, includeSecrets),
      scope: auth.oauth2Scope,
      accessToken: safeExportValue('accessToken', auth.oauth2Token, includeSecrets),
    };
  }
  if (auth.type === 'aws') {
    return {
      type: 'awsv4',
      accessKeyId: safeExportValue('accessKey', auth.awsAccessKey, includeSecrets),
      secretAccessKey: safeExportValue('secretKey', auth.awsSecretKey, includeSecrets),
      region: auth.awsRegion,
      service: auth.awsService,
    };
  }
  return 'none';
}

function bodyFromOpenCollection(value: unknown): Pick<SavedRequest, 'bodyType' | 'rawBodyType' | 'bodyContent' | 'formRows'> {
  if (!isRecord(value)) return { bodyType: 'none', rawBodyType: 'json', bodyContent: '', formRows: [] };
  const type = asText(value.type).toLowerCase();
  if (type === 'json') return { bodyType: 'json', rawBodyType: 'json', bodyContent: asText(value.data), formRows: [] };
  if (type === 'xml') return { bodyType: 'xml', rawBodyType: 'xml', bodyContent: asText(value.data), formRows: [] };
  if (type === 'html') return { bodyType: 'html', rawBodyType: 'html', bodyContent: asText(value.data), formRows: [] };
  if (type === 'text') return { bodyType: 'text', rawBodyType: 'text', bodyContent: asText(value.data), formRows: [] };
  if (type === 'graphql') {
    const query = asText(value.data ?? value.query);
    const variables = isRecord(value.variables) || Array.isArray(value.variables)
      ? JSON.stringify(value.variables, null, 2)
      : asText(value.variables);
    const payload = { query, variables: variables ? safeParseJSON(variables, {}) : {}, operationName: asText(value.operationName) || undefined };
    return { bodyType: 'graphql', rawBodyType: 'json', bodyContent: JSON.stringify(payload, null, 2), formRows: [] };
  }
  if (type === 'form-urlencoded' || type === 'urlencoded') {
    return { bodyType: 'urlencoded', rawBodyType: 'json', bodyContent: '', formRows: rowsFromOpenCollectionList(value.data) };
  }
  if (type === 'multipart-form' || type === 'multipart') {
    return { bodyType: 'form', rawBodyType: 'json', bodyContent: '', formRows: rowsFromOpenCollectionList(value.data) };
  }
  if (type === 'binary' || type === 'file') {
    return { bodyType: 'binary', rawBodyType: 'json', bodyContent: asText(value.data ?? value.file), formRows: [] };
  }
  return { bodyType: 'none', rawBodyType: 'json', bodyContent: '', formRows: [] };
}

function bodyToOpenCollection(req: SavedRequest, stripFn: (source: string, bodyType: string) => string, includeSecrets = false) {
  if (req.bodyType === 'json' || req.bodyType === 'xml' || req.bodyType === 'html' || req.bodyType === 'text') {
    return { type: req.bodyType, data: exportBodyLikeValue(req.bodyContent, req.bodyType, stripFn, includeSecrets) };
  }
  if (req.bodyType === 'urlencoded') {
    return { type: 'form-urlencoded', data: req.formRows.filter(row => row.key || row.value).map(row => rowToOpenCollection(row, undefined, includeSecrets)) };
  }
  if (req.bodyType === 'form') {
    return { type: 'multipart-form', data: req.formRows.filter(row => row.key || row.value).map(row => rowToOpenCollection(row, undefined, includeSecrets)) };
  }
  if (req.bodyType === 'graphql') {
    const payload = safeParseJSON(stripFn(req.bodyContent, req.bodyType), {}) as Record<string, unknown>;
    return {
      type: 'graphql',
      data: asText(payload.query),
      ...(payload.variables ? { variables: sanitizeExportExample(payload.variables, includeSecrets) } : {}),
      ...(payload.operationName ? { operationName: payload.operationName } : {}),
    };
  }
  if (req.bodyType === 'binary') {
    return { type: 'binary', file: req.bodyFilePath || req.bodyFileName };
  }
  return undefined;
}

function numberSetting(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function booleanSetting(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
}

function settingsPatchFromOpenCollection(value: unknown): Partial<RequestSettings> {
  const settings: Partial<RequestSettings> = {};
  if (!isRecord(value)) return settings;
  const encodeUrl = booleanSetting(value.encodeUrl ?? value.encodeUrlAutomatically);
  if (encodeUrl !== undefined) settings.encodeUrlAutomatically = encodeUrl;
  const followRedirects = booleanSetting(value.followRedirects);
  if (followRedirects !== undefined) settings.followRedirects = followRedirects;
  const maxRedirects = numberSetting(value.maxRedirects);
  if (maxRedirects !== undefined) settings.maxRedirects = maxRedirects;
  const timeout = numberSetting(value.timeout ?? value.timeoutMs);
  if (timeout !== undefined) settings.timeoutMs = timeout;
  const sslVerification = booleanSetting(value.sslVerification ?? value.enableSSLVerification);
  if (sslVerification !== undefined) settings.enableSSLVerification = sslVerification;
  const followOriginalMethod = booleanSetting(value.followOriginalMethod);
  if (followOriginalMethod !== undefined) settings.followOriginalMethod = followOriginalMethod;
  const followAuthorizationHeader = booleanSetting(value.followAuthorizationHeader);
  if (followAuthorizationHeader !== undefined) settings.followAuthorizationHeader = followAuthorizationHeader;
  const removeRefererHeader = booleanSetting(value.removeRefererHeader);
  if (removeRefererHeader !== undefined) settings.removeRefererHeader = removeRefererHeader;
  const disableCookieJar = booleanSetting(value.disableCookieJar);
  if (disableCookieJar !== undefined) settings.disableCookieJar = disableCookieJar;
  if (typeof value.httpVersion === 'string' && ['auto', '1.1', '2'].includes(value.httpVersion)) settings.httpVersion = value.httpVersion as RequestSettings['httpVersion'];
  if (typeof value.proxyUrl === 'string') settings.proxyUrl = value.proxyUrl;
  const browserEmulation = booleanSetting(value.browserEmulation);
  if (browserEmulation !== undefined) settings.browserEmulation = browserEmulation;
  if (typeof value.browserOrigin === 'string') settings.browserOrigin = value.browserOrigin;
  const browserWithCredentials = booleanSetting(value.browserWithCredentials);
  if (browserWithCredentials !== undefined) settings.browserWithCredentials = browserWithCredentials;
  const browserEnforceCORS = booleanSetting(value.browserEnforceCORS);
  if (browserEnforceCORS !== undefined) settings.browserEnforceCORS = browserEnforceCORS;
  const browserEnforceCSP = booleanSetting(value.browserEnforceCSP);
  if (browserEnforceCSP !== undefined) settings.browserEnforceCSP = browserEnforceCSP;
  if (typeof value.browserCSP === 'string') settings.browserCSP = value.browserCSP;
  const wsHandshakeTimeoutMs = numberSetting(value.wsHandshakeTimeoutMs);
  if (wsHandshakeTimeoutMs !== undefined) settings.wsHandshakeTimeoutMs = wsHandshakeTimeoutMs;
  const wsReconnectAttempts = numberSetting(value.wsReconnectAttempts);
  if (wsReconnectAttempts !== undefined) settings.wsReconnectAttempts = wsReconnectAttempts;
  const wsReconnectIntervalMs = numberSetting(value.wsReconnectIntervalMs);
  if (wsReconnectIntervalMs !== undefined) settings.wsReconnectIntervalMs = wsReconnectIntervalMs;
  const wsMaxMessageSizeMb = numberSetting(value.wsMaxMessageSizeMb);
  if (wsMaxMessageSizeMb !== undefined) settings.wsMaxMessageSizeMb = wsMaxMessageSizeMb;
  if (typeof value.sioClientVersion === 'string' && ['v2', 'v3'].includes(value.sioClientVersion)) settings.sioClientVersion = value.sioClientVersion as RequestSettings['sioClientVersion'];
  if (typeof value.sioPath === 'string') settings.sioPath = value.sioPath;
  if (typeof value.sioNamespace === 'string') settings.sioNamespace = value.sioNamespace;
  const grpcUseTls = booleanSetting(value.grpcUseTls);
  if (grpcUseTls !== undefined) settings.grpcUseTls = grpcUseTls;
  const grpcUseReflection = booleanSetting(value.grpcUseReflection);
  if (grpcUseReflection !== undefined) settings.grpcUseReflection = grpcUseReflection;
  if (typeof value.grpcServerName === 'string') settings.grpcServerName = value.grpcServerName;
  const grpcIncludeDefaultValues = booleanSetting(value.grpcIncludeDefaultValues);
  if (grpcIncludeDefaultValues !== undefined) settings.grpcIncludeDefaultValues = grpcIncludeDefaultValues;
  const grpcMaxResponseMessageSizeMb = numberSetting(value.grpcMaxResponseMessageSizeMb);
  if (grpcMaxResponseMessageSizeMb !== undefined) settings.grpcMaxResponseMessageSizeMb = grpcMaxResponseMessageSizeMb;
  return settings;
}

function settingsPatchFromBruBlock(block = ''): Partial<RequestSettings> {
  return settingsPatchFromOpenCollection(parseBruKeyValues(block));
}

function settingKeyFromOpenCollectionKey(key: string): keyof RequestSettings | undefined {
  if (key === 'encodeUrl') return 'encodeUrlAutomatically';
  if (key === 'timeout') return 'timeoutMs';
  if (key === 'sslVerification') return 'enableSSLVerification';
  return REQUEST_SETTING_KEYS.includes(key as keyof RequestSettings) ? key as keyof RequestSettings : undefined;
}

function settingsToOpenCollection(
  settings: RequestSettings,
  compact = false,
  includeKurloExtensions = false,
  overrides?: RequestSettingsOverrides,
) {
  const candidates: Record<string, unknown> = {
    encodeUrl: settings.encodeUrlAutomatically,
    timeout: settings.timeoutMs,
    followRedirects: settings.followRedirects,
    maxRedirects: settings.maxRedirects,
    sslVerification: settings.enableSSLVerification,
  };
  if (includeKurloExtensions) {
    Object.assign(candidates, {
      httpVersion: settings.httpVersion,
      followOriginalMethod: settings.followOriginalMethod,
      followAuthorizationHeader: settings.followAuthorizationHeader,
      removeRefererHeader: settings.removeRefererHeader,
      disableCookieJar: settings.disableCookieJar,
      proxyUrl: settings.proxyUrl,
      browserEmulation: settings.browserEmulation,
      browserOrigin: settings.browserOrigin,
      browserWithCredentials: settings.browserWithCredentials,
      browserEnforceCORS: settings.browserEnforceCORS,
      browserEnforceCSP: settings.browserEnforceCSP,
      browserCSP: settings.browserCSP,
      wsHandshakeTimeoutMs: settings.wsHandshakeTimeoutMs,
      wsReconnectAttempts: settings.wsReconnectAttempts,
      wsReconnectIntervalMs: settings.wsReconnectIntervalMs,
      wsMaxMessageSizeMb: settings.wsMaxMessageSizeMb,
      sioClientVersion: settings.sioClientVersion,
      sioPath: settings.sioPath,
      sioNamespace: settings.sioNamespace,
      grpcUseTls: settings.grpcUseTls,
      grpcUseReflection: settings.grpcUseReflection,
      grpcServerName: settings.grpcServerName,
      grpcIncludeDefaultValues: settings.grpcIncludeDefaultValues,
      grpcMaxResponseMessageSizeMb: settings.grpcMaxResponseMessageSizeMb,
    });
  }
  if (overrides) {
    return Object.fromEntries(Object.entries(candidates).filter(([key]) => {
      const settingKey = settingKeyFromOpenCollectionKey(key);
      return Boolean(settingKey && overrides[settingKey]);
    }));
  }
  if (!compact) return candidates;
  const defaults = DEFAULT_REQUEST_SETTINGS;
  return Object.fromEntries(Object.entries(candidates).filter(([key, value]) => {
    if (key === 'encodeUrl') return value !== defaults.encodeUrlAutomatically;
    if (key === 'timeout') return value !== defaults.timeoutMs;
    if (key === 'sslVerification') return value !== defaults.enableSSLVerification;
    return value !== defaults[key as keyof RequestSettings];
  }));
}

function scriptsFromOpenCollection(value: unknown) {
  const scripts = isRecord(value) ? asArray(value.scripts) as ScriptEntry[] : [];
  const before = scripts.filter(script => asText(script.type) === 'before-request').map(script => asText(script.code)).filter(Boolean);
  const after = scripts.filter(script => ['after-response', 'tests'].includes(asText(script.type))).map(script => asText(script.code)).filter(Boolean);
  return { preRequestScript: before.join('\n\n'), testScript: after.join('\n\n') };
}

function collectionDefaultsInputHasSettings(input: CollectionDefaultsInput | undefined) {
  return Boolean(input?.settings && Object.keys(input.settings).length);
}

function mergeCollectionDefaultsInput(base: CollectionDefaultsInput, next: CollectionDefaultsInput): CollectionDefaultsInput {
  return {
    headers: next.headers?.length ? next.headers : base.headers,
    variables: next.variables?.length ? next.variables : base.variables,
    auth: next.auth && authStateHasData(next.auth, next.auth.type) ? next.auth : base.auth,
    preRequestScript: next.preRequestScript || base.preRequestScript,
    testScript: next.testScript || base.testScript,
    settings: {
      ...(base.settings ?? {}),
      ...(collectionDefaultsInputHasSettings(next) ? next.settings : {}),
    },
  };
}

function normalizeCollectionDefaultsInput(input: CollectionDefaultsInput): CollectionDefaults {
  return normalizeCollectionDefaults({
    headers: input.headers ?? [],
    variables: input.variables ?? [],
    auth: input.auth ?? emptyAuthState(),
    preRequestScript: input.preRequestScript ?? '',
    testScript: input.testScript ?? '',
    settings: { ...DEFAULT_REQUEST_SETTINGS, ...(input.settings ?? {}) },
  });
}

function collectionDefaultsFromOpenCollectionDocument(parsed: unknown): CollectionDefaultsInput {
  if (!isRecord(parsed)) return {};
  const http = isRecord(parsed.http) ? parsed.http : {};
  const auth = openCollectionAuth(parsed.auth ?? http.auth);
  const scripts = scriptsFromOpenCollection(parsed.runtime);
  return {
    headers: rowsFromOpenCollectionValue(parsed.headers ?? http.headers),
    variables: rowsFromOpenCollectionValue(parsed.variables ?? parsed.vars ?? parsed.values),
    ...(authStateHasData(auth, auth.type) ? { auth } : {}),
    ...(scripts.preRequestScript ? { preRequestScript: scripts.preRequestScript } : {}),
    ...(scripts.testScript ? { testScript: scripts.testScript } : {}),
    settings: settingsPatchFromOpenCollection(parsed.settings),
  };
}

function authFromBruBlocks(byName: Map<string, string>, authType: string): AuthState {
  const auth = emptyAuthState();
  const type = authType.toLowerCase();
  const values = parseBruKeyValues(byName.get(`auth:${type}`));
  if (type === 'bearer') return { ...auth, type: 'bearer', bearerToken: values.token || '' };
  if (type === 'basic' || type === 'digest') return { ...auth, type: type as 'basic' | 'digest', basicUser: values.username || '', basicPass: values.password || '' };
  if (type === 'apikey') return { ...auth, type: 'apikey', apiKeyName: values.key || values.name || '', apiKeyValue: values.value || '', apiKeyIn: values.placement === 'query' || values.in === 'query' ? 'query' : 'header' };
  if (type === 'oauth2') {
    return {
      ...auth,
      type: 'oauth2',
      oauth2TokenURL: values.tokenUrl || values.accessTokenUrl || '',
      oauth2ClientID: values.clientId || '',
      oauth2Secret: values.clientSecret || '',
      oauth2Scope: values.scope || '',
      oauth2Token: values.accessToken || values.token || '',
    };
  }
  if (type === 'awsv4' || type === 'aws') {
    return {
      ...auth,
      type: 'aws',
      awsAccessKey: values.accessKeyId || values.accessKey || '',
      awsSecretKey: values.secretAccessKey || values.secretKey || '',
      awsRegion: values.region || '',
      awsService: values.service || '',
    };
  }
  return auth;
}

function collectionDefaultsFromBruCollectionFile(file: CollectionTextFile | undefined): CollectionDefaultsInput {
  if (!file) return {};
  const blocks = parseBruBlocks(file.content);
  const byName = new Map(blocks.map(block => [block.name, block.body]));
  const variables = rowsFromBruBlock(byName.get('vars'));
  const secretKeys = new Set((byName.get('vars:secret') || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  for (const row of variables) if (secretKeys.has(row.key)) row.secret = true;
  const authConfig = parseBruKeyValues(byName.get('auth'));
  const authType = (authConfig.mode || authConfig.type || '').toLowerCase();
  const auth = authType && authType !== 'none' && authType !== 'inherit'
    ? authFromBruBlocks(byName, authType)
    : emptyAuthState();
  return {
    headers: rowsFromBruBlock(byName.get('headers')),
    variables,
    ...(authStateHasData(auth, auth.type) ? { auth } : {}),
    preRequestScript: byName.get('script:pre-request') || '',
    testScript: [byName.get('script:post-response'), byName.get('tests')].filter(Boolean).join('\n\n'),
    settings: settingsPatchFromBruBlock(byName.get('settings')),
  };
}

function collectionDefaultsFromFiles(files: CollectionTextFile[]): CollectionDefaults {
  const root = files.find(file => basename(file.path).toLowerCase() === 'opencollection.yml');
  const legacyCollection = files.find(file => basename(file.path).toLowerCase() === 'collection.bru');
  let input: CollectionDefaultsInput = {};
  if (root) input = mergeCollectionDefaultsInput(input, collectionDefaultsFromOpenCollectionDocument(parseYaml(root.content)));
  input = mergeCollectionDefaultsInput(input, collectionDefaultsFromBruCollectionFile(legacyCollection));
  return normalizeCollectionDefaultsInput(input);
}

function collectionDefaultsToOpenCollection(defaults: CollectionDefaults, includeSecrets = false): Record<string, unknown> {
  const normalized = normalizeCollectionDefaults(defaults);
  const runtimeScripts = [
    normalized.preRequestScript ? { type: 'before-request', code: normalized.preRequestScript } : undefined,
    normalized.testScript ? { type: 'tests', code: normalized.testScript } : undefined,
  ].filter(Boolean);
  const settings = settingsToOpenCollection(normalized.settings, true, true);
  return {
    ...(normalized.headers.some(row => row.key || row.value) ? { headers: normalized.headers.filter(row => row.key || row.value).map(row => rowToOpenCollection(row, undefined, includeSecrets)) } : {}),
    ...(normalized.variables.some(row => row.key || row.value) ? { variables: normalized.variables.filter(row => row.key || row.value).map(row => rowToOpenCollection(row, undefined, includeSecrets)) } : {}),
    ...(authStateHasData(normalized.auth, normalized.auth.type) ? { auth: authToOpenCollection(normalized.auth, includeSecrets) } : {}),
    ...(runtimeScripts.length ? { runtime: { scripts: runtimeScripts } } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
  };
}

function requestTypeForOpenCollectionDocument(parsed: Record<string, unknown>, info: Record<string, unknown>): RequestType {
  const explicit = requestTypeFromOpenCollection(info.type ?? parsed.requestType ?? parsed.type);
  if (explicit) return explicit;
  if (isRecord(parsed.grpc)) return 'grpc';
  if (isRecord(parsed.socketio)) return 'socketio';
  if (isRecord(parsed.websocket) || isRecord(parsed.ws)) return 'ws';
  const http = isRecord(parsed.http) ? parsed.http : {};
  const body = isRecord(http.body) ? http.body : {};
  return asText(body.type).toLowerCase() === 'graphql' ? 'graphql' : 'http';
}

function bodyFromRealtimeSection(section: Record<string, unknown>) {
  if (isRecord(section.body)) return bodyFromOpenCollection(section.body);
  const message = asText(section.message ?? section.data);
  if (!message) return { bodyType: 'none' as BodyType, rawBodyType: 'text' as RawBodyType, bodyContent: '', formRows: [] as KVRow[] };
  const bodyType = asText(section.bodyType || 'text').toLowerCase();
  const rawBodyType = (bodyType === 'json' || bodyType === 'xml' || bodyType === 'html' || bodyType === 'text') ? bodyType as RawBodyType : 'text';
  return { bodyType: rawBodyType as BodyType, rawBodyType, bodyContent: message, formRows: [] };
}

function requestFromOpenCollectionFile(file: CollectionTextFile, collectionId: string, collectionName: string, folderPath: string[]): SavedRequest | null {
  const parsed = parseYaml(file.content);
  if (!isRecord(parsed)) return null;
  const info = isRecord(parsed.info) ? parsed.info : {};
  if (asText(info.type) === 'folder') return null;
  const requestType = requestTypeForOpenCollectionDocument(parsed, info);
  const section = requestType === 'grpc'
    ? isRecord(parsed.grpc) ? parsed.grpc : {}
    : requestType === 'socketio'
      ? isRecord(parsed.socketio) ? parsed.socketio : {}
      : requestType === 'ws'
        ? isRecord(parsed.websocket) ? parsed.websocket : isRecord(parsed.ws) ? parsed.ws : {}
        : isRecord(parsed.http) ? parsed.http : {};
  if (!isRecord(section) || !Object.keys(section).length) return null;
  const sectionParams = paramsFromOpenCollection(section.params);
  const method = asText(section.method || (requestType === 'grpc' || requestType === 'graphql' ? 'POST' : 'GET')).toUpperCase();
  const body = requestType === 'grpc'
    ? { bodyType: 'json' as BodyType, rawBodyType: 'json' as RawBodyType, bodyContent: asText(section.message ?? section.body ?? DEFAULT_GRPC_MESSAGE) || DEFAULT_GRPC_MESSAGE, formRows: [] as KVRow[] }
    : requestType === 'ws'
      ? bodyFromRealtimeSection(section)
      : bodyFromOpenCollection(section.body);
  const scripts = scriptsFromOpenCollection(parsed.runtime);
  const settingsPatch = { ...settingsPatchFromOpenCollection(parsed.settings), ...settingsPatchFromOpenCollection(section.settings) };
  const id = newRequestId();
  const name = asText(info.name) || displayNameFromSegment(withoutExtension(file.path));
  const requestTab = requestTabFromOpenCollection(parsed.requestTab ?? info.requestTab)
    || (requestType === 'grpc' ? 'body' : requestType === 'socketio' ? 'events' : requestType === 'ws' ? 'body' : requestType === 'graphql' ? 'query' : 'params');
  const grpcUseReflection = requestType === 'grpc' ? booleanSetting(section.useReflection) : undefined;
  const requestSettingsPatch = { ...settingsPatch, ...(grpcUseReflection !== undefined ? { grpcUseReflection } : {}) };
  const examples = examplesFromOpenCollection(parsed.examples, id);
  return {
    id,
    name,
    filesystemName: filesystemNameFromName(name, id),
    collectionId,
    collection: collectionName,
    folderPath,
    method: requestType === 'grpc' ? 'POST' : HTTP_METHODS.has(method as Method) ? method as Method : 'GET',
    url: asText(section.url ?? section.target),
    requestTab,
    params: requestType === 'grpc' ? [] : sectionParams.query,
    ...importedPathParams(requestType, asText(section.url ?? section.target), sectionParams.path),
    headers: requestType === 'grpc' ? [] : rowsFromOpenCollectionList(section.headers).filter(row => row.key || row.value),
    auth: openCollectionAuth(section.auth),
    ...body,
    requestType,
    bodyFilePath: body.bodyType === 'binary' ? body.bodyContent : '',
    bodyFileName: body.bodyType === 'binary' ? basename(body.bodyContent) : '',
    graphqlSchema: '',
    ...(requestType === 'socketio' ? {
      sioEvents: rowsFromOpenCollectionList(section.events ?? section.listenEvents),
      sioArgs: sioArgsFromOpenCollection(section.args),
      sioAck: booleanSetting(section.ack) ?? false,
    } : {}),
    ...(requestType === 'grpc' ? {
      grpcMethod: asText(section.method ?? section.fullMethod),
      grpcMetadata: rowsFromOpenCollectionValue(section.metadata ?? section.headers).filter(row => row.key || row.value),
      grpcUseReflection: requestSettingsPatch.grpcUseReflection ?? true,
      grpcProtoFilePath: asText(section.protoFilePath),
      grpcProtoFileName: asText(section.protoFileName),
      grpcProtoImportPaths: asArray(section.protoImportPaths).map(asText).filter(Boolean),
    } : {}),
    ...scripts,
    requestNotes: asText(parsed.docs),
    settings: { ...DEFAULT_REQUEST_SETTINGS, ...requestSettingsPatch },
    settingsOverrides: requestSettingsOverridesFromPatch(requestSettingsPatch),
    ...(examples.length ? { examples } : {}),
  };
}

function examplesFromOpenCollection(value: unknown, requestId: string): RequestExample[] {
  return asArray(value)
    .filter(isRecord)
    .map(entry => normalizeRequestExample(entry as Partial<RequestExample>, requestId));
}

function examplesToOpenCollection(
  req: SavedRequest,
  stripFn: (source: string, bodyType: string) => string,
  includeSecrets = false,
) {
  const examples = req.examples ?? [];
  if (!examples.length) return undefined;
  const rows = (list: KVRow[]) => list.filter(row => row.key).map(row => ({ key: row.key, value: row.value }));
  return examples.map(example => ({
    name: example.name,
    source: example.source,
    snapshot: {
      method: example.snapshot.method,
      url: safeExportUrl(example.snapshot.url, includeSecrets),
      ...(example.snapshot.params.length ? { params: rows(example.snapshot.params) } : {}),
      ...(example.snapshot.headers.length ? { headers: rows(example.snapshot.headers.map(row => safeExportRow(row, includeSecrets))) } : {}),
      bodyType: example.snapshot.bodyType,
      ...(example.snapshot.bodyContent ? { bodyContent: exportBodyLikeValue(example.snapshot.bodyContent, example.snapshot.bodyType, stripFn, includeSecrets) } : {}),
    },
    response: {
      statusCode: example.response.statusCode,
      status: example.response.status,
      ...(example.response.headers.length ? { headers: rows(example.response.headers.map(row => safeExportRow(row, includeSecrets))) } : {}),
      bodyMediaType: example.response.bodyMediaType,
      ...(example.response.body ? { body: exportBodyLikeValue(example.response.body, 'json', stripFn, includeSecrets) } : {}),
    },
    match: example.match,
  }));
}

function folderNameMapFromOpenCollection(files: CollectionTextFile[]) {
  const names = new Map<string, string>();
  for (const file of files) {
    if (basename(file.path).toLowerCase() !== 'folder.yml') continue;
    const parsed = parseYaml(file.content);
    if (!isRecord(parsed) || !isRecord(parsed.info)) continue;
    const name = asText(parsed.info.name);
    if (name) names.set(dirname(file.path), name);
  }
  return names;
}

function folderPathForFile(path: string, folderNames: Map<string, string>) {
  const dir = dirname(path);
  if (!dir || dir === 'environments') return [];
  const parts = dir.split('/').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const key = parts.slice(0, i + 1).join('/');
    out.push(folderNames.get(key) ?? displayNameFromSegment(parts[i]));
  }
  return out;
}

function folderPathsFromFolderFiles(folderNames: Map<string, string>) {
  return [...folderNames.keys()]
    .sort((left, right) => left.localeCompare(right))
    .map(path => folderPathForFile(`${path}/__request__.yml`, folderNames))
    .filter(path => path.length);
}

function environmentFromYamlFile(file: CollectionTextFile, workspaceId: string): Environment | null {
  const parsed = parseYaml(file.content);
  if (!isRecord(parsed)) return null;
  const info = isRecord(parsed.info) ? parsed.info : {};
  const name = asText(info.name ?? parsed.name) || displayNameFromSegment(withoutExtension(file.path));
  const rawVars = parsed.variables ?? parsed.vars ?? parsed.values;
  const values: KVRow[] = [];
  if (Array.isArray(rawVars)) values.push(...rowsFromOpenCollectionList(rawVars));
  else if (isRecord(rawVars)) {
    for (const [key, value] of Object.entries(rawVars)) values.push({ ...mkRow(), key, value: asText(value), enabled: true });
  }
  return {
    id: newEntityId('env'),
    workspaceId,
    name,
    filesystemName: fileSegment(name, 'environment'),
    values,
  };
}

function parseBruBlocks(source: string) {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const blocks: Array<{ name: string; body: string }> = [];
  let cursor = 0;
  while (cursor < lines.length) {
    const match = lines[cursor].match(/^([A-Za-z0-9_.:-]+)\s*\{\s*$/);
    if (!match) {
      cursor += 1;
      continue;
    }
    const name = match[1];
    const body: string[] = [];
    cursor += 1;
    while (cursor < lines.length && !/^}\s*$/.test(lines[cursor])) {
      body.push(lines[cursor].replace(/^ {2}/, ''));
      cursor += 1;
    }
    blocks.push({ name, body: body.join('\n').trim() });
    cursor += 1;
  }
  return blocks;
}

function parseBruKeyValues(block = '') {
  const values: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(':');
    if (index < 0) continue;
    values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return values;
}

function requestFromBruFile(file: CollectionTextFile, collectionId: string, collectionName: string, folderPath: string[]): SavedRequest | null {
  const blocks = parseBruBlocks(file.content);
  const byName = new Map(blocks.map(block => [block.name, block.body]));
  const meta = parseBruKeyValues(byName.get('meta'));
  const methodBlock = blocks.find(block => BRU_METHODS.has(block.name.toLowerCase()));
  const typedBlock = blocks.find(block => BRU_REQUEST_BLOCKS.has(block.name.toLowerCase()));
  if (!methodBlock && !typedBlock) return null;
  const requestType = requestTypeFromOpenCollection(meta.type)
    || requestTypeFromOpenCollection(typedBlock?.name)
    || (byName.has('body:graphql') ? 'graphql' : 'http');
  const requestBlock = typedBlock ?? methodBlock;
  const methodConfig = parseBruKeyValues(requestBlock?.body);
  const method = methodBlock?.name.toUpperCase() ?? (requestType === 'grpc' || requestType === 'graphql' ? 'POST' : 'GET');
  const bodyMode = (methodConfig.body
    || (byName.has('body:graphql') ? 'graphql' : '')
    || (byName.has('body:json') ? 'json' : '')
    || (byName.has('body:text') ? 'text' : '')
    || (byName.has('body:xml') ? 'xml' : '')
    || (byName.has('body:html') ? 'html' : '')
    || (byName.has('body:form-urlencoded') ? 'form-urlencoded' : '')
    || (byName.has('body:multipart-form') ? 'multipart-form' : '')
    || (byName.has('body') ? 'json' : 'none')).toLowerCase();
  let bodyContent = byName.get(`body:${bodyMode}`) ?? (bodyMode === 'json' ? byName.get('body') ?? '' : '');
  let bodyType: BodyType = 'none';
  let rawBodyType: RawBodyType = 'json';
  let formRows: KVRow[] = [];
  if (bodyMode === 'json' || bodyMode === 'xml' || bodyMode === 'text' || bodyMode === 'html') {
    bodyType = bodyMode as BodyType;
    rawBodyType = bodyMode as RawBodyType;
  } else if (bodyMode === 'form-urlencoded') {
    bodyType = 'urlencoded';
    formRows = rowsFromBruBlock(bodyContent);
  } else if (bodyMode === 'multipart-form') {
    bodyType = 'form';
    formRows = rowsFromBruBlock(bodyContent);
  } else if (bodyMode === 'graphql') {
    bodyType = 'graphql';
    rawBodyType = 'json';
    bodyContent = JSON.stringify({
      query: bodyContent,
      variables: safeParseJSON(byName.get('body:graphql:vars') ?? '{}', {}),
    }, null, 2);
  }
  const authType = (methodConfig.auth || 'none').toLowerCase();
  const auth = authType === 'inherit' ? inheritAuthState() : authType === 'none' ? emptyAuthState() : authFromBruBlocks(byName, authType);
  const settingsPatch = settingsPatchFromBruBlock(byName.get('settings'));
  const id = newRequestId();
  const name = meta.name || displayNameFromSegment(withoutExtension(file.path));
  const grpcUseReflection = requestType === 'grpc' ? booleanSetting(methodConfig.useReflection) : undefined;
  const requestSettingsPatch = { ...settingsPatch, ...(grpcUseReflection !== undefined ? { grpcUseReflection } : {}) };
  return {
    id,
    name,
    filesystemName: filesystemNameFromName(name, id),
    collectionId,
    collection: collectionName,
    folderPath,
    method: requestType === 'grpc' ? 'POST' : HTTP_METHODS.has(method as Method) ? method as Method : 'GET',
    url: methodConfig.url || methodConfig.target || '',
    requestTab: requestType === 'grpc' ? 'body' : requestType === 'socketio' ? 'events' : requestType === 'ws' ? 'body' : requestType === 'graphql' ? 'query' : 'params',
    params: requestType === 'grpc' ? [] : rowsFromBruBlock(byName.get('params:query') || byName.get('query') || byName.get('params')),
    ...importedPathParams(requestType, methodConfig.url || methodConfig.target || '', rowsFromBruBlock(byName.get('params:path'))),
    headers: requestType === 'grpc' ? [] : rowsFromBruBlock(byName.get('headers')),
    auth,
    requestType,
    bodyType: requestType === 'grpc' && bodyType === 'none' ? 'json' : bodyType,
    rawBodyType,
    bodyContent: requestType === 'grpc' ? bodyContent || byName.get('message') || DEFAULT_GRPC_MESSAGE : bodyContent,
    bodyFilePath: '',
    bodyFileName: '',
    graphqlSchema: '',
    formRows,
    ...(requestType === 'socketio' ? {
      sioEvents: rowsFromBruBlock(byName.get('events')),
      sioArgs: bodyContent ? [{ id: newRequestId(), content: bodyContent, bodyType: rawBodyType, encoding: 'base64' as const }] : [],
      sioAck: booleanSetting(methodConfig.ack) ?? false,
    } : {}),
    ...(requestType === 'grpc' ? {
      grpcMethod: methodConfig.method || methodConfig.fullMethod || methodConfig.rpc || '',
      grpcMetadata: rowsFromBruBlock(byName.get('metadata') || byName.get('headers')),
      grpcUseReflection: requestSettingsPatch.grpcUseReflection ?? true,
      grpcProtoFilePath: methodConfig.protoFilePath || '',
      grpcProtoFileName: methodConfig.protoFileName || '',
      grpcProtoImportPaths: methodConfig.protoImportPaths ? methodConfig.protoImportPaths.split(',').map(path => path.trim()).filter(Boolean) : [],
    } : {}),
    preRequestScript: byName.get('script:pre-request') || '',
    testScript: [byName.get('script:post-response'), byName.get('tests')].filter(Boolean).join('\n\n'),
    requestNotes: byName.get('docs') || '',
    settings: { ...DEFAULT_REQUEST_SETTINGS, ...requestSettingsPatch },
    settingsOverrides: requestSettingsOverridesFromPatch(requestSettingsPatch),
  };
}

function environmentFromBruFile(file: CollectionTextFile, workspaceId: string): Environment | null {
  const blocks = parseBruBlocks(file.content);
  const byName = new Map(blocks.map(block => [block.name, block.body]));
  const vars = rowsFromBruBlock(byName.get('vars'));
  const secretKeys = new Set((byName.get('vars:secret') || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  for (const row of vars) if (secretKeys.has(row.key)) row.secret = true;
  const name = displayNameFromSegment(withoutExtension(file.path));
  return {
    id: newEntityId('env'),
    workspaceId,
    name,
    filesystemName: fileSegment(name, 'environment'),
    values: vars,
  };
}

function safeParseJSON(source: string, fallback: unknown) {
  try {
    return JSON.parse(source);
  } catch {
    return fallback;
  }
}

function exportBodyLikeValue(source: string, bodyType: string, stripFn: (source: string, bodyType: string) => string, includeSecrets = false) {
  const stripped = stripFn(source, bodyType);
  if (includeSecrets) return stripped;
  if (bodyType === 'json') {
    try {
      return JSON.stringify(sanitizeExportExample(JSON.parse(stripped), includeSecrets), null, 2);
    } catch {}
  }
  return safeExportValue('body', stripped, includeSecrets);
}

function rootCollectionName(files: CollectionTextFile[], fallbackName: string) {
  const root = files.find(file => basename(file.path).toLowerCase() === 'opencollection.yml');
  if (root) {
    const parsed = parseYaml(root.content);
    if (isRecord(parsed) && isRecord(parsed.info) && asText(parsed.info.name)) return asText(parsed.info.name);
  }
  const bruno = files.find(file => basename(file.path).toLowerCase() === 'bruno.json');
  if (bruno) {
    const parsed = safeParseJSON(bruno.content, {});
    if (isRecord(parsed) && asText(parsed.name)) return asText(parsed.name);
  }
  return fallbackName || 'Bruno Collection';
}

function rootCollectionDescription(files: CollectionTextFile[]) {
  const root = files.find(file => basename(file.path).toLowerCase() === 'opencollection.yml');
  if (root) {
    const parsed = parseYaml(root.content);
    if (isRecord(parsed) && asText(parsed.docs)) return asText(parsed.docs);
  }
  const legacyCollection = files.find(file => basename(file.path).toLowerCase() === 'collection.bru');
  if (legacyCollection) {
    const blocks = parseBruBlocks(legacyCollection.content);
    const docs = blocks.find(block => block.name === 'docs')?.body;
    if (docs) return docs;
  }
  return '';
}

export function openCollectionBundleFromFiles(files: CollectionTextFile[], collectionId: string, fallbackName: string, workspaceId: string): OpenCollectionImportBundle {
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
  const name = rootCollectionName(sorted, fallbackName);
  const description = rootCollectionDescription(sorted);
  const defaults = collectionDefaultsFromFiles(sorted);
  const folderNames = folderNameMapFromOpenCollection(sorted);
  const requests: SavedRequest[] = [];
  const environments: Environment[] = [];
  for (const file of sorted) {
    const path = file.path.replace(/\\/g, '/');
    const base = basename(path).toLowerCase();
    const ext = base.replace(/^.*(\.[^.]+)$/, '$1');
    if (path.toLowerCase().startsWith('environments/')) {
      const env = ext === '.bru' ? environmentFromBruFile(file, workspaceId) : environmentFromYamlFile(file, workspaceId);
      if (env) environments.push(env);
      continue;
    }
    if (base === 'opencollection.yml' || base === 'bruno.json' || base === 'collection.bru' || base === 'folder.yml' || base === 'folder.bru') continue;
    const folderPath = folderPathForFile(path, folderNames);
    const request = ext === '.bru'
      ? requestFromBruFile(file, collectionId, name, folderPath)
      : requestFromOpenCollectionFile(file, collectionId, name, folderPath);
    if (request && request.url.trim()) requests.push(request);
  }
  const folderPaths = folderPathsFromFolderFiles(folderNames);
  if (!requests.length && !folderPaths.length) throw new Error('No Bruno/OpenCollection requests found');
  return { name, description, defaults, folderPaths, requests, environments };
}

function yamlScalar(value: unknown, indent: number): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = asText(value);
  if (text.includes('\n')) {
    const pad = ' '.repeat(indent + 2);
    return `|-\n${text.split('\n').map(line => `${pad}${line}`).join('\n')}`;
  }
  if (!text) return '""';
  if (/^[A-Za-z_./$][A-Za-z0-9_./:@{}$ -]*$/.test(text) && !/^(true|false|null|~)$/i.test(text) && !/ $/.test(text) && !text.includes(': ')) return text;
  return JSON.stringify(text);
}

function yamlValue(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value.map(item => {
      if (isRecord(item)) {
        const rendered = yamlMap(item, indent + 2);
        return `${pad}- ${rendered.trimStart()}`;
      }
      return `${pad}- ${yamlScalar(item, indent)}`;
    }).join('\n');
  }
  if (isRecord(value)) return `\n${yamlMap(value, indent + 2)}`;
  return yamlScalar(value, indent);
}

function yamlMap(value: Record<string, unknown>, indent = 0): string {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw)) {
      lines.push(raw.length ? `${pad}${key}:\n${yamlValue(raw, indent + 2)}` : `${pad}${key}: []`);
    } else if (isRecord(raw)) {
      lines.push(`${pad}${key}:\n${yamlMap(raw, indent + 2)}`);
    } else {
      lines.push(`${pad}${key}: ${yamlScalar(raw, indent)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function requestToOpenCollection(req: SavedRequest, seq: number, stripFn: (source: string, bodyType: string) => string, includeSecrets = false) {
  const examples = examplesToOpenCollection(req, stripFn, includeSecrets);
  const body = bodyToOpenCollection(req, stripFn, includeSecrets);
  const settings = settingsToOpenCollection(req.settings, true, true, req.settingsOverrides);
  const runtimeScripts = [
    req.preRequestScript ? { type: 'before-request', code: req.preRequestScript } : undefined,
    req.testScript ? { type: 'tests', code: req.testScript } : undefined,
  ].filter(Boolean);
  const requestType = req.requestType ?? (req.bodyType === 'graphql' ? 'graphql' : 'http');
  const exportParams = [
    ...req.params.filter(row => row.key || row.value).map(row => rowToOpenCollection(row, 'query', includeSecrets)),
    ...(req.pathParams ?? []).filter(row => row.key).map(row => rowToOpenCollection(row, 'path', includeSecrets)),
  ];
  const common = {
    url: safeExportUrl(req.url, includeSecrets),
    ...(exportParams.length ? { params: exportParams } : {}),
    ...(req.headers.some(row => row.key || row.value) ? { headers: req.headers.filter(row => row.key || row.value).map(row => rowToOpenCollection(row, undefined, includeSecrets)) } : {}),
    auth: authToOpenCollection(req.auth, includeSecrets),
  };
  const requestSection = requestType === 'grpc'
    ? {
        grpc: {
          target: safeExportUrl(req.url, includeSecrets),
          method: req.grpcMethod ?? '',
          message: exportBodyLikeValue(req.bodyContent || DEFAULT_GRPC_MESSAGE, req.bodyType || 'json', stripFn, includeSecrets),
          auth: authToOpenCollection(req.auth, includeSecrets),
          ...(req.grpcMetadata?.some(row => row.key || row.value) ? { metadata: req.grpcMetadata.filter(row => row.key || row.value).map(row => rowToOpenCollection(row, undefined, includeSecrets)) } : {}),
          useReflection: req.settings.grpcUseReflection ?? req.grpcUseReflection ?? true,
          ...(req.grpcProtoFilePath ? { protoFilePath: req.grpcProtoFilePath } : {}),
          ...(req.grpcProtoFileName ? { protoFileName: req.grpcProtoFileName } : {}),
          ...(req.grpcProtoImportPaths?.length ? { protoImportPaths: req.grpcProtoImportPaths } : {}),
        },
      }
    : requestType === 'socketio'
      ? {
          socketio: {
            ...common,
            ...(req.sioEvents?.some(row => row.key || row.value) ? { events: req.sioEvents.filter(row => row.key || row.value).map(row => rowToOpenCollection(row, undefined, includeSecrets)) } : {}),
            ...(req.sioArgs?.length ? { args: req.sioArgs.map(arg => ({ id: arg.id, content: exportBodyLikeValue(arg.content, arg.bodyType, stripFn, includeSecrets), bodyType: arg.bodyType, encoding: arg.encoding })) } : {}),
            ack: req.sioAck ?? false,
          },
        }
      : requestType === 'ws'
        ? { websocket: { ...common, ...(body ? { body } : {}) } }
        : {
            http: {
              method: req.bodyType === 'graphql' ? 'POST' : req.method,
              ...common,
              ...(body ? { body } : {}),
            },
          };
  return {
    info: { name: req.name, type: requestType === 'ws' ? 'websocket' : requestType, seq },
    ...requestSection,
    ...(runtimeScripts.length ? { runtime: { scripts: runtimeScripts } } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
    ...(examples ? { examples } : {}),
    ...(req.requestNotes ? { docs: `${req.requestNotes}\n` } : {}),
  };
}

export function buildOpenCollectionFiles(
  collectionName: string,
  description: string,
  defaults: CollectionDefaults,
  requests: SavedRequest[],
  environments: Environment[],
  stripFn: (source: string, bodyType: string) => string,
  includeSecrets = false,
  folderPaths: string[][] = [],
): CollectionTextFile[] {
  const files: CollectionTextFile[] = [{
    path: 'opencollection.yml',
    content: yamlMap({
      info: { name: collectionName, schema: 'https://schema.opencollection.com' },
      ...(description ? { docs: description } : {}),
      ...collectionDefaultsToOpenCollection(defaults, includeSecrets),
    }),
  }];
  const seen = new Set(files.map(file => file.path));
  const ensureUnique = (path: string) => {
    if (!seen.has(path)) {
      seen.add(path);
      return path;
    }
    const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')) : '';
    const base = ext ? path.slice(0, -ext.length) : path;
    for (let i = 2; ; i += 1) {
      const candidate = `${base}-${i}${ext}`;
      if (!seen.has(candidate)) {
        seen.add(candidate);
        return candidate;
      }
    }
  };
  const folderSeq = new Map<string, number>();
  const writeFolderFiles = (folderPath: string[]) => {
    const folderSegments: string[] = [];
    for (const folder of folderPath) {
      folderSegments.push(fileSegment(folder, 'folder'));
      const path = folderSegments.join('/');
      if (!seen.has(`${path}/folder.yml`)) {
        seen.add(`${path}/folder.yml`);
        folderSeq.set(path, folderSeq.size + 1);
        files.push({
          path: `${path}/folder.yml`,
          content: yamlMap({ info: { name: folder, type: 'folder', seq: folderSeq.get(path) } }),
        });
      }
    }
    return folderSegments;
  };
  for (const path of folderPaths) writeFolderFiles(path);
  const sortedRequests = [...requests].sort((left, right) => (left.folderPath ?? []).join('/').localeCompare((right.folderPath ?? []).join('/')) || left.name.localeCompare(right.name));
  sortedRequests.forEach((req, index) => {
    const folderSegments = writeFolderFiles(req.folderPath ?? []);
    const requestPath = ensureUnique(`${folderSegments.length ? `${folderSegments.join('/')}/` : ''}${fileSegment(req.name, 'request')}.yml`);
    files.push({ path: requestPath, content: yamlMap(requestToOpenCollection(req, index + 1, stripFn, includeSecrets)) });
  });
  for (const env of environments) {
    const variables = env.values.filter(row => row.key || row.value).map(row => rowToOpenCollection(row, undefined, includeSecrets));
    files.push({
      path: ensureUnique(`environments/${fileSegment(env.name, 'environment')}.yml`),
      content: yamlMap({ info: { name: env.name, type: 'environment' }, variables }),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
