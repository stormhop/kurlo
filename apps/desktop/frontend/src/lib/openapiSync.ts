import type { AuthState, Collection, CollectionDefaults, KVRow, RequestExample, SavedRequest } from './types/models';
import { openApiImportFromSpec, openApiOperationIds, type OpenApiCollectionDefaults } from './openapi';
import { normalizeRequestExample } from './examples';
import { mkRow } from './constants';

export type OpenApiSyncField = 'url' | 'params' | 'pathParams' | 'headers' | 'body' | 'auth' | 'docs' | 'examples';
export type OpenApiCollectionField = 'variables' | 'auth';

export const OPENAPI_FIELD_LABELS: Record<OpenApiSyncField | OpenApiCollectionField, string> = {
  url: 'Method and URL',
  params: 'Query params',
  pathParams: 'Path params',
  headers: 'Headers',
  body: 'Body',
  auth: 'Auth',
  docs: 'Docs',
  examples: 'Spec examples',
  variables: 'Variables',
};

export type OpenApiFieldChange = {
  field: OpenApiSyncField | OpenApiCollectionField;
  label: string;
  local: string;
  spec: string;
  conflict: boolean;
};

export type OpenApiEndpointKind = 'new' | 'changed' | 'conflict' | 'removed';

export type OpenApiEndpointChange = {
  id: string;
  kind: OpenApiEndpointKind;
  key: string;
  name: string;
  requestId?: string;
  renamedFrom?: string;
  fields: OpenApiFieldChange[];
  keepLocal?: SavedRequest;
  useSpec?: SavedRequest;
  request?: SavedRequest;
};

export type OpenApiCollectionChange = {
  fields: OpenApiFieldChange[];
  conflict: boolean;
  keepLocal: CollectionDefaults;
  useSpec: CollectionDefaults;
};

export type OpenApiSyncPlan = {
  endpoints: OpenApiEndpointChange[];
  collection: OpenApiCollectionChange | null;
  links: Array<{ requestId: string; key: string }>;
  counts: { new: number; changed: number; conflict: number; removed: number };
};

export type OpenApiPlanInput = {
  collection: Collection;
  requests: SavedRequest[];
  baseSpec: unknown | null;
  nextSpec: unknown;
  sourceUrl?: string;
};

type Projection = {
  requests: Map<string, SavedRequest>;
  operationIds: Map<string, string>;
  defaults: OpenApiCollectionDefaults;
};

type RowView = { key: string; value: string };

function project(spec: unknown, collection: Collection, sourceUrl: string): Projection {
  const imported = openApiImportFromSpec(spec, collection.id, collection.name, sourceUrl);
  const requests = new Map<string, SavedRequest>();
  for (const request of imported.requests) {
    if (request.openapi && !requests.has(request.openapi)) requests.set(request.openapi, request);
  }
  return { requests, operationIds: openApiOperationIds(spec), defaults: imported.defaults };
}

function rowsOf(rows: KVRow[] | undefined): KVRow[] {
  return (rows ?? []).filter(row => row.key.trim());
}

function rowMap(rows: KVRow[] | undefined): Map<string, KVRow> {
  const map = new Map<string, KVRow>();
  for (const row of rowsOf(rows)) if (!map.has(row.key)) map.set(row.key, row);
  return map;
}

function rowsCanonical(rows: KVRow[] | undefined): string {
  return JSON.stringify(rowsOf(rows).map((row): RowView => ({ key: row.key, value: row.value })));
}

function rowsDisplay(rows: KVRow[] | undefined): string {
  const list = rowsOf(rows);
  if (!list.length) return 'None';
  return list.map(row => `${row.key}: ${row.value}`).join('\n');
}

function mergeRows(base: KVRow[] | undefined, local: KVRow[] | undefined, spec: KVRow[] | undefined, preferSpec: boolean): { rows: KVRow[]; conflict: boolean } {
  const baseMap = base ? rowMap(base) : new Map<string, KVRow>();
  const specMap = rowMap(spec);
  const seen = new Set<string>();
  const result: KVRow[] = [];
  let conflict = false;
  for (const row of local ?? []) {
    if (!row.key.trim()) {
      result.push(row);
      continue;
    }
    const firstOccurrence = !seen.has(row.key);
    seen.add(row.key);
    const baseRow = baseMap.get(row.key);
    const specRow = specMap.get(row.key);
    if (!firstOccurrence) {
      result.push(row);
      continue;
    }
    if (!baseRow) {
      if (specRow && specRow.value !== row.value) {
        conflict = true;
        result.push(preferSpec ? { ...row, value: specRow.value } : row);
      } else {
        result.push(row);
      }
      continue;
    }
    if (!specRow) {
      if (row.value === baseRow.value) continue;
      conflict = true;
      if (!preferSpec) result.push(row);
      continue;
    }
    if (specRow.value === baseRow.value || specRow.value === row.value) {
      result.push(row);
    } else if (row.value === baseRow.value) {
      result.push({ ...row, value: specRow.value, description: specRow.description || row.description });
    } else {
      conflict = true;
      result.push(preferSpec ? { ...row, value: specRow.value } : row);
    }
  }
  for (const [key, specRow] of specMap) {
    if (seen.has(key)) continue;
    const baseRow = baseMap.get(key);
    if (baseRow) {
      if (baseRow.value === specRow.value) continue;
      conflict = true;
      if (!preferSpec) continue;
    }
    result.push({ ...specRow, id: mkRow().id });
  }
  return { rows: result, conflict };
}

type ScalarField = {
  field: OpenApiSyncField;
  canonical: (request: SavedRequest) => string;
  display: (request: SavedRequest) => string;
  assign: (target: SavedRequest, source: SavedRequest) => SavedRequest;
};

function bodyCanonical(request: SavedRequest) {
  return JSON.stringify({
    type: request.bodyType,
    raw: request.bodyType === 'json' || request.bodyType === 'text' || request.bodyType === 'xml' || request.bodyType === 'html' ? request.rawBodyType : '',
    content: request.bodyType === 'form' || request.bodyType === 'urlencoded' || request.bodyType === 'none' ? '' : request.bodyContent,
    form: request.bodyType === 'form' || request.bodyType === 'urlencoded' ? rowsOf(request.formRows).map(row => [row.key, row.value]) : [],
  });
}

function bodyDisplay(request: SavedRequest) {
  if (request.bodyType === 'none') return 'No body';
  if (request.bodyType === 'form' || request.bodyType === 'urlencoded') return `${request.bodyType}\n${rowsDisplay(request.formRows)}`;
  return request.bodyContent || `Empty ${request.bodyType} body`;
}

function specExamples(request: SavedRequest): RequestExample[] {
  return (request.examples ?? []).filter(example => example.source === 'openapi');
}

function examplesCanonical(request: SavedRequest) {
  return JSON.stringify(specExamples(request)
    .map(example => [example.name, example.response.statusCode, example.response.bodyMediaType, example.response.body])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

function authType(auth: AuthState | undefined) {
  return auth?.type ?? 'none';
}

const SCALAR_FIELDS: ScalarField[] = [
  {
    field: 'url',
    canonical: request => `${request.method} ${request.url}`,
    display: request => `${request.method} ${request.url}`,
    assign: (target, source) => ({ ...target, method: source.method, url: source.url }),
  },
  {
    field: 'body',
    canonical: bodyCanonical,
    display: bodyDisplay,
    assign: (target, source) => ({
      ...target,
      bodyType: source.bodyType,
      rawBodyType: source.rawBodyType,
      bodyContent: source.bodyContent,
      formRows: source.formRows.map(row => ({ ...row })),
    }),
  },
  {
    field: 'auth',
    canonical: request => authType(request.auth),
    display: request => authType(request.auth),
    assign: (target, source) => ({ ...target, auth: { ...source.auth } }),
  },
  {
    field: 'docs',
    canonical: request => request.requestNotes ?? '',
    display: request => request.requestNotes || 'None',
    assign: (target, source) => ({ ...target, requestNotes: source.requestNotes }),
  },
];

const ROW_FIELDS: Array<{ field: OpenApiSyncField; key: 'params' | 'pathParams' | 'headers' }> = [
  { field: 'params', key: 'params' },
  { field: 'pathParams', key: 'pathParams' },
  { field: 'headers', key: 'headers' },
];

function withSpecExamples(target: SavedRequest, source: SavedRequest): SavedRequest {
  const own = (target.examples ?? []).filter(example => example.source !== 'openapi');
  const fresh = specExamples(source).map(example => normalizeRequestExample({ ...example, id: '', requestId: target.id, filesystemName: '' }, target.id));
  return { ...target, examples: [...own, ...fresh] };
}

function mergeRequest(base: SavedRequest | undefined, local: SavedRequest, spec: SavedRequest, key: string) {
  const fields: OpenApiFieldChange[] = [];
  let keepLocal: SavedRequest = { ...local, openapi: key };
  let useSpec: SavedRequest = { ...local, openapi: key };
  for (const scalar of SCALAR_FIELDS) {
    const localValue = scalar.canonical(local);
    const specValue = scalar.canonical(spec);
    if (localValue === specValue) continue;
    const baseValue = base ? scalar.canonical(base) : undefined;
    if (baseValue === specValue) continue;
    const conflict = baseValue !== localValue;
    fields.push({ field: scalar.field, label: OPENAPI_FIELD_LABELS[scalar.field], local: scalar.display(local), spec: scalar.display(spec), conflict });
    useSpec = scalar.assign(useSpec, spec);
    if (!conflict) keepLocal = scalar.assign(keepLocal, spec);
  }
  for (const rowField of ROW_FIELDS) {
    const baseRows = base ? base[rowField.key] ?? [] : undefined;
    const localRows = local[rowField.key] ?? [];
    const specRows = spec[rowField.key] ?? [];
    const preferLocal = mergeRows(baseRows, localRows, specRows, false);
    const preferSpec = mergeRows(baseRows, localRows, specRows, true);
    const changed = rowsCanonical(preferLocal.rows) !== rowsCanonical(localRows) || rowsCanonical(preferSpec.rows) !== rowsCanonical(localRows);
    if (!changed) continue;
    fields.push({
      field: rowField.field,
      label: OPENAPI_FIELD_LABELS[rowField.field],
      local: rowsDisplay(localRows),
      spec: rowsDisplay(specRows),
      conflict: preferLocal.conflict,
    });
    keepLocal = { ...keepLocal, [rowField.key]: preferLocal.rows };
    useSpec = { ...useSpec, [rowField.key]: preferSpec.rows };
  }
  if (local.examples !== undefined || !local.exampleCount) {
    const localValue = examplesCanonical(local);
    const specValue = examplesCanonical(spec);
    const baseValue = base ? examplesCanonical(base) : undefined;
    if (localValue !== specValue && baseValue !== specValue) {
      fields.push({
        field: 'examples',
        label: OPENAPI_FIELD_LABELS.examples,
        local: specExamples(local).map(example => example.name).join('\n') || 'None',
        spec: specExamples(spec).map(example => example.name).join('\n') || 'None',
        conflict: false,
      });
      keepLocal = withSpecExamples(keepLocal, spec);
      useSpec = withSpecExamples(useSpec, spec);
    }
  }
  return { fields, keepLocal, useSpec, conflict: fields.some(field => field.conflict) };
}

function collectionChange(collection: Collection, base: OpenApiCollectionDefaults | null, spec: OpenApiCollectionDefaults): OpenApiCollectionChange | null {
  const fields: OpenApiFieldChange[] = [];
  const local = collection.defaults;
  let keepLocal: CollectionDefaults = { ...local };
  let useSpec: CollectionDefaults = { ...local };
  const specKeys = new Set(rowsOf(spec.variables).map(row => row.key));
  const baseKeys = new Set(rowsOf(base?.variables).map(row => row.key));
  const tracked = (rows: KVRow[]) => rows.filter(row => specKeys.has(row.key) || baseKeys.has(row.key));
  const preferLocal = mergeRows(base ? base.variables : undefined, local.variables, spec.variables, false);
  const preferSpec = mergeRows(base ? base.variables : undefined, local.variables, spec.variables, true);
  const localRows = local.variables ?? [];
  const localChanged = rowsCanonical(preferLocal.rows) !== rowsCanonical(localRows);
  const specChanged = rowsCanonical(preferSpec.rows) !== rowsCanonical(localRows);
  if (localChanged || specChanged) {
    fields.push({
      field: 'variables',
      label: OPENAPI_FIELD_LABELS.variables,
      local: rowsDisplay(tracked(localRows)),
      spec: rowsDisplay(spec.variables),
      conflict: preferLocal.conflict,
    });
    keepLocal = { ...keepLocal, variables: preferLocal.rows };
    useSpec = { ...useSpec, variables: preferSpec.rows };
  }
  const specAuth = spec.auth ? authType(spec.auth) : 'none';
  const baseAuth = base ? (base.auth ? authType(base.auth) : 'none') : undefined;
  const localAuth = authType(local.auth);
  if (specAuth !== localAuth && baseAuth !== specAuth) {
    const conflict = baseAuth !== localAuth;
    const nextAuth = spec.auth ? { ...spec.auth } : { ...local.auth, type: 'none' as const };
    fields.push({ field: 'auth', label: OPENAPI_FIELD_LABELS.auth, local: localAuth, spec: specAuth, conflict });
    useSpec = { ...useSpec, auth: nextAuth };
    if (!conflict) keepLocal = { ...keepLocal, auth: nextAuth };
  }
  if (!fields.length) return null;
  return { fields, conflict: fields.some(field => field.conflict), keepLocal, useSpec };
}

function normalizedPath(url: string): string {
  let path = url.trim().split('?')[0].split('#')[0];
  path = path.replace(/^\{\{[^}]+\}\}/, '');
  path = path.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]+/i, '');
  path = path
    .replace(/\{\{[^}]+\}\}/g, '{}')
    .replace(/\{[^}]+\}/g, '{}')
    .replace(/(^|\/):[A-Za-z_][\w-]*/g, '$1{}');
  path = path.replace(/\/+$/, '');
  return path.startsWith('/') ? path : `/${path}`;
}

export function openApiMatchKey(method: string, url: string) {
  return `${method.toUpperCase()} ${normalizedPath(url)}`;
}

function linkUnkeyed(requests: SavedRequest[], spec: Projection, base: Projection | null, linked: Set<string>) {
  const links: Array<{ requestId: string; key: string }> = [];
  const candidates = new Map<string, string[]>();
  const keys = new Set([...spec.requests.keys(), ...(base?.requests.keys() ?? [])]);
  for (const key of keys) {
    if (linked.has(key)) continue;
    const projected = spec.requests.get(key) ?? base?.requests.get(key);
    if (!projected) continue;
    const match = openApiMatchKey(projected.method, projected.url);
    candidates.set(match, [...(candidates.get(match) ?? []), key]);
  }
  const byMatch = new Map<string, SavedRequest[]>();
  for (const request of requests) {
    if (request.openapi) continue;
    const match = openApiMatchKey(request.method, request.url);
    byMatch.set(match, [...(byMatch.get(match) ?? []), request]);
  }
  for (const [match, specKeys] of candidates) {
    const local = byMatch.get(match) ?? [];
    if (specKeys.length !== 1 || local.length !== 1) continue;
    links.push({ requestId: local[0].id, key: specKeys[0] });
  }
  return links;
}

function isHttpRequest(request: SavedRequest) {
  return !request.isDraft && (!request.requestType || request.requestType === 'http');
}

export function planOpenApiSync(input: OpenApiPlanInput): OpenApiSyncPlan {
  const sourceUrl = input.sourceUrl ?? '';
  const next = project(input.nextSpec, input.collection, sourceUrl);
  const base = input.baseSpec ? project(input.baseSpec, input.collection, sourceUrl) : null;
  const ignored = new Set(input.collection.openapi?.ignored ?? []);
  const own = input.requests.filter(request => request.collectionId === input.collection.id && isHttpRequest(request));
  const linkedKeys = new Set(own.map(request => request.openapi).filter((key): key is string => Boolean(key)));
  const links = linkUnkeyed(own, next, base, linkedKeys);
  const linkByRequest = new Map(links.map(link => [link.requestId, link.key]));
  const working = own.map(request => linkByRequest.has(request.id) ? { ...request, openapi: linkByRequest.get(request.id) } : request);
  const localByKey = new Map<string, SavedRequest>();
  for (const request of working) if (request.openapi && !localByKey.has(request.openapi)) localByKey.set(request.openapi, request);

  const renamed = new Map<string, string>();
  if (base) {
    const nextById = new Map<string, string>();
    for (const [key, operationId] of next.operationIds) nextById.set(operationId, key);
    for (const [key, operationId] of base.operationIds) {
      if (next.requests.has(key)) continue;
      const target = nextById.get(operationId);
      if (target && !base.requests.has(target) && !localByKey.has(target)) renamed.set(key, target);
    }
  }

  const endpoints: OpenApiEndpointChange[] = [];
  const claimed = new Set<string>();
  for (const [key, local] of localByKey) {
    const nextKey = next.requests.has(key) ? key : renamed.get(key);
    if (!nextKey) {
      endpoints.push({ id: `removed:${local.id}`, kind: 'removed', key, name: local.name, requestId: local.id, fields: [] });
      continue;
    }
    claimed.add(nextKey);
    const merged = mergeRequest(base?.requests.get(key), local, next.requests.get(nextKey)!, nextKey);
    if (!merged.fields.length && nextKey === key) continue;
    endpoints.push({
      id: `changed:${local.id}`,
      kind: merged.conflict ? 'conflict' : 'changed',
      key: nextKey,
      name: local.name,
      requestId: local.id,
      ...(nextKey !== key ? { renamedFrom: key } : {}),
      fields: merged.fields,
      keepLocal: merged.keepLocal,
      useSpec: merged.useSpec,
    });
  }
  for (const [key, request] of next.requests) {
    if (claimed.has(key) || localByKey.has(key) || ignored.has(key)) continue;
    if (base?.requests.has(key)) continue;
    endpoints.push({ id: `new:${key}`, kind: 'new', key, name: request.name, fields: [], request });
  }

  const collection = collectionChange(input.collection, base?.defaults ?? null, next.defaults);
  const order: Record<OpenApiEndpointKind, number> = { new: 0, changed: 1, conflict: 2, removed: 3 };
  endpoints.sort((left, right) => order[left.kind] - order[right.kind] || left.key.localeCompare(right.key));
  const counts = { new: 0, changed: 0, conflict: 0, removed: 0 };
  for (const endpoint of endpoints) counts[endpoint.kind]++;
  if (collection) counts[collection.conflict ? 'conflict' : 'changed']++;
  return { endpoints, collection, links, counts };
}

export function openApiPlanIsEmpty(plan: OpenApiSyncPlan) {
  return !plan.endpoints.length && !plan.collection;
}

export function openApiPlanSummary(plan: OpenApiSyncPlan): string {
  const parts: string[] = [];
  if (plan.counts.new) parts.push(`${plan.counts.new} new`);
  if (plan.counts.changed) parts.push(`${plan.counts.changed} changed`);
  if (plan.counts.conflict) parts.push(`${plan.counts.conflict} conflict${plan.counts.conflict === 1 ? '' : 's'}`);
  if (plan.counts.removed) parts.push(`${plan.counts.removed} removed`);
  return parts.join(', ') || 'In sync';
}

export type OpenApiSelection = {
  selected: Set<string>;
  useSpec: Set<string>;
  collectionSelected: boolean;
  collectionUseSpec: boolean;
};

export function defaultOpenApiSelection(plan: OpenApiSyncPlan): OpenApiSelection {
  return {
    selected: new Set(plan.endpoints.filter(endpoint => endpoint.kind !== 'removed').map(endpoint => endpoint.id)),
    useSpec: new Set(),
    collectionSelected: Boolean(plan.collection),
    collectionUseSpec: false,
  };
}

export function acceptAllOpenApiSelection(plan: OpenApiSyncPlan): OpenApiSelection {
  return {
    selected: new Set(plan.endpoints.map(endpoint => endpoint.id)),
    useSpec: new Set(plan.endpoints.filter(endpoint => endpoint.kind === 'conflict').map(endpoint => endpoint.id)),
    collectionSelected: Boolean(plan.collection),
    collectionUseSpec: true,
  };
}

export type OpenApiApplyResult = {
  requests: SavedRequest[];
  added: SavedRequest[];
  removed: SavedRequest[];
  defaults: CollectionDefaults | null;
  ignored: string[];
  applied: number;
};

export function applyOpenApiPlan(plan: OpenApiSyncPlan, selection: OpenApiSelection, requests: SavedRequest[], collection: Collection): OpenApiApplyResult {
  const replacements = new Map<string, SavedRequest>();
  for (const link of plan.links) {
    const current = requests.find(request => request.id === link.requestId);
    if (current) replacements.set(link.requestId, { ...current, openapi: link.key });
  }
  const removedIds = new Set<string>();
  const added: SavedRequest[] = [];
  const ignored = new Set(collection.openapi?.ignored ?? []);
  let applied = 0;
  for (const endpoint of plan.endpoints) {
    const chosen = selection.selected.has(endpoint.id);
    if (endpoint.kind === 'new') {
      if (chosen && endpoint.request) {
        added.push(endpoint.request);
        applied++;
      } else {
        ignored.add(endpoint.key);
      }
      continue;
    }
    if (endpoint.kind === 'removed') {
      if (chosen && endpoint.requestId) {
        removedIds.add(endpoint.requestId);
        applied++;
      }
      continue;
    }
    if (!chosen || !endpoint.requestId) continue;
    const next = selection.useSpec.has(endpoint.id) ? endpoint.useSpec : endpoint.keepLocal;
    if (next) {
      replacements.set(endpoint.requestId, next);
      applied++;
    }
  }
  for (const key of [...ignored]) {
    if (added.some(request => request.openapi === key)) ignored.delete(key);
  }
  const removed = requests.filter(request => removedIds.has(request.id));
  const nextRequests = requests
    .filter(request => !removedIds.has(request.id))
    .map(request => replacements.get(request.id) ?? request);
  let defaults: CollectionDefaults | null = null;
  if (plan.collection && selection.collectionSelected) {
    defaults = selection.collectionUseSpec ? plan.collection.useSpec : plan.collection.keepLocal;
    applied++;
  }
  return { requests: [...nextRequests, ...added], added, removed, defaults, ignored: [...ignored].sort(), applied };
}

export async function openApiSpecHash(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalSpecText(spec: unknown): string {
  return `${JSON.stringify(spec, null, 2)}\n`;
}
