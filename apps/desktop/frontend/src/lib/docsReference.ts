import type { KVRow } from './types/models';

export type DocsReferenceRow = { key: string; value: string; description: string };

export type DocsReferenceInput = {
  requestType: string;
  method: string;
  url: string;
  params: KVRow[];
  pathParams: KVRow[];
  headers: KVRow[];
  bodyType: string;
  rawBodyType: string;
  bodyContent: string;
  formRows: KVRow[];
  graphqlQuery: string;
  authType: string;
};

export type DocsReference = {
  method: string;
  url: string;
  auth: string;
  pathParams: DocsReferenceRow[];
  params: DocsReferenceRow[];
  headers: DocsReferenceRow[];
  body: { label: string; text: string; rows: DocsReferenceRow[] } | null;
};

const AUTH_LABELS: Record<string, string> = {
  bearer: 'Bearer token',
  basic: 'Basic auth',
  apikey: 'API key',
  oauth2: 'OAuth 2.0',
  digest: 'Digest auth',
  aws: 'AWS Signature',
  inherit: 'Inherited from the collection',
};

function rows(input: KVRow[]): DocsReferenceRow[] {
  return input
    .filter(row => row.enabled !== false && row.key.trim())
    .map(row => ({ key: row.key.trim(), value: row.secret ? '••••' : row.isFile ? (row.fileName || 'file') : row.value, description: row.description?.trim() ?? '' }));
}

export function docsReference(input: DocsReferenceInput): DocsReference {
  const http = input.requestType === 'http' || input.requestType === 'graphql';
  let body: DocsReference['body'] = null;
  if (input.requestType === 'graphql' && input.graphqlQuery.trim()) {
    body = { label: 'GraphQL', text: input.graphqlQuery.trim(), rows: [] };
  } else if (input.requestType === 'http') {
    if ((input.bodyType === 'form' || input.bodyType === 'urlencoded') && rows(input.formRows).length) {
      body = { label: input.bodyType === 'form' ? 'Form data' : 'URL-encoded form', text: '', rows: rows(input.formRows) };
    } else if (input.bodyType !== 'none' && input.bodyType !== 'binary' && input.bodyContent.trim()) {
      body = { label: (input.rawBodyType || input.bodyType).toUpperCase(), text: input.bodyContent.trim(), rows: [] };
    }
  }
  return {
    method: input.requestType === 'http' ? input.method : input.requestType === 'graphql' ? 'POST' : input.requestType.toUpperCase(),
    url: input.url.trim(),
    auth: AUTH_LABELS[input.authType] ?? '',
    pathParams: http ? rows(input.pathParams) : [],
    params: http ? rows(input.params) : [],
    headers: rows(input.headers),
    body,
  };
}
