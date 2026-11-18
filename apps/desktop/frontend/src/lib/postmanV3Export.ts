import { inheritedAuth, inheritedHeaderRows, mergeCollectionSettings, mergeDefaultRows } from './collectionDefaults';
import { normalizeFolderPath } from './collections';
import { exportBodyLikeValue, postmanAuthFromKurlo, postmanBodyFromKurlo, postmanRequestScriptSources } from './postman';
import type { PostmanV3File } from './postmanV3';
import { parseQuery, splitUrl } from './queryParams';
import { DEFAULT_GRPC_MESSAGE } from './requestBodyDefaults';
import { safeExportRow, safeExportUrl, safeExportValue } from './secretExport';
import type { AuthState, Collection, CollectionDefaults, FolderDefaults, KVRow, SavedRequest } from './types/models';
import { yamlMap } from './yaml';

type StripBody = (source: string, type: string) => string;
type Pair = ReturnType<typeof pairs>[number];
type Nodes = { files: PostmanV3File[]; collection: Collection; includeSecrets: boolean; stripBody: StripBody };

export function postmanV3FolderName(name: string) {
  const stem = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 64) || 'collection';
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(stem) ? `_${stem}` : stem;
}

export function isPostmanV3Exportable(request: SavedRequest) {
  return !request.requestType || ['http', 'graphql', 'grpc'].includes(request.requestType);
}

function pairs(rows: KVRow[] | undefined, includeSecrets: boolean) {
  return (rows ?? []).filter(row => row.key).map(row => {
    const { key, value, description, enabled } = safeExportRow(row, includeSecrets);
    return { key, value, description: description || undefined, disabled: enabled ? undefined : true };
  });
}

function authConfig(auth: AuthState, includeSecrets: boolean, grpc = false) {
  if (auth.type === 'inherit') return undefined;
  const config = grpc && auth.type === 'apikey' ? { ...auth, apiKeyIn: 'header' as const } : auth;
  const exported = postmanAuthFromKurlo(config, includeSecrets);
  if (!exported || (grpc && !['noauth', 'basic', 'bearer', 'apikey', 'oauth2'].includes(exported.type))) return { type: 'noauth' };
  const { type } = exported;
  const credentials = (exported as Record<string, unknown>)[type] as { key: string; value: string | boolean }[] | undefined;
  return { type, credentials: credentials?.map(({ key, value }) => ({ key, value })) };
}

function scripts(beforeType: string, afterType: string, before: string, after: string) {
  return [{ type: beforeType, code: before }, { type: afterType, code: after }]
    .filter(entry => entry.code.trim())
    .map(entry => ({ ...entry, language: 'text/javascript' }));
}

function definition(name: string, description: string, order: number | undefined, defaults: CollectionDefaults | FolderDefaults | undefined, includeSecrets: boolean) {
  const hooks = defaults ? [
    ...scripts('http:beforeRequest', 'http:afterResponse', defaults.preRequestScriptJs, defaults.testScriptJs),
    ...scripts('graphql:beforeQuery', 'graphql:afterResponse', defaults.preRequestScriptJs, defaults.testScriptJs),
    ...scripts('grpc:beforeInvoke', 'grpc:afterResponse', defaults.preRequestScriptJs, defaults.testScriptJs),
  ] : [];
  return {
    $kind: 'collection', name, description: description || undefined, order,
    variables: defaults && 'variables' in defaults ? pairs(defaults.variables, includeSecrets) : undefined,
    auth: defaults ? authConfig(defaults.auth, includeSecrets) : undefined,
    scripts: hooks.length ? hooks : undefined,
  };
}

function encodeQueryPart(value: string) {
  return value.split(/(\{\{[^{}]+\}\})/).map((part, i) => i % 2 ? part : encodeURIComponent(part)).join('');
}

function urlWithQuery(request: SavedRequest, includeSecrets: boolean) {
  const { head, query, hash } = splitUrl(request.url.trim());
  const remaining = request.params.filter(row => row.key);
  const params: Pair[] = parseQuery(query).map(raw => {
    const decoded = Array.from(new URLSearchParams(`key=${raw.key}&value=${raw.value}`).values());
    const mirrored = remaining.findIndex(row => row.enabled &&
      ((row.key === raw.key && row.value === raw.value) || (row.key === decoded[0] && row.value === decoded[1])));
    if (mirrored >= 0) return pairs(remaining.splice(mirrored, 1), includeSecrets)[0];
    return { key: decoded[0], value: safeExportValue(decoded[0], decoded[1], includeSecrets), description: undefined, disabled: undefined };
  });
  params.push(...pairs(remaining, includeSecrets));
  const queryString = params.filter(pair => !pair.disabled)
    .map(pair => `${encodeQueryPart(pair.key)}=${encodeQueryPart(pair.value)}`).join('&');
  const url = `${safeExportUrl(head, includeSecrets)}${queryString ? `?${queryString}` : ''}${hash}`;
  return { url, queryParams: params.length ? params : undefined };
}

function grpcTarget(url: string, defaultTLS: boolean) {
  const match = /^(?:(grpcs?|https?):)?\/\/([^/?#]*)/i.exec(url);
  if (!match) return { url: url.split('/')[0], secureConnection: defaultTLS };
  const scheme = match[1]?.toLowerCase();
  const authority = match[2];
  return { url: authority.slice(authority.lastIndexOf('@') + 1), secureConnection: scheme === 'grpcs' || scheme === 'https' };
}

function grpcMethodPath(method: string | undefined) {
  const name = method?.trim().replace(/^\/+/, '');
  return name?.includes('/') ? name : name?.replace(/^(.+)\.([^.]+)$/, '$1/$2') || undefined;
}

function httpBody(request: SavedRequest, nodes: Nodes) {
  const body = postmanBodyFromKurlo(request, nodes.stripBody, nodes.includeSecrets);
  switch (body?.mode) {
    case 'raw': return { type: body.options?.raw.language || 'text', content: body.raw };
    case 'formdata': return { type: body.mode, content: body.formdata };
    case 'urlencoded': return { type: body.mode, content: body.urlencoded };
    case 'file': return { type: body.mode, content: body.file };
    default: return undefined;
  }
}

function requestDoc(req: SavedRequest, order: number, nodes: Nodes) {
  const { includeSecrets, collection } = nodes;
  const settings = mergeCollectionSettings(collection.defaults.settings, req.settings, req.settingsOverrides);
  const headers = pairs(mergeDefaultRows(inheritedHeaderRows(collection, req.folderPath), req.headers), includeSecrets);
  const { before, after } = postmanRequestScriptSources(req, includeSecrets);
  const common = { name: req.name || 'Request', description: req.requestNotes || undefined, order };
  if (req.requestType === 'grpc') {
    const target = grpcTarget(safeExportUrl(req.url.trim(), includeSecrets), settings.grpcUseTls);
    const inherited = req.auth.type === 'inherit' ? inheritedAuth(collection, req.folderPath) : undefined;
    const auth = authConfig(inherited ?? req.auth, includeSecrets, true);
    return {
      $kind: 'grpc-request', ...common, url: target.url,
      methodPath: grpcMethodPath(req.grpcMethod),
      schema: { source: settings.grpcUseReflection ? 'auto' : 'none' },
      message: { content: exportBodyLikeValue(req.bodyContent || DEFAULT_GRPC_MESSAGE, 'json', nodes.stripBody, includeSecrets) },
      metadata: pairs(req.grpcMetadata, includeSecrets),
      auth,
      settings: {
        secureConnection: target.secureConnection,
        strictSSL: settings.enableSSLVerification,
        serverNameOverride: settings.grpcServerName || undefined,
        maxResponseMessageSize: settings.grpcMaxResponseMessageSizeMb * 1024 * 1024,
        includeDefaultFields: settings.grpcIncludeDefaultValues,
      },
      scripts: scripts('beforeInvoke', 'afterResponse', before, after),
    };
  }
  const { url, queryParams } = urlWithQuery(req, includeSecrets);
  const auth = authConfig(req.auth, includeSecrets);
  if (req.requestType === 'graphql' || req.bodyType === 'graphql') {
    const body = postmanBodyFromKurlo(req, nodes.stripBody, includeSecrets)?.graphql;
    return {
      $kind: 'graphql-request', ...common, url, headers, auth,
      query: body?.query ?? '', variables: body?.variables || '{}',
      scripts: scripts('beforeQuery', 'afterResponse', before, after),
    };
  }
  const sse = req.method === 'SSE';
  if (sse && !headers.some(row => row.key.toLowerCase() === 'accept' && !row.disabled)) {
    headers.push({ key: 'Accept', value: 'text/event-stream', description: undefined, disabled: undefined });
  }
  return {
    $kind: 'http-request', ...common, url, method: sse ? 'GET' : req.method, headers, auth, queryParams,
    pathVariables: pairs(req.pathParams, includeSecrets).filter(pair => !pair.disabled).map(({ key, value, description }) => ({ key, value, description })),
    body: httpBody(req, nodes),
    settings: {
      protocolVersion: settings.httpVersion === '1.1' ? 'http1' : settings.httpVersion === '2' ? 'http2' : 'auto',
      strictSSL: settings.enableSSLVerification,
      followRedirects: settings.followRedirects,
      maxRedirects: settings.maxRedirects,
    },
    scripts: scripts('beforeRequest', 'afterResponse', before, after),
  };
}

type Folder = { path: string[]; requests: SavedRequest[]; folders: Map<string, Folder>; defaults?: FolderDefaults };

function folderFor(root: Folder, path: string[] | undefined) {
  return normalizeFolderPath(path ?? []).reduce((parent, name) => {
    let child = parent.folders.get(name);
    if (!child) {
      child = { path: [...parent.path, name], requests: [], folders: new Map() };
      parent.folders.set(name, child);
    }
    return child;
  }, root);
}

function uniqueStem(name: string, used: Set<string>) {
  const base = postmanV3FolderName(name);
  let stem = base;
  for (let n = 2; used.has(stem); n++) stem = `${base}-${n}`;
  used.add(stem);
  return stem;
}

function writeFolder(nodes: Nodes, folder: Folder, path: string, order?: number) {
  const name = folder.path.at(-1) ?? nodes.collection.name;
  const defaults = folder.path.length ? folder.defaults : nodes.collection.defaults;
  const description = folder.path.length ? '' : nodes.collection.description;
  nodes.files.push({ path: `${path}/.resources/definition.yaml`, content: yamlMap(definition(name, description, order, defaults, nodes.includeSecrets), { preserveMultiline: true }) });
  const requestNames = new Set<string>();
  const folderNames = new Set<string>();
  for (const [index, req] of folder.requests.entries()) {
    const stem = uniqueStem(req.name, requestNames);
    nodes.files.push({ path: `${path}/${stem}.request.yaml`, content: yamlMap(requestDoc(req, (index + 1) * 1000, nodes), { preserveMultiline: true }) });
  }
  for (const [index, [name, child]] of Array.from(folder.folders).entries()) {
    writeFolder(nodes, child, `${path}/${uniqueStem(name, folderNames)}`, (folder.requests.length + index + 1) * 1000);
  }
}

export function buildPostmanV3Files(collection: Collection, requests: SavedRequest[], stripBody: StripBody, includeSecrets = false): PostmanV3File[] {
  const root: Folder = { path: [], requests: [], folders: new Map() };
  for (const path of collection.folderPaths ?? []) folderFor(root, path);
  for (const defaults of collection.folderDefaults ?? []) folderFor(root, defaults.path).defaults = defaults;
  for (const request of requests.filter(isPostmanV3Exportable)) folderFor(root, request.folderPath).requests.push(request);
  const nodes: Nodes = { files: [], collection, includeSecrets, stripBody };
  writeFolder(nodes, root, `postman/collections/${postmanV3FolderName(collection.name)}`);
  return nodes.files;
}
