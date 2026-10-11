#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const defaults = {
  out: join(root, 'perf', 'fixtures'),
  requests: 5000,
  folders: 500,
  history: 10000,
  responseMb: 50,
  collections: 5,
};

function readArgs(argv) {
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--out' && next) { out.out = next; i += 1; }
    else if (arg === '--requests' && next) { out.requests = positiveInt(next, 'requests'); i += 1; }
    else if (arg === '--folders' && next) { out.folders = positiveInt(next, 'folders'); i += 1; }
    else if (arg === '--history' && next) { out.history = positiveInt(next, 'history'); i += 1; }
    else if (arg === '--response-mb' && next) { out.responseMb = positiveInt(next, 'response-mb'); i += 1; }
    else if (arg === '--collections' && next) { out.collections = positiveInt(next, 'collections'); i += 1; }
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function positiveInt(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function printHelp() {
  console.log(`Generate Kurlo performance fixtures.

Options:
  --out <dir>             Output directory. Default: perf/fixtures
  --requests <count>      Saved requests. Default: ${defaults.requests}
  --folders <count>       Folder paths. Default: ${defaults.folders}
  --history <count>       History entries. Default: ${defaults.history}
  --response-mb <count>   Huge response size in MiB. Default: ${defaults.responseMb}
  --collections <count>   Collections. Default: ${defaults.collections}
`);
}

function safeSegment(value, fallback = 'item') {
  const next = String(value || fallback)
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);
  return next || fallback;
}

function row(id, key, value, extra = {}) {
  return { id, enabled: true, key, value, description: '', ...extra };
}

function defaultAuth() {
  return {
    type: 'none',
    bearerToken: '',
    basicUser: '',
    basicPass: '',
    apiKeyName: '',
    apiKeyValue: '',
    apiKeyIn: 'header',
    oauth2TokenURL: '',
    oauth2ClientID: '',
    oauth2Secret: '',
    oauth2Scope: '',
    oauth2Token: '',
    awsAccessKey: '',
    awsSecretKey: '',
    awsRegion: '',
    awsService: '',
  };
}

function defaultSettings() {
  return {
    httpVersion: 'auto',
    enableSSLVerification: true,
    followRedirects: true,
    followOriginalMethod: false,
    followAuthorizationHeader: false,
    removeRefererHeader: false,
    encodeUrlAutomatically: true,
    disableCookieJar: false,
    maxRedirects: 10,
    timeoutMs: 30000,
    scriptTimeoutMs: 0,
    allowSendRequest: true,
    proxyUrl: '',
    browserEmulation: false,
    browserOrigin: '',
    browserWithCredentials: false,
    browserEnforceCORS: false,
    browserEnforceCSP: false,
    browserCSP: '',
    wsHandshakeTimeoutMs: 10000,
    wsReconnectAttempts: 0,
    wsReconnectIntervalMs: 1000,
    wsMaxMessageSizeMb: 16,
    sioClientVersion: 'v3',
    sioPath: '/socket.io',
    sioNamespace: '/',
    grpcUseTls: false,
    grpcUseReflection: true,
    grpcServerName: '',
    grpcIncludeDefaultValues: true,
    grpcMaxResponseMessageSizeMb: 10,
  };
}

function folderPath(index) {
  const area = Math.floor(index / 100);
  const group = Math.floor((index % 100) / 10);
  const flow = index % 10;
  return [`Area ${String(area).padStart(3, '0')}`, `Group ${group}`, `Flow ${flow}`];
}

function requestTypeFor(index) {
  const types = ['http', 'http', 'http', 'graphql', 'grpc', 'ws', 'socketio'];
  return types[index % types.length];
}

function methodFor(type, index) {
  if (type === 'graphql' || type === 'grpc') return 'POST';
  if (type === 'ws' || type === 'socketio') return 'GET';
  if (index % 19 === 0) return 'SSE';
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'][index % 5];
}

function makeExamples(id, index) {
  if (index % 25 !== 0) return [];
  return [{
    id: `${id}-example-ok`,
    requestId: id,
    name: 'OK',
    filesystemName: 'ok',
    source: 'captured',
    snapshot: { method: 'GET', url: `https://api.example.test/v1/resources/${index}` },
    response: {
      statusCode: 200,
      status: '200 OK',
      bodyMediaType: 'application/json',
      body: JSON.stringify({ id, ok: true }, null, 2),
      headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
    },
    match: { pathTemplate: `/v1/resources/${index}` },
  }];
}

function requestSettings(index, collection) {
  if (index % 13 !== 0) return { settings: { ...collection.defaults.settings }, settingsOverrides: {} };
  return { settings: { ...collection.defaults.settings, timeoutMs: 5000 + index }, settingsOverrides: { timeoutMs: true } };
}

function requestName(method, index) {
  const serial = String(index).padStart(5, '0');
  if (index % 9 === 4) return `${method} Заказ ${serial} 🚀`;
  if (index % 9 === 7) return `${method} 注文 ${serial}`;
  return `${method} Fixture ${serial}`;
}

function makeRequest(index, collection) {
  const type = requestTypeFor(index);
  const method = methodFor(type, index);
  const id = `req-${String(index).padStart(5, '0')}`;
  const name = requestName(method, index);
  const isGraphQL = type === 'graphql';
  const isGrpc = type === 'grpc';
  const isRealtime = type === 'ws' || type === 'socketio';
  return {
    id,
    name,
    filesystemName: safeSegment(name, id),
    nameAuto: false,
    requestType: type,
    isDraft: false,
    isPinned: index % 37 === 0,
    collectionId: collection.id,
    collection: collection.name,
    folderPath: folderPath(index % Math.max(1, options.folders)),
    method,
    url: isGrpc
      ? 'grpc://localhost:50051'
      : isRealtime
        ? `wss://stream.example.test/socket/${index}`
        : `https://api.example.test/v1/resources/${index}?page={{page}}`,
    requestTab: isGraphQL ? 'query' : isGrpc || isRealtime ? 'body' : 'params',
    params: [row(1, 'page', String((index % 20) + 1)), row(2, 'fixture', `request-${index}`)],
    headers: [row(3, 'Accept', 'application/json'), row(4, 'X-Fixture-ID', id)],
    auth: index % 11 === 0 ? { ...defaultAuth(), type: 'bearer', bearerToken: '{{token}}' } : defaultAuth(),
    bodyType: isGraphQL ? 'graphql' : isGrpc ? 'json' : isRealtime ? 'text' : method === 'GET' || method === 'SSE' ? 'none' : 'json',
    rawBodyType: isRealtime ? 'text' : 'json',
    bodyContent: isGraphQL
      ? JSON.stringify({ query: 'query Fixture($id: ID!) { node(id: $id) { id } }', variables: { id }, operationName: 'Fixture' }, null, 2)
      : isGrpc
        ? JSON.stringify({ id, nested: { index } }, null, 2)
        : isRealtime
          ? JSON.stringify({ subscribe: id })
          : method === 'GET' || method === 'SSE'
            ? ''
            : JSON.stringify({ id, name, values: Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, value: `${id}-${i}` })) }, null, 2),
    bodyFilePath: '',
    bodyFileName: '',
    formRows: [],
    graphqlSchema: isGraphQL ? 'type Query { node(id: ID!): Node }\ntype Node { id: ID! }' : '',
    preRequestScript: '',
    testScript: '',
    preRequestScriptJs: 'pm.variables.set("fixtureRequestId", pm.request.url)',
    testScriptJs: 'pm.test("status under 500", () => pm.expect(pm.response.code).to.be.below(500))',
    requestNotes: `Generated performance fixture request ${index}.`,
    ...requestSettings(index, collection),
    examples: makeExamples(id, index),
    sioEvents: type === 'socketio' ? [row(5, 'message', '', { description: 'fixture event' })] : [],
    sioEventName: type === 'socketio' ? 'message' : '',
    sioArgs: type === 'socketio' ? [{ id: '1', content: '{"ok":true}', bodyType: 'json', encoding: 'base64' }] : [{ id: '1', content: '', bodyType: 'text', encoding: 'base64' }],
    sioAck: false,
    grpcMethod: isGrpc ? 'fixture.FixtureService/GetFixture' : '',
    grpcMetadata: isGrpc ? [row(6, 'x-fixture-id', id)] : [],
    grpcUseReflection: true,
    grpcProtoFilePath: '',
    grpcProtoFileName: '',
    grpcProtoImportPaths: [],
  };
}

function writeJSON(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function makeHugeResponse(targetBytes) {
  const item = index => ({
    id: `item-${index}`,
    status: index % 11 === 0 ? 'warning' : 'ok',
    url: `https://api.example.test/v1/resources/${index}`,
    metadata: {
      owner: `team-${index % 17}`,
      tags: [`tag-${index % 9}`, `area-${index % 23}`],
      note: 'payload intentionally repeats predictable text for search and rendering benchmarks',
    },
    values: Array.from({ length: 8 }, (_, i) => ({ key: `metric_${i}`, value: index * (i + 1) })),
  });
  const rows = [];
  let bytes = 2;
  for (let i = 0; bytes < targetBytes; i += 1) {
    const rendered = JSON.stringify(item(i), null, 2);
    rows.push(rendered);
    bytes += rendered.length + 2;
  }
  return `[\n${rows.join(',\n')}\n]\n`;
}

const options = readArgs(process.argv.slice(2));
const historyNow = Date.now();

rmSync(options.out, { recursive: true, force: true });
mkdirSync(options.out, { recursive: true });

const workspace = {
  id: 'workspace-perf',
  name: 'Performance Workspace',
  filesystemName: 'Performance-Workspace',
  description: 'Generated Kurlo performance workspace.',
};
const collections = Array.from({ length: options.collections }, (_, index) => ({
  id: `collection-${index + 1}`,
  workspaceId: workspace.id,
  name: `Performance Collection ${index + 1}`,
  filesystemName: `Performance-Collection-${index + 1}`,
  description: `Generated collection ${index + 1}.`,
  collapsed: true,
  folderPaths: Array.from({ length: options.folders }, (_, folderIndex) => folderPath(folderIndex)),
  defaults: {
    headers: [row(1, 'X-Collection', `perf-${index + 1}`)],
    variables: [row(2, 'baseUrl', 'https://api.example.test'), row(3, 'token', `perf-token-${index + 1}`, { secret: true })],
    auth: defaultAuth(),
    preRequestScript: '',
    testScript: '',
    preRequestScriptJs: '',
    testScriptJs: '',
    settings: index === 0
      ? { ...defaultSettings(), browserEmulation: true, browserEnforceCORS: true, browserOrigin: 'https://app.example.com', browserWithCredentials: true }
      : defaultSettings(),
  },
}));

const requests = Array.from({ length: options.requests }, (_, index) => makeRequest(index, collections[index % collections.length]));
const environments = [{
  id: 'environment-perf',
  workspaceId: workspace.id,
  name: 'Perf Local',
  filesystemName: 'Perf-Local',
  values: [
    row(1, 'baseUrl', 'https://api.example.test'),
    row(2, 'page', '1'),
    row(3, 'token', 'perf-local-secret', { secret: true }),
  ],
}];
const history = Array.from({ length: options.history }, (_, index) => {
  const request = requests[index % requests.length];
  return {
    id: `history-${String(index).padStart(5, '0')}`,
    request,
    statusCode: index % 23 === 0 ? 500 : index % 7 === 0 ? 204 : 200,
    status: index % 23 === 0 ? '500 Internal Server Error' : index % 7 === 0 ? '204 No Content' : '200 OK',
    duration: 20 + (index % 1800),
    createdAt: historyNow - index * 60000,
  };
});
const cookies = Array.from({ length: Math.min(1000, Math.max(20, Math.floor(options.requests / 10))) }, (_, index) => ({
  name: `perf_${index}`,
  value: `value-${index}`,
  domain: index % 2 === 0 ? 'api.example.test' : `tenant-${index % 25}.example.test`,
  path: index % 3 === 0 ? '/v1' : '/',
  expiresAt: 0,
  session: true,
  secure: index % 4 === 0,
  httpOnly: index % 5 === 0,
  sameSite: index % 3 === 0 ? 'lax' : '',
  hostOnly: index % 2 === 0,
}));

writeJSON(join(options.out, 'request-store-large.json'), {
  version: 2,
  activeId: requests[0]?.id ?? '',
  activeWorkspaceId: workspace.id,
  activeEnvironmentId: environments[0].id,
  openIds: requests.slice(0, 12).map(request => request.id),
  folderCollapsed: {},
  workspaces: [workspace],
  collections,
  environments,
  requests,
  history,
  workspaceCookies: { [workspace.id]: cookies },
});

writeFileSync(join(options.out, 'huge-response.json'), makeHugeResponse(options.responseMb * 1024 * 1024));

const yamlRoot = join(options.out, 'kurlo-yaml-large');
const build = spawnSync('go', ['test', './internal/api', '-run', '^TestPerfFixtureWorkspace$', '-count=1', '-v'], {
  cwd: join(root, 'apps', 'desktop'),
  env: { ...process.env, KURLO_PERF_STORE: join(options.out, 'request-store-large.json'), KURLO_PERF_WORKSPACE: yamlRoot },
  encoding: 'utf8',
});
const report = `${build.stdout ?? ''}${build.stderr ?? ''}`;
for (const line of report.split('\n')) {
  if (line.includes('perf fixture:')) console.log(line.trim().replace(/^.*perf fixture:\s*/, ''));
}
if (build.status !== 0) {
  console.error(report);
  throw new Error('Building the YAML workspace with the Kurlo writer failed');
}

writeJSON(join(options.out, 'manifest.json'), {
  generatedAt: new Date().toISOString(),
  options,
  files: {
    requestStore: 'request-store-large.json',
    hugeResponse: 'huge-response.json',
    yamlWorkspace: 'kurlo-yaml-large/',
  },
  counts: {
    workspaces: 1,
    collections: collections.length,
    folderPaths: options.folders,
    requests: requests.length,
    examples: requests.reduce((total, request) => total + request.examples.length, 0),
    history: history.length,
    environments: environments.length,
    cookies: cookies.length,
  },
  checks: [
    'collections sidebar expand/collapse/search',
    'history date collapse/search',
    'response viewer huge JSON pagination/search',
    'Git/YAML workspace diagnostics',
    'manual-save dirty state with many open tabs',
  ],
});

console.log(`Generated Kurlo perf fixtures in ${options.out}`);
