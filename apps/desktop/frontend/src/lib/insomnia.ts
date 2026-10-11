import type { AuthType, BodyType, KVRow, Method, RawBodyType, RequestSettings, RequestTab, RequestType, SavedRequest, SIOArg } from './types/models';
import { DEFAULT_REQUEST_SETTINGS, mkRow } from './constants';
import { asArray, asText, isRecord, newRequestId } from './utils';
import { emptyAuthState } from './utils';
import { parseGraphQLPayload, parseGraphQLVariables, serializeGraphQLPayload } from './graphql';
import { filterSocketIOTransportParams, graphQLBodyContentFromJsonText, isWebSocketUrl, socketIOImportDetails } from './importDetection';
import { filesystemNameFromName } from './normalizers';
import { DEFAULT_GRPC_MESSAGE } from './requestBodyDefaults';
import { safeExportRow, safeExportUrl, safeExportValue, sanitizeExportExample } from './secretExport';

const KURLO_REQUEST_TYPES = new Set<RequestType>(['http', 'graphql', 'ws', 'socketio', 'grpc', 'mcp']);
const KURLO_REQUEST_TABS = new Set<RequestTab>(['docs', 'params', 'query', 'auth', 'headers', 'metadata', 'body', 'schema', 'service', 'events', 'scripts', 'settings']);

function resourceType(resource: Record<string, unknown>) {
  return asText(resource.type || resource._type);
}

function resourceId(resource: Record<string, unknown>) {
  return asText(resource.id || resource._id);
}

function isRequestResource(resource: Record<string, unknown>) {
  const type = resourceType(resource).toLowerCase();
  return type === 'request' || type.includes('websocket') || type.includes('socketio') || type.includes('socket_io') || type.includes('socket.io') || type.includes('grpc');
}

function isSocketIOResource(resource: Record<string, unknown>) {
  const type = resourceType(resource).toLowerCase();
  return type.includes('socketio') || type.includes('socket_io') || type.includes('socket.io');
}

function isWebSocketResource(resource: Record<string, unknown>) {
  return resourceType(resource).toLowerCase().includes('websocket');
}

function isGrpcResource(resource: Record<string, unknown>) {
  return resourceType(resource).toLowerCase().includes('grpc');
}

function parentId(resource: Record<string, unknown>) {
  return asText(resource.parentId || resource.parent_id);
}

function row(key: string, value: string, enabled = true, description = '', isFile = false, contentType = ''): KVRow {
  return { ...mkRow(), key, value, enabled, description, isFile, fileName: isFile ? value.split('/').pop() ?? value : '', contentType };
}

function insomniaRows(list: unknown, keyNames = ['name', 'key']) {
  return asArray(list).map(item => {
    if (!isRecord(item)) return null;
    const key = keyNames.map(name => asText(item[name])).find(Boolean) ?? '';
    if (!key) return null;
    return row(key, asText(item.value), item.disabled !== true, asText(item.description));
  }).filter((item): item is KVRow => Boolean(item));
}

function folderPathFor(resource: Record<string, unknown>, byId: Map<string, Record<string, unknown>>) {
  const path: string[] = [];
  let currentParent = parentId(resource);
  const seen = new Set<string>();
  while (currentParent && !seen.has(currentParent)) {
    seen.add(currentParent);
    const parent = byId.get(currentParent);
    if (!parent) break;
    const type = resourceType(parent);
    if (type === 'request_group' || type === 'folder') path.unshift(asText(parent.name) || 'Folder');
    currentParent = parentId(parent);
  }
  return path;
}

function authConfig(resource: Record<string, unknown>): SavedRequest['auth'] {
  const auth = isRecord(resource.authentication) ? resource.authentication : isRecord(resource.auth) ? resource.auth : {};
  const config = emptyAuthState();
  const type = asText(auth.type).toLowerCase();
  if (!type || type === 'none') return config;
  if (type === 'bearer' || type === 'bearer-token') {
    config.type = 'bearer';
    config.bearerToken = asText(auth.token || auth.value);
  } else if (type === 'basic' || type === 'digest') {
    config.type = type as AuthType;
    config.basicUser = asText(auth.username || auth.user);
    config.basicPass = asText(auth.password || auth.pass);
  } else if (type === 'apikey' || type === 'api_key') {
    config.type = 'apikey';
    config.apiKeyName = asText(auth.key || auth.name) || 'X-API-Key';
    config.apiKeyValue = asText(auth.value);
    config.apiKeyIn = asText(auth.addTo || auth.in) === 'query' ? 'query' : 'header';
  } else if (type === 'oauth2') {
    config.type = 'oauth2';
    config.oauth2Token = asText(auth.accessToken || auth.token);
    config.bearerToken = config.oauth2Token;
    config.oauth2ClientID = asText(auth.clientId);
    config.oauth2Secret = asText(auth.clientSecret);
    config.oauth2Scope = asText(auth.scope);
    config.oauth2TokenURL = asText(auth.accessTokenUrl || auth.tokenUrl);
  } else if (type === 'aws' || type === 'awsv4' || type === 'iam') {
    config.type = 'aws';
    config.awsAccessKey = asText(auth.accessKeyId || auth.accessKey);
    config.awsSecretKey = asText(auth.secretAccessKey || auth.secretKey);
    config.awsRegion = asText(auth.region);
    config.awsService = asText(auth.service);
  }
  return config;
}

function rawTypeFromMime(mime: string): RawBodyType {
  const lower = mime.toLowerCase();
  if (lower.includes('json')) return 'json';
  if (lower.includes('xml')) return 'xml';
  if (lower.includes('html')) return 'html';
  return 'text';
}

function bodyFromResource(resource: Record<string, unknown>) {
  const result = { bodyType: 'none' as BodyType, rawBodyType: 'json' as RawBodyType, bodyContent: '', formRows: [] as KVRow[], bodyFilePath: '', bodyFileName: '' };
  const body = isRecord(resource.body) ? resource.body : {};
  const mime = asText(body.mimeType || resource.mimeType);
  const params = asArray(body.params);
  if (params.length) {
    const rows = params.map(item => {
      if (!isRecord(item)) return null;
      const key = asText(item.name || item.key);
      if (!key) return null;
      const isFile = asText(item.type) === 'file' || Boolean(item.fileName);
      return row(key, asText(item.fileName || item.value), item.disabled !== true, asText(item.description), isFile, asText(item.contentType));
    }).filter((item): item is KVRow => Boolean(item));
    result.bodyType = mime.toLowerCase().includes('x-www-form-urlencoded') ? 'urlencoded' : 'form';
    result.formRows = rows;
    return result;
  }
  const text = body.text !== undefined ? asText(body.text) : typeof resource.body === 'string' ? resource.body : '';
  if (text) {
    if (mime.toLowerCase().includes('graphql')) {
      const variablesValue = body.variables ?? resource.variables ?? resource.graphqlVariables;
      result.bodyType = 'graphql';
      result.rawBodyType = 'json';
      result.bodyContent = serializeGraphQLPayload({
        query: text,
        variables:
          typeof variablesValue === 'string'
            ? variablesValue
            : variablesValue === undefined
              ? '{}'
              : JSON.stringify(variablesValue, null, 2),
        operationName: asText(body.operationName || resource.operationName)
      });
      return result;
    }
    const graphqlJson = graphQLBodyContentFromJsonText(text);
    if (graphqlJson) {
      result.bodyType = 'graphql';
      result.rawBodyType = 'json';
      result.bodyContent = graphqlJson;
      return result;
    }
    const rawType = rawTypeFromMime(mime);
    result.bodyType = rawType;
    result.rawBodyType = rawType;
    result.bodyContent = text;
  }
  return result;
}

function kurloExtension(resource: Record<string, unknown>): Record<string, unknown> {
  const value = resource.kurlo ?? resource['x-kurlo'];
  return isRecord(value) ? value : {};
}

function kurloRequestType(value: unknown): RequestType | '' {
  const type = asText(value).toLowerCase();
  return KURLO_REQUEST_TYPES.has(type as RequestType) ? type as RequestType : '';
}

function kurloRequestTab(value: unknown): RequestTab | '' {
  const tab = asText(value).toLowerCase();
  return KURLO_REQUEST_TABS.has(tab as RequestTab) ? tab as RequestTab : '';
}

function kurloSettings(value: unknown): Partial<RequestSettings> {
  return isRecord(value) ? value as Partial<RequestSettings> : {};
}

function kurloSIOArgs(value: unknown): SIOArg[] {
  return asArray(value).map(item => {
    if (!isRecord(item)) return null;
    return {
      id: asText(item.id) || newRequestId(),
      content: asText(item.content),
      bodyType: (['text', 'json', 'html', 'xml', 'binary'].includes(asText(item.bodyType)) ? asText(item.bodyType) : 'text') as SIOArg['bodyType'],
      encoding: asText(item.encoding) === 'hex' ? 'hex' : 'base64',
    };
  }).filter((item): item is SIOArg => Boolean(item));
}

export function insomniaCollectionName(payload: unknown, fileName: string) {
  const resources = isRecord(payload) ? asArray(payload.resources).filter(isRecord) : [];
  const workspace = resources.find(resource => resourceType(resource) === 'workspace');
  return asText(workspace?.name) || fileName.replace(/\.json$/i, '') || 'Insomnia Import';
}

export function insomniaRequestsFromResources(payload: unknown, collectionId: string, collectionName: string): SavedRequest[] {
  if (!isRecord(payload) || !Array.isArray(payload.resources)) throw new Error('Expected an Insomnia export JSON file');
  const resources = payload.resources.filter(isRecord);
  const byId = new Map<string, Record<string, unknown>>();
  for (const resource of resources) {
    const id = resourceId(resource);
    if (id) byId.set(id, resource);
  }
  const requestResources = resources.filter(isRequestResource);
  return requestResources.map(resource => {
    const body = bodyFromResource(resource);
    const headers = insomniaRows(resource.headers);
    const url = asText(resource.url);
    const socketIO = socketIOImportDetails(url);
    const kurlo = kurloExtension(resource);
    const requestType = kurloRequestType(kurlo.requestType) || (isGrpcResource(resource) ? 'grpc' : body.bodyType === 'graphql' ? 'graphql' : socketIO || isSocketIOResource(resource) ? 'socketio' : isWebSocketResource(resource) || isWebSocketUrl(url) ? 'ws' : 'http');
    const params = requestType === 'socketio' ? filterSocketIOTransportParams(insomniaRows(resource.parameters)) : insomniaRows(resource.parameters);
    const sioArgs = requestType === 'socketio' && kurloSIOArgs(kurlo.sioArgs).length
      ? kurloSIOArgs(kurlo.sioArgs)
      : requestType === 'socketio' && body.bodyContent.trim()
      ? [{ id: newRequestId(), content: body.bodyContent, bodyType: body.rawBodyType, encoding: 'base64' as const }]
      : undefined;
    const id = newRequestId();
    const name = asText(resource.name) || 'Imported Request';
    const grpcMethod = asText(kurlo.grpcMethod ?? kurlo.fullMethod ?? resource.protoMethodName ?? resource.grpcMethod);
    const grpcMetadata = insomniaRows(kurlo.grpcMetadata ?? kurlo.metadata ?? resource.metadata);
    const kurloTab = kurloRequestTab(kurlo.requestTab);
    return {
      id,
      name,
      filesystemName: filesystemNameFromName(name, id),
      collectionId,
      collection: collectionName,
      folderPath: folderPathFor(resource, byId),
      requestType,
      method: (requestType === 'graphql' || requestType === 'grpc' ? 'POST' : asText(resource.method).toUpperCase() || 'GET') as Method,
      url: asText(kurlo.url) || socketIO?.url || url,
      requestTab: kurloTab || (requestType === 'grpc' ? 'body' : requestType === 'socketio' ? 'events' : requestType === 'ws' ? 'body' : requestType === 'graphql' ? 'query' : body.bodyType !== 'none' ? 'body' : headers.length ? 'headers' : params.length ? 'params' : 'docs'),
      params,
      headers,
      auth: authConfig(resource),
      bodyType: requestType === 'grpc' && body.bodyType === 'none' ? 'json' : body.bodyType,
      rawBodyType: body.rawBodyType,
      bodyContent: requestType === 'grpc' ? asText(kurlo.message) || body.bodyContent : body.bodyContent || asText(kurlo.message),
      bodyFilePath: body.bodyFilePath,
      bodyFileName: body.bodyFileName,
      formRows: body.formRows,
      ...(sioArgs ? { sioArgs } : {}),
      ...(Array.isArray(kurlo.sioEvents) ? { sioEvents: insomniaRows(kurlo.sioEvents) } : {}),
      ...(typeof kurlo.sioAck === 'boolean' ? { sioAck: kurlo.sioAck } : {}),
      ...(requestType === 'grpc' ? {
        grpcMethod,
        grpcMetadata,
        grpcUseReflection: typeof kurlo.grpcUseReflection === 'boolean' ? kurlo.grpcUseReflection : undefined,
        grpcProtoFilePath: asText(kurlo.grpcProtoFilePath),
        grpcProtoFileName: asText(kurlo.grpcProtoFileName),
        grpcProtoImportPaths: asArray(kurlo.grpcProtoImportPaths).map(asText).filter(Boolean),
      } : {}),
      preRequestScript: asText(resource.preRequestScript),
      testScript: asText(resource.afterResponseScript),
      requestNotes: asText(resource.description),
      settings: { ...DEFAULT_REQUEST_SETTINGS, ...(socketIO?.settings ?? {}), ...kurloSettings(kurlo.settings) },
    };
  });
}

function insomniaRow(row: KVRow, includeSecrets = false) {
  const safeRow = safeExportRow(row, includeSecrets);
  return {
    name: safeRow.key,
    value: safeRow.value,
    ...(safeRow.description ? { description: safeRow.description } : {}),
    ...(!safeRow.enabled ? { disabled: true } : {}),
  };
}

function insomniaAuth(auth: SavedRequest['auth'], includeSecrets = false) {
  if (auth.type === 'bearer') return { type: 'bearer', token: safeExportValue('token', auth.bearerToken, includeSecrets) };
  if (auth.type === 'basic' || auth.type === 'digest') return { type: auth.type, username: auth.basicUser, password: safeExportValue('password', auth.basicPass, includeSecrets) };
  if (auth.type === 'apikey') return { type: 'apikey', key: auth.apiKeyName, value: safeExportValue(auth.apiKeyName || 'apiKey', auth.apiKeyValue, includeSecrets), addTo: auth.apiKeyIn };
  if (auth.type === 'oauth2') {
    return {
      type: 'oauth2',
      accessToken: safeExportValue('accessToken', auth.oauth2Token || auth.bearerToken, includeSecrets),
      clientId: auth.oauth2ClientID,
      clientSecret: safeExportValue('clientSecret', auth.oauth2Secret, includeSecrets),
      scope: auth.oauth2Scope,
      accessTokenUrl: auth.oauth2TokenURL,
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
  return {};
}

function mimeTypeForRequest(req: SavedRequest) {
  if (req.bodyType === 'graphql') return 'application/graphql';
  if (req.bodyType === 'json') return 'application/json';
  if (req.bodyType === 'xml') return 'application/xml';
  if (req.bodyType === 'html') return 'text/html';
  if (req.bodyType === 'urlencoded') return 'application/x-www-form-urlencoded';
  if (req.bodyType === 'form') return 'multipart/form-data';
  return 'text/plain';
}

function insomniaBody(req: SavedRequest, stripFn: (source: string, bodyType: string) => string, includeSecrets = false) {
  if (req.bodyType === 'urlencoded' || req.bodyType === 'form') {
    return {
      mimeType: mimeTypeForRequest(req),
      params: req.formRows.filter(row => row.key || row.value).map(row => {
        const safeRow = safeExportRow(row, includeSecrets);
        return {
          name: safeRow.key,
          value: safeRow.isFile ? '' : safeRow.value,
          ...(safeRow.isFile ? { type: 'file', fileName: safeRow.value } : {}),
          ...(safeRow.contentType ? { contentType: safeRow.contentType } : {}),
          ...(safeRow.description ? { description: safeRow.description } : {}),
          ...(!safeRow.enabled ? { disabled: true } : {}),
        };
      }),
    };
  }
  if (req.bodyType === 'graphql') {
    try {
      const parsed = parseGraphQLPayload(stripFn(req.bodyContent, req.bodyType));
      return {
        mimeType: 'application/graphql',
        text: parsed.query,
        variables: parseGraphQLVariables(parsed.variables),
        ...(parsed.operationName ? { operationName: parsed.operationName } : {}),
      };
    } catch {
      return { mimeType: 'application/graphql', text: stripFn(req.bodyContent, req.bodyType) };
    }
  }
  if (['json', 'text', 'xml', 'html'].includes(req.bodyType)) {
    const raw = stripFn(req.bodyContent, req.bodyType);
    if (req.bodyType === 'json') {
      try {
        return { mimeType: 'application/json', text: JSON.stringify(sanitizeExportExample(JSON.parse(raw), includeSecrets), null, 2) };
      } catch {}
    }
    return { mimeType: mimeTypeForRequest(req), text: raw };
  }
  if (req.requestType === 'grpc') {
    return { mimeType: 'application/json', text: stripFn(req.bodyContent || DEFAULT_GRPC_MESSAGE, req.bodyType || 'json') };
  }
  return {};
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

function kurloExtensionFromRequest(req: SavedRequest, stripFn: (source: string, bodyType: string) => string, includeSecrets = false) {
  const requestType = req.requestType ?? 'http';
  const extension: Record<string, unknown> = {
    requestType,
    requestTab: req.requestTab,
    settings: req.settings,
  };
  if (requestType === 'socketio') {
    extension.sioEvents = (req.sioEvents ?? []).filter(row => row.key || row.value).map(row => insomniaRow(row, includeSecrets));
    extension.sioArgs = (req.sioArgs ?? []).map(arg => ({
      id: arg.id,
      content: exportBodyLikeValue(arg.content, arg.bodyType, stripFn, includeSecrets),
      bodyType: arg.bodyType,
      encoding: arg.encoding,
    }));
    extension.sioAck = req.sioAck ?? false;
  }
  if (requestType === 'grpc') {
    extension.grpcMethod = req.grpcMethod ?? '';
    extension.grpcMetadata = (req.grpcMetadata ?? []).filter(row => row.key || row.value).map(row => insomniaRow(row, includeSecrets));
    extension.message = exportBodyLikeValue(req.bodyContent || DEFAULT_GRPC_MESSAGE, req.bodyType || 'json', stripFn, includeSecrets);
    extension.grpcUseReflection = req.settings.grpcUseReflection ?? req.grpcUseReflection ?? true;
    extension.grpcProtoFilePath = req.grpcProtoFilePath ?? '';
    extension.grpcProtoFileName = req.grpcProtoFileName ?? '';
    extension.grpcProtoImportPaths = req.grpcProtoImportPaths ?? [];
  }
  return extension;
}

function requestResourceType(req: SavedRequest) {
  if (req.requestType === 'ws') return 'websocket_request';
  if (req.requestType === 'socketio') return 'socketio_request';
  if (req.requestType === 'grpc') return 'grpc_request';
  return 'request';
}

function requestResource(req: SavedRequest, parentId: string, stripFn: (source: string, bodyType: string) => string, includeSecrets = false) {
  return {
    _id: req.id || newRequestId(),
    _type: requestResourceType(req),
    parentId,
    name: req.name,
    method: req.requestType === 'graphql' || req.requestType === 'grpc' ? 'POST' : req.method,
    url: safeExportUrl(req.url, includeSecrets),
    parameters: req.params.filter(row => row.key || row.value).map(row => insomniaRow(row, includeSecrets)),
    headers: req.headers.filter(row => row.key || row.value).map(row => insomniaRow(row, includeSecrets)),
    authentication: insomniaAuth(req.auth, includeSecrets),
    body: insomniaBody(req, stripFn, includeSecrets),
    description: req.requestNotes,
    ...(req.preRequestScript ? { preRequestScript: req.preRequestScript } : {}),
    ...(req.testScript ? { afterResponseScript: req.testScript } : {}),
    ...(req.requestType === 'grpc' ? {
      protoMethodName: req.grpcMethod ?? '',
      metadata: (req.grpcMetadata ?? []).filter(row => row.key || row.value).map(row => insomniaRow(row, includeSecrets)),
    } : {}),
    kurlo: kurloExtensionFromRequest(req, stripFn, includeSecrets),
  };
}

export function buildInsomniaExport(collectionName: string, collectionDescription: string, requests: SavedRequest[], stripFn: (source: string, bodyType: string) => string, includeSecrets = false) {
  const workspaceId = `wrk_${newRequestId()}`;
  const resources: Record<string, unknown>[] = [{
    _id: workspaceId,
    _type: 'workspace',
    name: collectionName,
    description: collectionDescription,
  }];
  const folderIds = new Map<string, string>();
  const parentForFolder = (folderPath: string[]) => {
    let parentId = workspaceId;
    const current: string[] = [];
    for (const folder of folderPath) {
      current.push(folder);
      const key = current.join('/');
      let id = folderIds.get(key);
      if (!id) {
        id = `fld_${newRequestId()}`;
        folderIds.set(key, id);
        resources.push({ _id: id, _type: 'request_group', parentId, name: folder });
      }
      parentId = id;
    }
    return parentId;
  };
  for (const req of requests) {
    resources.push(requestResource(req, parentForFolder(req.folderPath ?? []), stripFn, includeSecrets));
  }
  return {
    _type: 'export',
    __export_format: 4,
    __export_date: new Date().toISOString(),
    __export_source: 'kurlo.desktop',
    resources,
  };
}
