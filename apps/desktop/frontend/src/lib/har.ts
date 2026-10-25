import type { BodyType, KVRow, Method, RawBodyType, RequestExample, RequestTab, SavedRequest } from './types/models';
import { DEFAULT_REQUEST_SETTINGS, mkRow } from './constants';
import { asArray, asText, isRecord, newRequestId } from './utils';
import { emptyAuthState } from './utils';
import { serializeGraphQLPayload } from './graphql';
import { filterSocketIOTransportParams, graphQLBodyContentFromJsonText, isWebSocketUrl, socketIOImportDetails } from './importDetection';
import { filesystemNameFromName } from './normalizers';
import { mediaTypeOf, normalizeRequestExample } from './examples';

function row(key: string, value: string, enabled = true): KVRow {
  return { ...mkRow(), key, value, enabled };
}

function rawTypeFromMime(mime: string): RawBodyType {
  const lower = mime.toLowerCase();
  if (lower.includes('json')) return 'json';
  if (lower.includes('xml')) return 'xml';
  if (lower.includes('html')) return 'html';
  return 'text';
}

function bodyFromPostData(postData: unknown) {
  const result = { bodyType: 'none' as BodyType, rawBodyType: 'json' as RawBodyType, bodyContent: '', formRows: [] as KVRow[] };
  if (!isRecord(postData)) return result;
  const mime = asText(postData.mimeType).toLowerCase();

  if (mime.includes('x-www-form-urlencoded')) {
    result.bodyType = 'urlencoded';
    result.formRows = asArray(postData.params).map(item => {
      if (!isRecord(item)) return null;
      const key = asText(item.name);
      if (!key) return null;
      return row(key, asText(item.value));
    }).filter((r): r is KVRow => Boolean(r));
    const text = asText(postData.text);
    if (!result.formRows.length && text) {
      result.formRows = [...new URLSearchParams(text)].filter(([key]) => key).map(([key, value]) => row(key, value));
    }
    return result;
  }

  if (mime.includes('multipart/form-data')) {
    result.bodyType = 'form';
    result.formRows = asArray(postData.params).map(item => {
      if (!isRecord(item)) return null;
      const key = asText(item.name);
      if (!key) return null;
      return row(key, asText((item as Record<string, unknown>).value || (item as Record<string, unknown>).fileName));
    }).filter((r): r is KVRow => Boolean(r));
    return result;
  }

  const text = asText(postData.text);
  if (!text) return result;
  const graphqlJson = graphQLBodyContentFromJsonText(text);
  if (graphqlJson) {
    result.bodyType = 'graphql';
    result.rawBodyType = 'json';
    result.bodyContent = graphqlJson;
    return result;
  }
  if (mime.includes('graphql')) {
    result.bodyType = 'graphql';
    result.rawBodyType = 'json';
    result.bodyContent = serializeGraphQLPayload({ query: text, variables: '{}', operationName: '' });
    return result;
  }
  const rawType = rawTypeFromMime(mime);
  result.bodyType = rawType;
  result.rawBodyType = rawType;
  result.bodyContent = text;
  return result;
}

function nameFromEntry(method: string, url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts.length ? `${method} /${parts.join('/')}` : `${method} ${parsed.hostname}`;
  } catch {
    return `${method} ${url.slice(0, 60)}`;
  }
}

function hasWebSocketUpgrade(headers: KVRow[]): boolean {
  return headers.some((header) => header.key.toLowerCase() === 'upgrade' && header.value.toLowerCase() === 'websocket');
}

export function harCollectionName(payload: unknown, fileName: string): string {
  const log = isRecord(payload) && isRecord((payload as Record<string, unknown>).log) ? (payload as Record<string, unknown>).log as Record<string, unknown> : {};
  return asText(log.comment) || fileName.replace(/\.har$/i, '') || 'HAR Import';
}

function harExampleFromEntry(entry: Record<string, unknown>, requestId: string, request: {
  method: Method; url: string; params: KVRow[]; headers: KVRow[]; bodyType: BodyType; bodyContent: string;
}): RequestExample | null {
  const response = isRecord(entry.response) ? entry.response : null;
  if (!response) return null;
  const status = Number(response.status) || 0;
  if (status <= 0) return null;
  const statusText = asText(response.statusText);
  const content = isRecord(response.content) ? response.content : {};
  const headers = asArray(response.headers).map(item => {
    if (!isRecord(item)) return null;
    const key = asText(item.name);
    if (!key || key.startsWith(':')) return null;
    return row(key, asText(item.value));
  }).filter((item): item is KVRow => Boolean(item));

  const base64 = asText(content.encoding).toLowerCase() === 'base64';
  return normalizeRequestExample({
    name: `${status} ${statusText}`.trim() || String(status),
    source: 'captured',
    snapshot: {
      method: request.method,
      url: request.url,
      params: request.params,
      headers: request.headers,
      bodyType: request.bodyType,
      bodyContent: request.bodyContent,
    },
    response: {
      statusCode: status,
      status: `${status} ${statusText}`.trim(),
      headers,
      body: base64 ? '' : asText(content.text),
      bodyMediaType: mediaTypeOf(asText(content.mimeType)),
    },
  }, requestId);
}

export function harRequestsFromLog(payload: unknown, collectionId: string, collectionName: string): SavedRequest[] {
  if (!isRecord(payload) || !isRecord((payload as Record<string, unknown>).log)) {
    throw new Error('Expected a HAR file with a log object');
  }
  const log = (payload as Record<string, unknown>).log as Record<string, unknown>;
  const entries = asArray(log.entries);
  if (!entries.length) throw new Error('No entries found in HAR file');

  const results: SavedRequest[] = [];

  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord((entry as Record<string, unknown>).request)) continue;
    const request = (entry as Record<string, unknown>).request as Record<string, unknown>;

    const url = asText(request.url);
    if (!url) continue;

    const allParams = asArray(request.queryString).map(item => {
      if (!isRecord(item)) return null;
      const key = asText((item as Record<string, unknown>).name);
      if (!key) return null;
      return row(key, asText((item as Record<string, unknown>).value));
    }).filter((r): r is KVRow => Boolean(r));

    let baseUrl = url;
    if (allParams.length) {
      try {
        const parsed = new URL(url);
        parsed.search = '';
        baseUrl = parsed.toString();
      } catch {  }
    }

    const headers = asArray(request.headers).map(item => {
      if (!isRecord(item)) return null;
      const key = asText((item as Record<string, unknown>).name);
      if (!key || key.startsWith(':')) return null;
      if (key.toLowerCase() === 'cookie') return null;
      return row(key, asText((item as Record<string, unknown>).value));
    }).filter((r): r is KVRow => Boolean(r));

    const body = bodyFromPostData(request.postData);
    const socketIO = socketIOImportDetails(url);
    const requestType = body.bodyType === 'graphql' ? 'graphql' : socketIO ? 'socketio' : isWebSocketUrl(url) || hasWebSocketUpgrade(headers) ? 'ws' : 'http';
    const params = requestType === 'socketio' ? filterSocketIOTransportParams(allParams) : allParams;
    const method = (requestType === 'graphql' ? 'POST' : asText(request.method).toUpperCase() || 'GET') as Method;
    const sioArgs = requestType === 'socketio' && body.bodyContent.trim()
      ? [{ id: newRequestId(), content: body.bodyContent, bodyType: body.rawBodyType, encoding: 'base64' as const }]
      : undefined;

    let requestTab: RequestTab = 'params';
    if (requestType === 'socketio') requestTab = 'events';
    else if (requestType === 'ws') requestTab = 'body';
    else if (requestType === 'graphql') requestTab = 'query';
    else if (body.bodyType !== 'none') requestTab = 'body';
    else if (headers.length) requestTab = 'headers';
    else if (params.length) requestTab = 'params';

    const id = newRequestId();
    const name = nameFromEntry(method, url);
    const example = harExampleFromEntry(entry as Record<string, unknown>, id, {
      method, url: socketIO?.url ?? baseUrl, params, headers, bodyType: body.bodyType, bodyContent: body.bodyContent,
    });
    results.push({
      id,
      name,
      filesystemName: filesystemNameFromName(name, id),
      collectionId,
      collection: collectionName,
      folderPath: [],
      requestType,
      method,
      url: socketIO?.url ?? baseUrl,
      requestTab,
      params,
      headers,
      auth: emptyAuthState(),
      bodyType: body.bodyType,
      rawBodyType: body.rawBodyType,
      bodyContent: body.bodyContent,
      bodyFilePath: '',
      bodyFileName: '',
      formRows: body.formRows,
      ...(sioArgs ? { sioArgs } : {}),
      preRequestScript: '',
      testScript: '',
      requestNotes: '',
      settings: { ...DEFAULT_REQUEST_SETTINGS, ...(socketIO?.settings ?? {}) },
      ...(example ? { examples: [example] } : {}),
    });
  }

  return results;
}
