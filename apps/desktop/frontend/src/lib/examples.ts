import { mkRow } from './constants';
import { isSensitiveExportKey, isTemplateExportValue, sanitizeExportExample } from './secretExport';
import type { HttpResponse } from './backend';
import type {
  BodyType,
  KVRow,
  Method,
  RequestExample,
  RequestExampleMatch,
  RequestExampleResponse,
  RequestExampleSnapshot,
  RequestExampleSource,
  SavedRequest,
} from './types/models';
import { cloneRowsForStore, newEntityId, rowHasContent } from './utils';
import { emptyHttpResponse } from './wire';

const EXAMPLE_SOURCES: RequestExampleSource[] = ['captured', 'manual', 'openapi', 'postman'];

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function storedRows(input: KVRow[] | undefined): KVRow[] {
  return (input ?? []).filter(rowHasContent).map(row => ({
    ...mkRow(),
    ...(typeof row.id === 'number' && Number.isFinite(row.id) ? { id: row.id } : {}),
    enabled: row.enabled ?? true,
    key: row.key ?? '',
    value: row.value ?? '',
    description: row.description ?? '',
    isFile: row.isFile ?? false,
    fileName: row.fileName ?? '',
    contentType: row.contentType ?? '',
    secret: row.secret ?? false,
  }));
}

function headerValue(headers: KVRow[], name: string): string {
  return headers.find(row => row.key.toLowerCase() === name.toLowerCase())?.value ?? '';
}

export function mediaTypeOf(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() ?? '';
}

export function pathTemplateFromUrl(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0] ?? '';
  let path = withoutQuery.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  if (path === withoutQuery) {
    path = path.replace(/^\{\{[^{}]*\}\}(?=\/|$)/, '');
  }
  if (!path || path === '/') return '/';
  const segments = path.split('/').map(segment => {
    if (!segment || segment.includes('{{')) return segment;
    if (/^\d+$/.test(segment)) return ':id';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ':id';
    return segment;
  });
  return segments.join('/') || '/';
}

export function maskKnownSecrets(text: string, secretValues: string[]): string {
  if (!text) return text;
  const unique = [...new Set(secretValues.filter(value => value && value.length >= 4))];
  unique.sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of unique) out = out.split(value).join('[secret]');
  return out;
}

export function redactExampleBody(body: string, secretValues: string[]): string {
  const masked = maskKnownSecrets(body, secretValues);
  if (!masked.trim()) return masked;
  let parsed: unknown;
  try {
    parsed = JSON.parse(masked);
  } catch {
    return masked;
  }
  const swept = sanitizeExportExample(parsed);
  if (!jsonRedactionChanged(parsed, swept)) return masked;
  return JSON.stringify(swept, null, 2);
}

function jsonRedactionChanged(before: unknown, after: unknown): boolean {
  try {
    return JSON.stringify(before) !== JSON.stringify(after);
  } catch {
    return true;
  }
}

export function redactExampleHeaders(headers: KVRow[], secretValues: string[]): KVRow[] {
  return headers.map(row => {
    const masked = maskKnownSecrets(row.value, secretValues);
    if (masked && isSensitiveExportKey(row.key) && !isTemplateExportValue(masked)) {
      return { ...row, value: '' };
    }
    return { ...row, value: masked };
  });
}

export function exampleHasRawSecret(example: RequestExample): boolean {
  for (const row of example.response.headers) {
    if (row.value && isSensitiveExportKey(row.key) && !isTemplateExportValue(row.value)) return true;
  }
  try {
    const parsed = JSON.parse(example.response.body);
    const swept = JSON.stringify(sanitizeExportExample(parsed));
    return swept !== JSON.stringify(parsed);
  } catch {
    return false;
  }
}

function normalizeSnapshot(input: Partial<RequestExampleSnapshot> | undefined): RequestExampleSnapshot {
  return {
    method: (input?.method || 'GET') as Method,
    url: asText(input?.url),
    params: storedRows(input?.params),
    headers: storedRows(input?.headers),
    bodyType: (input?.bodyType || 'none') as BodyType,
    bodyContent: asText(input?.bodyContent),
  };
}

function normalizeResponse(input: Partial<RequestExampleResponse> | undefined): RequestExampleResponse {
  const headers = storedRows(input?.headers);
  return {
    statusCode: finite(input?.statusCode),
    status: asText(input?.status),
    headers,
    body: asText(input?.body),
    bodyMediaType: asText(input?.bodyMediaType) || mediaTypeOf(headerValue(headers, 'content-type')),
    ...(input?.durationMs !== undefined ? { durationMs: finite(input.durationMs) } : {}),
  };
}

function normalizeMatch(input: Partial<RequestExampleMatch> | undefined, snapshotUrl: string): RequestExampleMatch {
  const query = input?.query && typeof input.query === 'object' ? input.query : undefined;
  return {
    pathTemplate: asText(input?.pathTemplate) || pathTemplateFromUrl(snapshotUrl),
    ...(query && Object.keys(query).length ? { query } : {}),
  };
}

export function normalizeRequestExample(input: Partial<RequestExample>, requestId: string): RequestExample {
  const snapshot = normalizeSnapshot(input.snapshot);
  const source = EXAMPLE_SOURCES.includes(input.source as RequestExampleSource)
    ? (input.source as RequestExampleSource)
    : 'manual';
  return {
    id: input.id || newEntityId('example'),
    requestId: input.requestId || requestId,
    name: input.name || 'Example',
    filesystemName: asText(input.filesystemName),
    source,
    createdAt: finite(input.createdAt, Date.now()),
    ...(input.notes ? { notes: input.notes } : {}),
    snapshot,
    response: normalizeResponse(input.response),
    match: normalizeMatch(input.match, snapshot.url),
  };
}

export function responseFromExample(example: RequestExample): HttpResponse {
  return {
    ...emptyHttpResponse(),
    statusCode: example.response.statusCode,
    status: example.response.status,
    headers: example.response.headers.map(row => ({
      key: row.key,
      value: row.value,
      enabled: true,
      isFile: false,
      fileName: '',
      contentType: '',
    })),
    body: example.response.body,
    size: example.response.body.length,
    duration: example.response.durationMs ?? 0,
  };
}

export function cloneRequestExample(example: RequestExample): RequestExample {
  return {
    ...example,
    snapshot: {
      ...example.snapshot,
      params: example.snapshot.params.map(row => ({ ...row })),
      headers: example.snapshot.headers.map(row => ({ ...row })),
    },
    response: {
      ...example.response,
      headers: example.response.headers.map(row => ({ ...row })),
    },
    match: { ...example.match, ...(example.match.query ? { query: { ...example.match.query } } : {}) },
  };
}

export function normalizeRequestExamples(input: unknown, requestId: string): RequestExample[] | undefined {
  if (!Array.isArray(input) || input.length === 0) return undefined;
  return input
    .filter((item): item is Partial<RequestExample> => Boolean(item) && typeof item === 'object')
    .map(item => normalizeRequestExample(item, requestId));
}

export function exampleFromResponse(
  request: SavedRequest,
  response: HttpResponse,
  options: { name?: string; secretValues?: string[]; source?: RequestExampleSource } = {},
): RequestExample {
  const secretValues = options.secretValues ?? [];
  const responseHeaders = (response.headers ?? []).map((header, index) => ({
    ...mkRow(),
    id: index + 1,
    key: header.key,
    value: header.value,
  }));
  const mediaType = mediaTypeOf(headerValue(responseHeaders, 'content-type'));
  return {
    id: newEntityId('example'),
    requestId: request.id,
    name: options.name || response.status || `${response.statusCode}`,
    filesystemName: '',
    source: options.source ?? 'captured',
    createdAt: Date.now(),
    snapshot: {
      method: request.method,
      url: request.url,
      params: cloneRowsForStore(request.params ?? []) as KVRow[],
      headers: redactExampleHeaders(cloneRowsForStore(request.headers ?? []) as KVRow[], secretValues),
      bodyType: request.bodyType,
      bodyContent: maskKnownSecrets(request.bodyContent ?? '', secretValues),
    },
    response: {
      statusCode: response.statusCode,
      status: response.status,
      headers: redactExampleHeaders(responseHeaders, secretValues),
      body: response.bodyIsBinary ? '' : redactExampleBody(response.body ?? '', secretValues),
      bodyMediaType: mediaType,
      durationMs: finite(response.duration),
    },
    match: { pathTemplate: pathTemplateFromUrl(request.url) },
  };
}
