import { describe, expect, it } from 'vitest';
import { mkRow } from '../lib/constants';
import { makeCollection, normalizeSavedRequest } from '../lib/normalizers';
import { postmanCollectionBundle } from '../lib/postman';
import { postmanV3FromFiles } from '../lib/postmanV3';
import { buildPostmanV3Files } from '../lib/postmanV3Export';
import type { SavedRequest } from '../lib/types/models';
import { parseYaml } from '../lib/yaml';

function row(key: string, value: string) {
  return { ...mkRow(), key, value };
}

function exportFixture() {
  const collection = makeCollection('workspace', 'Service API');
  collection.folderPaths = [['Core API', 'Health'], ['Core-API']];
  collection.defaults.variables = [{ ...row('baseUrl', 'https://api.example.com'), enabled: true }];
  const request = (input: Partial<SavedRequest>) => normalizeSavedRequest(input, [collection], 'workspace');
  const grpc = request({
    name: 'Health Check', requestType: 'grpc', folderPath: ['Core API', 'Health'],
    url: 'grpcs://grpc.example.com:443', grpcMethod: '/grpc.health.v1.Health/Check',
    bodyContent: '{"service":"orders","password":"demo-secret"}',
    grpcMetadata: [
      row('x-tenant', 'acme'),
      { ...row('authorization', 'Bearer demo-secret'), enabled: false },
    ],
    settings: { ...collection.defaults.settings, grpcServerName: 'internal.example', grpcMaxResponseMessageSizeMb: 8 },
    preRequestScriptJs: 'console.log("checking");\n',
  });
  const http = request({
    name: 'Health Check', url: '{{baseUrl}}/items/:id?a=1#item', folderPath: ['Core API', 'Health'],
    params: [{ ...row('a', '1'), description: 'mirrored' }, row('search', 'a b'), row('template', '{{handle}}'), { ...row('off', 'x'), enabled: false }],
    pathParams: [row('id', '12'), { ...row('inactive', '0'), enabled: false }],
  });
  const graphql = request({
    name: 'Viewer', requestType: 'graphql', url: '{{baseUrl}}/graphql',
    bodyContent: JSON.stringify({ query: 'query Viewer { viewer { id } }', variables: '{}', operationName: 'Viewer' }),
  });
  const sse = request({ name: 'Stream', method: 'SSE', url: '{{baseUrl}}/stream' });
  const ws = request({ name: 'WebSocket', requestType: 'ws', url: 'wss://api.example.com' });
  return { collection, grpc, http, graphql, sse, ws };
}

describe('Postman v3 export', () => {
  it('writes a Native Git project with a native gRPC request that imports back into Kurlo', () => {
    const { collection, grpc } = exportFixture();
    const files = buildPostmanV3Files(collection, [grpc], value => value);
    const file = files.find(file => file.path.endsWith('.request.yaml'));
    expect(file?.path).toBe('postman/collections/service-api/core-api/health/health-check.request.yaml');
    const doc = parseYaml(file!.content);
    expect(doc).toMatchObject({
      $kind: 'grpc-request',
      url: 'grpc.example.com:443',
      methodPath: 'grpc.health.v1.Health/Check',
      schema: { source: 'auto' },
      metadata: [{ key: 'x-tenant', value: 'acme' }, { key: 'authorization', value: '', disabled: true }],
      settings: { secureConnection: true, serverNameOverride: 'internal.example', maxResponseMessageSize: 8 * 1024 * 1024 },
      scripts: [{ type: 'beforeInvoke', code: 'console.log("checking");\n', language: 'text/javascript' }],
    });
    expect(file?.content).not.toContain('demo-secret');
    const result = postmanV3FromFiles(files, 'Export');
    expect(result.skipped).toEqual([]);
    const [imported] = result.collections;
    const [request] = postmanCollectionBundle(imported.payload, 'col', imported.name).requests;
    expect(request).toMatchObject({
      name: grpc.name, folderPath: grpc.folderPath, requestType: 'grpc', grpcMethod: 'grpc.health.v1.Health/Check',
      settings: { grpcUseTls: true, grpcMaxResponseMessageSizeMb: 8 },
    });
    expect(JSON.parse(request.bodyContent)).toMatchObject({ service: 'orders', password: '' });
    expect(request.grpcMetadata?.[0]).toMatchObject({ key: 'x-tenant', value: 'acme' });
  });

  it('keeps colliding filenames separate and writes native HTTP, GraphQL, and HTTP streaming requests', () => {
    const { collection, grpc, http, graphql, sse, ws } = exportFixture();
    const files = buildPostmanV3Files(collection, [http, grpc, graphql, sse, ws], value => value, true);
    const docs = Object.fromEntries(files.map(file => [file.path.replace('postman/collections/service-api/', ''), parseYaml(file.content)]));
    expect(docs['core-api-2/.resources/definition.yaml']).toMatchObject({ $kind: 'collection', name: 'Core-API' });
    expect(docs['core-api/health/health-check.request.yaml']).toMatchObject({
      $kind: 'http-request',
      url: '{{baseUrl}}/items/:id?a=1&search=a%20b&template={{handle}}#item',
      queryParams: [
        { key: 'a', value: '1', description: 'mirrored' }, { key: 'search', value: 'a b' },
        { key: 'template', value: '{{handle}}' }, { key: 'off', value: 'x', disabled: true },
      ],
      pathVariables: [{ key: 'id', value: '12' }],
    });
    expect(docs['core-api/health/health-check-2.request.yaml']).toMatchObject({
      $kind: 'grpc-request', metadata: [{ key: 'x-tenant' }, { key: 'authorization', value: 'Bearer demo-secret' }],
    });
    expect(docs['viewer.request.yaml']).toMatchObject({ $kind: 'graphql-request', query: 'query Viewer { viewer { id } }', variables: '{}' });
    expect(docs['stream.request.yaml']).toMatchObject({ $kind: 'http-request', method: 'GET', headers: [{ key: 'Accept', value: 'text/event-stream' }] });
    expect(docs).not.toHaveProperty('websocket.request.yaml');
  });

  it.each([
    ['grpc://grpc.example.com:443/ignored', true, false],
    ['http://grpc.example.com:443/ignored', true, false],
    ['https://grpc.example.com:443/ignored', false, true],
    ['grpc.example.com:443', true, true],
  ])('keeps Kurlo transport semantics for %s', (url, configuredTls, expectedTls) => {
    const { collection, grpc } = exportFixture();
    const files = buildPostmanV3Files(collection, [{
      ...grpc, url, grpcMethod: 'grpc.health.v1.Health.Check',
      settings: { ...grpc.settings, grpcUseTls: configuredTls },
      settingsOverrides: { ...grpc.settingsOverrides, grpcUseTls: true },
    }], value => value);
    const request = files.find(file => file.path.endsWith('.request.yaml'))!;
    expect(parseYaml(request.content)).toMatchObject({
      methodPath: 'grpc.health.v1.Health/Check',
      url: 'grpc.example.com:443',
      settings: { secureConnection: expectedTls },
    });
  });

  it('keeps a manually configured gRPC service without exposing local proto paths', () => {
    const { collection, grpc } = exportFixture();
    const files = buildPostmanV3Files(collection, [{
      ...grpc,
      grpcProtoFilePath: '/private/services/grpc/health.proto',
      settings: { ...grpc.settings, grpcUseReflection: false },
      settingsOverrides: { ...grpc.settingsOverrides, grpcUseReflection: true },
    }], value => value);
    const request = files.find(file => file.path.endsWith('.request.yaml'))!;
    expect(parseYaml(request.content)).toMatchObject({ methodPath: 'grpc.health.v1.Health/Check', schema: { source: 'none' } });
    expect(request.content).not.toContain('/private/');
  });
});
