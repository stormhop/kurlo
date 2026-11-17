import { parseYaml } from './yaml';
import { asArray, asText, isRecord } from './utils';
import type { KVRow } from './types/models';
import { mkRow } from './constants';

export type PostmanV3File = { path: string; content: string };

export type PostmanV3Collection = {
  root: string;
  name: string;
  payload: Record<string, unknown>;
};

export type PostmanV3VariableSet = {
  scope: 'environment' | 'globals';
  name: string;
  values: KVRow[];
};

export type PostmanV3Skipped = { path: string; reason: string };

export type PostmanV3Import = {
  collections: PostmanV3Collection[];
  variableSets: PostmanV3VariableSet[];
  skipped: PostmanV3Skipped[];
};

type Doc = Record<string, unknown>;

type DirNode = {
  path: string;
  definition: Doc | null;
  requests: Array<{ path: string; doc: Doc }>;
  children: Set<string>;
};

const REQUEST_FILE = /\.request\.ya?ml$/i;
const EXAMPLE_FILE = /\.example\.ya?ml$/i;
const DEFINITION_FILE = /(^|\/)\.resources\/definition\.ya?ml$/i;
const ENVIRONMENT_FILE = /\.environment\.ya?ml$/i;
const GLOBALS_FILE = /\.globals\.ya?ml$/i;
const MIB = 1024 * 1024;

const UNSUPPORTED_KINDS: Record<string, string> = {
  'mqtt-request': 'MQTT requests are not supported',
  'kafka-request': 'Kafka requests are not supported',
  'llm-request': 'LLM requests are not supported',
  'data-request': 'Data requests are not supported',
};

function cleanPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/{2,}/g, '/').replace(/^\/+/, '');
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function joinPath(base: string, relative: string): string {
  const parts = base ? base.split('/') : [];
  for (const segment of cleanPath(relative).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

function insideResources(path: string): boolean {
  return path.split('/').slice(0, -1).some(segment => segment === '.resources' || segment.endsWith('.resources'));
}

function parseDoc(file: PostmanV3File, skipped: PostmanV3Skipped[]): Doc | null {
  try {
    const value = parseYaml(file.content);
    if (isRecord(value)) return value;
    skipped.push({ path: file.path, reason: 'File is not a YAML mapping' });
  } catch (err) {
    skipped.push({ path: file.path, reason: err instanceof Error ? err.message : String(err) });
  }
  return null;
}

function kindOf(doc: Doc): string {
  return asText(doc.$kind).toLowerCase();
}

function stripRequestSuffix(name: string): string {
  return name.replace(REQUEST_FILE, '').replace(EXAMPLE_FILE, '');
}

function orderOf(doc: Doc | null): number {
  const value = doc ? Number(doc.order) : Number.NaN;
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function pairs(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(isRecord).map(item => ({ ...item, key: scalar(item.key ?? item.name), value: scalar(item.value) }));
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([key, entry]) => (isRecord(entry) && ('value' in entry || 'disabled' in entry)
      ? { ...entry, key, value: scalar(entry.value) }
      : { key, value: scalar(entry) }));
  }
  return [];
}

function v2Pairs(value: unknown) {
  return pairs(value)
    .filter(item => asText(item.key) !== '')
    .map(item => ({
      key: asText(item.key),
      value: asText(item.value),
      ...(item.disabled === true || item.enabled === false ? { disabled: true } : {}),
      ...(asText(item.description) ? { description: asText(item.description) } : {}),
    }));
}

function variableRows(value: unknown): KVRow[] {
  return pairs(value)
    .filter(item => asText(item.key) !== '')
    .map(item => {
      const secret = item.secret === true || asText(item.type).toLowerCase() === 'secret';
      return {
        ...mkRow(),
        key: asText(item.key),
        value: secret && item.value === undefined ? '' : asText(item.value),
        enabled: !(item.disabled === true || item.enabled === false),
        description: asText(item.description),
        ...(secret ? { secret: true } : {}),
      };
    });
}

function v2Variables(value: unknown) {
  return variableRows(value).map(row => ({
    key: row.key,
    value: row.value,
    ...(row.enabled ? {} : { disabled: true }),
    ...(row.description ? { description: row.description } : {}),
    ...(row.secret ? { type: 'secret' } : {}),
  }));
}

function v2Auth(value: unknown): Record<string, unknown> | undefined {
  const auth = Array.isArray(value) ? value.find(isRecord) : value;
  if (!isRecord(auth)) return undefined;
  const type = asText(auth.type).toLowerCase();
  if (!type || type === 'inherit') return undefined;
  if (type === 'noauth') return { type: 'noauth' };
  const credentials = Array.isArray(auth.credentials)
    ? auth.credentials.filter(isRecord).map(item => ({ key: asText(item.key), value: item.value }))
    : isRecord(auth.credentials)
      ? Object.entries(auth.credentials).map(([key, entry]) => ({ key, value: entry }))
      : [];
  return { type, [type]: credentials };
}

const PRE_SCRIPT_TYPES = new Set(['beforerequest', 'beforequery', 'beforeinvoke']);
const SCOPED_SCRIPT_PROTOCOLS = new Set(['http']);

function v2Events(value: unknown, scoped: boolean) {
  const events: Array<Record<string, unknown>> = [];
  for (const script of asArray(value)) {
    if (!isRecord(script)) continue;
    const code = asText(script.code);
    if (!code.trim()) continue;
    let type = asText(script.type);
    if (scoped && type.includes(':')) {
      const [protocol, event] = type.split(':', 2);
      if (!SCOPED_SCRIPT_PROTOCOLS.has(protocol.toLowerCase())) continue;
      type = event;
    }
    const lowered = type.toLowerCase();
    const listen = PRE_SCRIPT_TYPES.has(lowered) ? 'prerequest' : lowered === 'afterresponse' ? 'test' : '';
    if (!listen) continue;
    events.push({ listen, script: { type: 'text/javascript', exec: code.split('\n') } });
  }
  return events;
}

function v2Url(url: string, queryParams: unknown, pathVariables: unknown) {
  const query = pairs(queryParams)
    .filter(item => asText(item.key) !== '' || asText(item.value) !== '')
    .map(item => ({
      key: asText(item.key),
      value: asText(item.value),
      ...(item.disabled === true ? { disabled: true } : {}),
      ...(asText(item.description) ? { description: asText(item.description) } : {}),
    }));
  return { raw: url, ...(query.length ? { query } : {}), ...(pathVariables !== undefined ? { variable: v2Pairs(pathVariables) } : {}) };
}

const RAW_LANGUAGES: Record<string, string> = { json: 'json', xml: 'xml', html: 'html', javascript: 'javascript', text: 'text' };

function v2Body(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const type = asText(value.type).toLowerCase();
  const content = value.content;
  if (!type || type === 'none') return undefined;
  if (type in RAW_LANGUAGES) {
    return { mode: 'raw', raw: scalar(content), options: { raw: { language: RAW_LANGUAGES[type] } } };
  }
  if (type === 'urlencoded') return { mode: 'urlencoded', urlencoded: v2Pairs(content) };
  if (type === 'formdata') {
    return {
      mode: 'formdata',
      formdata: asArray(content).filter(isRecord).map(item => {
        const isFile = asText(item.type) === 'file';
        return {
          key: asText(item.key),
          type: isFile ? 'file' : 'text',
          ...(isFile ? { src: Array.isArray(item.src) ? item.src.map(asText) : asText(item.src) } : { value: scalar(item.value) }),
          ...(asText(item.contentType) ? { contentType: asText(item.contentType) } : {}),
          ...(item.disabled === true ? { disabled: true } : {}),
        };
      }),
    };
  }
  if (type === 'file') {
    const src = isRecord(content) ? asText(content.src) : asText(content);
    return { mode: 'file', file: { src } };
  }
  if (type === 'graphql') {
    const graphql = isRecord(content) ? content : {};
    return {
      mode: 'graphql',
      graphql: {
        query: asText(graphql.query),
        variables: asText(graphql.variables),
        ...(asText(graphql.operationName) ? { operationName: asText(graphql.operationName) } : {}),
      },
    };
  }
  return undefined;
}

function protocolProfileBehavior(settings: unknown) {
  if (!isRecord(settings)) return undefined;
  const behavior: Record<string, unknown> = {};
  for (const key of ['strictSSL', 'followRedirects', 'maxRedirects', 'followOriginalHttpMethod', 'followAuthorizationHeader', 'removeRefererHeaderOnRedirect']) {
    if (settings[key] !== undefined) behavior[key] = settings[key];
  }
  return Object.keys(behavior).length ? behavior : undefined;
}

function httpKurloSettings(settings: unknown) {
  if (!isRecord(settings)) return {};
  const result: Record<string, unknown> = {};
  const version = asText(settings.protocolVersion).toLowerCase();
  if (version === 'http1') result.httpVersion = '1.1';
  else if (version === 'http2') result.httpVersion = '2';
  else if (version === 'auto') result.httpVersion = 'auto';
  if (typeof settings.disableUrlEncoding === 'boolean') result.encodeUrlAutomatically = !settings.disableUrlEncoding;
  if (typeof settings.disableCookies === 'boolean') result.disableCookieJar = settings.disableCookies;
  return result;
}

function numberSetting(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function compact(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function realtimeBodyType(value: unknown): 'text' | 'json' | 'xml' | 'html' {
  const type = asText(value).toLowerCase();
  return type === 'json' || type === 'xml' || type === 'html' ? type : 'text';
}

function statusText(code: number, text: string): string {
  return text.trim() === String(code) ? '' : text;
}

function previewLanguage(type: string): string {
  const lowered = type.toLowerCase();
  return ['json', 'xml', 'html', 'javascript'].includes(lowered) ? lowered : 'text';
}

function exampleName(doc: Doc, path: string): string {
  return asText(doc.name) || stripRequestSuffix(basename(path));
}

function v2HttpResponse(doc: Doc, path: string) {
  const request = isRecord(doc.request) ? doc.request : {};
  const response = isRecord(doc.response) ? doc.response : {};
  const body = isRecord(response.body) ? response.body : {};
  const code = Number(response.statusCode) || 0;
  return {
    name: exampleName(doc, path),
    originalRequest: compact({
      method: asText(request.method).toUpperCase() || 'GET',
      url: v2Url(asText(request.url), request.queryParams, request.pathVariables),
      header: v2Pairs(request.headers),
      body: v2Body(request.body),
    }),
    code,
    status: statusText(code, asText(response.statusText)),
    header: v2Pairs(response.headers),
    body: scalar(body.content),
    _postman_previewlanguage: previewLanguage(asText(body.type)),
  };
}

function v2GraphQLResponse(doc: Doc, path: string) {
  const request = isRecord(doc.request) ? doc.request : {};
  const response = isRecord(doc.response) ? doc.response : {};
  const http = isRecord(response.http) ? response.http : null;
  const events = asArray(response.events).filter(isRecord);
  const statusLine = asText(http?.status);
  const code = Number(/\d{3}/.exec(statusLine)?.[0]) || (http ? 0 : 200);
  return {
    name: exampleName(doc, path),
    originalRequest: {
      method: 'POST',
      url: { raw: asText(request.url) },
      header: v2Pairs(request.headers),
      body: { mode: 'graphql', graphql: { query: asText(request.query), variables: asText(request.variables) } },
    },
    code,
    status: statusLine.replace(/^\s*\d{3}\s*/, ''),
    header: v2Pairs(http?.headers),
    body: http ? asText(http.body) : asText(events[events.length - 1]?.content),
    _postman_previewlanguage: 'json',
  };
}

type Context = {
  docs: Map<string, Doc>;
  skipped: PostmanV3Skipped[];
};

function exampleDocs(context: Context, requestPath: string, doc: Doc): Array<{ path: string; doc: Doc }> {
  if (Array.isArray(doc.examples)) {
    return doc.examples.filter(isRecord).map((example, index) => ({ path: `${requestPath}#${index + 1}`, doc: example }));
  }
  const dir = dirname(requestPath);
  const stem = stripRequestSuffix(basename(requestPath));
  const folder = typeof doc.examples === 'string' && doc.examples.trim()
    ? joinPath(dir, doc.examples)
    : joinPath(dir, `.resources/${stem}.resources/examples`);
  const prefix = folder ? `${folder}/` : '';
  const found: Array<{ path: string; doc: Doc }> = [];
  for (const [path, example] of context.docs) {
    if (!EXAMPLE_FILE.test(path) || !path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
    found.push({ path, doc: example });
  }
  return found.sort((a, b) => orderOf(a.doc) - orderOf(b.doc) || a.path.localeCompare(b.path));
}

function requestName(doc: Doc, path: string): string {
  return asText(doc.name).trim() || stripRequestSuffix(basename(path)) || 'Imported Request';
}

function httpItem(context: Context, path: string, doc: Doc) {
  const url = asText(doc.url);
  const responses = exampleDocs(context, path, doc)
    .filter(example => kindOf(example.doc) === 'http-example' || !kindOf(example.doc))
    .map(example => v2HttpResponse(example.doc, example.path));
  const kurloSettings = httpKurloSettings(doc.settings);
  return compact({
    name: requestName(doc, path),
    description: asText(doc.description) || undefined,
    event: v2Events(doc.scripts, false),
    protocolProfileBehavior: protocolProfileBehavior(doc.settings),
    request: compact({
      method: asText(doc.method).toUpperCase() || 'GET',
      url: v2Url(url, doc.queryParams, doc.pathVariables),
      header: v2Pairs(doc.headers),
      body: v2Body(doc.body),
      auth: v2Auth(doc.auth),
      description: asText(doc.description) || undefined,
    }),
    response: responses.length ? responses : undefined,
    'x-kurlo': Object.keys(kurloSettings).length ? { settings: kurloSettings } : undefined,
  });
}

function graphqlItem(context: Context, path: string, doc: Doc) {
  const responses = exampleDocs(context, path, doc)
    .filter(example => kindOf(example.doc) === 'graphql-example')
    .map(example => v2GraphQLResponse(example.doc, example.path));
  return compact({
    name: requestName(doc, path),
    event: v2Events(doc.scripts, false),
    request: compact({
      method: 'POST',
      url: { raw: asText(doc.url) },
      header: v2Pairs(doc.headers),
      body: {
        mode: 'graphql',
        graphql: {
          query: asText(doc.query),
          variables: asText(doc.variables),
          ...(asText(doc.operationName) ? { operationName: asText(doc.operationName) } : {}),
        },
      },
      auth: v2Auth(doc.auth),
      description: asText(doc.description) || undefined,
    }),
    response: responses.length ? responses : undefined,
  });
}

function grpcItem(path: string, doc: Doc) {
  const settings = isRecord(doc.settings) ? doc.settings : {};
  const message = isRecord(doc.message) ? asText(doc.message.content) : asText(doc.message);
  const maxBytes = numberSetting(settings.maxResponseMessageSize);
  return compact({
    name: requestName(doc, path),
    event: v2Events(doc.scripts, false),
    request: compact({
      method: 'POST',
      url: { raw: asText(doc.url) },
      auth: v2Auth(doc.auth),
      description: asText(doc.description) || undefined,
    }),
    'x-kurlo': {
      requestType: 'grpc',
      grpcMethod: asText(doc.methodPath).replace(/^\/+/, ''),
      grpcMetadata: v2Pairs(doc.metadata),
      message,
      settings: compact({
        grpcUseTls: typeof settings.secureConnection === 'boolean' ? settings.secureConnection : undefined,
        enableSSLVerification: typeof settings.strictSSL === 'boolean' ? settings.strictSSL : undefined,
        grpcServerName: asText(settings.serverNameOverride) || undefined,
        grpcIncludeDefaultValues: typeof settings.includeDefaultFields === 'boolean' ? settings.includeDefaultFields : undefined,
        grpcMaxResponseMessageSizeMb: maxBytes !== undefined ? Math.max(1, Math.ceil(maxBytes / MIB)) : undefined,
      }),
    },
  });
}

function websocketItem(path: string, doc: Doc) {
  const settings = isRecord(doc.settings) ? doc.settings : {};
  const messages = asArray(doc.messages).filter(isRecord).map((message, index) => ({
    id: `msg-${index + 1}`,
    name: asText(message.name) || `Message ${index + 1}`,
    content: asText(message.content),
    bodyType: realtimeBodyType(message.contentType),
  }));
  const first = messages[0];
  const maxPayload = numberSetting(settings.maxPayload);
  return compact({
    name: requestName(doc, path),
    request: compact({
      method: 'GET',
      url: v2Url(asText(doc.url), doc.queryParams, undefined),
      header: v2Pairs(doc.headers),
      auth: v2Auth(doc.auth),
      body: first ? { mode: 'raw', raw: first.content, options: { raw: { language: first.bodyType } } } : undefined,
      description: asText(doc.description) || undefined,
    }),
    'x-kurlo': {
      requestType: 'ws',
      ...(messages.length ? { savedMessages: messages } : {}),
      settings: compact({
        wsHandshakeTimeoutMs: numberSetting(settings.handshakeTimeout),
        wsReconnectAttempts: numberSetting(settings.retryCount),
        wsReconnectIntervalMs: numberSetting(settings.retryDelay),
        wsMaxMessageSizeMb: maxPayload !== undefined ? Math.max(1, Math.ceil(maxPayload / MIB)) : undefined,
        enableSSLVerification: typeof settings.strictSSL === 'boolean' ? settings.strictSSL : undefined,
      }),
    },
  });
}

function socketIOArgs(value: unknown) {
  return asArray(value).filter(isRecord).map((arg, index) => {
    const type = asText(arg.contentType).toLowerCase();
    const binary = type === 'hex' || type === 'base64';
    return {
      id: `arg-${index + 1}`,
      content: asText(arg.content),
      bodyType: binary ? 'binary' : realtimeBodyType(type),
      encoding: type === 'hex' ? 'hex' : 'base64',
    };
  });
}

function socketIOItem(path: string, doc: Doc) {
  const settings = isRecord(doc.settings) ? doc.settings : {};
  const messages = asArray(doc.messages).filter(isRecord).map((message, index) => ({
    id: `msg-${index + 1}`,
    name: asText(message.name) || `Message ${index + 1}`,
    event: asText(message.eventName),
    args: socketIOArgs(message.args),
    ack: message.acknowledgement === true,
  }));
  const first = messages[0];
  const version = asText(settings.version);
  return compact({
    name: requestName(doc, path),
    request: compact({
      method: 'GET',
      url: v2Url(asText(doc.url), doc.queryParams, undefined),
      header: v2Pairs(doc.headers),
      auth: v2Auth(doc.auth),
      description: asText(doc.description) || undefined,
    }),
    'x-kurlo': compact({
      requestType: 'socketio',
      sioEvents: asArray(doc.events).filter(isRecord).filter(event => asText(event.name)).map(event => ({
        key: asText(event.name),
        value: '',
        ...(event.subscribeOnConnect === false ? { disabled: true } : {}),
      })),
      sioEventName: first?.event || undefined,
      sioArgs: first?.args.length ? first.args : undefined,
      sioAck: first ? first.ack : undefined,
      savedMessages: messages.length ? messages : undefined,
      settings: compact({
        sioClientVersion: version === '2' ? 'v2' : version ? 'v3' : undefined,
        sioPath: asText(settings.path) || undefined,
        wsHandshakeTimeoutMs: numberSetting(settings.handshakeTimeout),
        wsReconnectAttempts: numberSetting(settings.retryCount),
        wsReconnectIntervalMs: numberSetting(settings.retryDelay),
        enableSSLVerification: typeof settings.strictSSL === 'boolean' ? settings.strictSSL : undefined,
      }),
    }),
  });
}

function mcpCall(message: string) {
  try {
    const parsed = JSON.parse(message) as unknown;
    if (!isRecord(parsed)) return {};
    const params = isRecord(parsed.params) ? parsed.params : {};
    const args = params.arguments;
    return compact({
      mcpMethod: asText(parsed.method) || undefined,
      mcpName: asText(params.name || params.uri) || undefined,
      mcpArguments: args === undefined ? undefined : JSON.stringify(args, null, 2),
    });
  } catch {
    return {};
  }
}

function mcpItem(path: string, doc: Doc) {
  return compact({
    name: requestName(doc, path),
    request: compact({
      method: 'POST',
      url: { raw: asText(doc.url) },
      header: v2Pairs(doc.headers),
      auth: v2Auth(doc.auth),
      description: asText(doc.description) || undefined,
    }),
    'x-kurlo': { requestType: 'mcp', ...mcpCall(asText(doc.message)) },
  });
}

function requestItem(context: Context, path: string, doc: Doc): Record<string, unknown> | null {
  const kind = kindOf(doc);
  if (kind in UNSUPPORTED_KINDS) {
    context.skipped.push({ path, reason: UNSUPPORTED_KINDS[kind] });
    return null;
  }
  if (kind === 'mcp-request' && asText(doc.transport).toLowerCase() === 'stdio') {
    context.skipped.push({ path, reason: 'MCP requests over stdio are not supported' });
    return null;
  }
  const knownKind = ['http-request', 'graphql-request', 'grpc-request', 'websocket-request', 'socket.io-request', 'mcp-request'].includes(kind);
  if (!knownKind) {
    context.skipped.push({ path, reason: kind ? `Unknown item kind ${kind}` : 'Missing $kind' });
    return null;
  }
  if (!asText(doc.url).trim()) {
    context.skipped.push({ path, reason: 'Request has no URL' });
    return null;
  }
  if (kind === 'graphql-request') return graphqlItem(context, path, doc);
  if (kind === 'grpc-request') return grpcItem(path, doc);
  if (kind === 'websocket-request') return websocketItem(path, doc);
  if (kind === 'socket.io-request') return socketIOItem(path, doc);
  if (kind === 'mcp-request') return mcpItem(path, doc);
  return httpItem(context, path, doc);
}

type Sortable = { order: number; name: string; item: Record<string, unknown> };

function folderItems(context: Context, nodes: Map<string, DirNode>, dir: string): Record<string, unknown>[] {
  const node = nodes.get(dir);
  if (!node) return [];
  const entries: Sortable[] = [];
  for (const childPath of node.children) {
    const child = nodes.get(childPath);
    if (!child) continue;
    const definition = child.definition ?? {};
    const name = asText(definition.name).trim() || basename(childPath);
    entries.push({
      order: orderOf(child.definition),
      name,
      item: compact({
        name,
        description: asText(definition.description) || undefined,
        item: folderItems(context, nodes, childPath),
        auth: v2Auth(definition.auth),
        event: v2Events(definition.scripts, true),
      }),
    });
  }
  for (const request of node.requests) {
    const item = requestItem(context, request.path, request.doc);
    if (item) entries.push({ order: orderOf(request.doc), name: asText(item.name), item });
  }
  return entries
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map(entry => entry.item);
}

function isFolderDefinition(definition: Doc | null): boolean {
  return Boolean(definition && Number.isFinite(Number(definition.order)) && definition.variables === undefined);
}

function collectionRoots(nodes: Map<string, DirNode>): string[] {
  if (![...nodes.values()].some(node => node.definition)) return [''];
  const marked = new Set<string>();
  for (const node of nodes.values()) {
    if (node.definition || node.requests.length) marked.add(node.path);
  }
  for (const path of [...marked]) {
    let current = path;
    while (current !== '' && isFolderDefinition(nodes.get(current)?.definition ?? null)) {
      current = dirname(current);
      marked.add(current);
    }
  }
  const hasMarkedAncestor = (path: string) => {
    let current = path;
    while (current !== '') {
      current = dirname(current);
      if (marked.has(current)) return true;
    }
    return false;
  };
  return [...marked].filter(path => !hasMarkedAncestor(path)).sort((a, b) => a.localeCompare(b));
}

function ensureNode(nodes: Map<string, DirNode>, path: string): DirNode {
  let node = nodes.get(path);
  if (!node) {
    node = { path, definition: null, requests: [], children: new Set() };
    nodes.set(path, node);
    if (path !== '') ensureNode(nodes, dirname(path)).children.add(path);
  }
  return node;
}

function pruneEmpty(nodes: Map<string, DirNode>, path: string): boolean {
  const node = nodes.get(path);
  if (!node) return false;
  for (const child of [...node.children]) {
    if (!pruneEmpty(nodes, child)) node.children.delete(child);
  }
  return Boolean(node.definition || node.requests.length || node.children.size);
}

function variableSet(doc: Doc, path: string, scope: 'environment' | 'globals'): PostmanV3VariableSet {
  const fallback = basename(path).replace(scope === 'globals' ? GLOBALS_FILE : ENVIRONMENT_FILE, '');
  return {
    scope,
    name: asText(doc.name).trim() || fallback || (scope === 'globals' ? 'Globals' : 'Environment'),
    values: variableRows(doc.values ?? doc.variables),
  };
}

export function postmanV3FromFiles(input: PostmanV3File[], fallbackName: string): PostmanV3Import {
  const skipped: PostmanV3Skipped[] = [];
  const files = new Map<string, PostmanV3File>();
  for (const file of input) {
    const path = cleanPath(file.path);
    if (path) files.set(path, { path, content: file.content });
  }
  const docs = new Map<string, Doc>();
  const variableSets: PostmanV3VariableSet[] = [];
  const nodes = new Map<string, DirNode>();
  ensureNode(nodes, '');
  for (const [path, file] of files) {
    const isRequest = REQUEST_FILE.test(path) && !insideResources(path);
    const isDefinition = DEFINITION_FILE.test(path);
    const isExample = EXAMPLE_FILE.test(path);
    const isEnvironment = ENVIRONMENT_FILE.test(path);
    const isGlobals = GLOBALS_FILE.test(path);
    if (!isRequest && !isDefinition && !isExample && !isEnvironment && !isGlobals) continue;
    const doc = parseDoc(file, skipped);
    if (!doc) continue;
    docs.set(path, doc);
    if (isEnvironment || isGlobals) {
      variableSets.push(variableSet(doc, path, isGlobals ? 'globals' : 'environment'));
    } else if (isDefinition) {
      if (kindOf(doc) && kindOf(doc) !== 'collection') continue;
      ensureNode(nodes, dirname(dirname(path))).definition = doc;
    } else if (isRequest) {
      ensureNode(nodes, dirname(path)).requests.push({ path, doc });
    }
  }
  pruneEmpty(nodes, '');
  const context: Context = { docs, skipped };
  const collections: PostmanV3Collection[] = [];
  for (const root of collectionRoots(nodes)) {
    const node = nodes.get(root)!;
    const definition = node.definition ?? {};
    const name = asText(definition.name).trim() || (root ? basename(root) : fallbackName) || 'Postman Collection';
    const items = folderItems(context, nodes, root);
    if (!items.length && !node.definition) continue;
    collections.push({
      root,
      name,
      payload: compact({
        info: compact({
          name,
          description: asText(definition.description) || undefined,
          schema: 'https://schema.postman.com/collection/json/v3.0.0/draft-07/collection.json',
        }),
        item: items,
        variable: v2Variables(definition.variables),
        auth: v2Auth(definition.auth),
        event: v2Events(definition.scripts, true),
      }),
    });
  }
  variableSets.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'environment' ? -1 : 1));
  return { collections, variableSets, skipped };
}
