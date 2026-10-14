import { describe, expect, it } from 'vitest';
import { emptyCollectionDefaults } from '../lib/collectionDefaults';
import { parseGraphQLPayload } from '../lib/graphql';
import { filesystemNameFromName, normalizeCollection, normalizeEnvironment, normalizeHistoryEntry, normalizeSavedRequest, normalizeSioArgs, normalizeWorkspace } from '../lib/normalizers';
import { REQUEST_BODY_DEFAULTS } from '../lib/requestBodyDefaults';
import type { Collection } from '../lib/types/models';

const collection: Collection = {
  id: 'collection-1',
  workspaceId: 'workspace-1',
  name: 'Current collection',
  filesystemName: 'Current-collection',
  description: '',
  collapsed: false,
  defaults: emptyCollectionDefaults(),
};

describe('normalizeSavedRequest', () => {
  it('keeps drafts out of collections when restored from storage', () => {
    const request = normalizeSavedRequest(
      {
        id: 'request-1',
        isDraft: true,
        collectionId: collection.id,
        collection: collection.name,
        method: 'GET',
        url: 'https://example.test/users',
      },
      [collection],
      collection.workspaceId,
    );

    expect(request.isDraft).toBe(true);
    expect(request.collectionId).toBe('');
    expect(request.collection).toBe('');
  });

  it('restores starred requests from storage', () => {
    const request = normalizeSavedRequest(
      {
        id: 'request-1',
        isPinned: true,
        collectionId: collection.id,
        collection: collection.name,
        method: 'GET',
        url: 'https://example.test/users',
      },
      [collection],
      collection.workspaceId,
    );

    expect(request.isPinned).toBe(true);
  });

  it('normalizes websocket request metadata from storage', () => {
    const request = normalizeSavedRequest(
      {
        id: 'request-1',
        name: 'Live feed',
        nameAuto: true,
        collectionId: collection.id,
        collection: collection.name,
        method: 'GET',
        url: 'wss://example.test/socket',
      },
      [collection],
      collection.workspaceId,
    );

    expect(request.requestType).toBe('ws');
    expect(request.nameAuto).toBe(true);
    expect(request.bodyType).toBe(REQUEST_BODY_DEFAULTS.ws.bodyType);
    expect(request.rawBodyType).toBe(REQUEST_BODY_DEFAULTS.ws.rawBodyType);
  });

  it('uses shared body defaults for GraphQL and gRPC requests restored without bodies', () => {
    const graphql = normalizeSavedRequest(
      {
        id: 'request-graphql',
        requestType: 'graphql',
        collectionId: collection.id,
        collection: collection.name,
        url: 'https://example.test/graphql',
      },
      [collection],
      collection.workspaceId,
    );
    const grpc = normalizeSavedRequest(
      {
        id: 'request-grpc',
        requestType: 'grpc',
        collectionId: collection.id,
        collection: collection.name,
        url: 'localhost:50051',
      },
      [collection],
      collection.workspaceId,
    );

    expect(graphql.bodyType).toBe(REQUEST_BODY_DEFAULTS.graphql.bodyType);
    expect(parseGraphQLPayload(graphql.bodyContent).query).toBe(parseGraphQLPayload(REQUEST_BODY_DEFAULTS.graphql.bodyContent).query);
    expect(grpc.bodyType).toBe(REQUEST_BODY_DEFAULTS.grpc.bodyType);
    expect(grpc.bodyContent).toBe(REQUEST_BODY_DEFAULTS.grpc.bodyContent);
  });

  it('uses WS in generated names for unnamed websocket requests', () => {
    const request = normalizeSavedRequest(
      {
        id: 'request-1',
        collectionId: collection.id,
        collection: collection.name,
        method: 'GET',
        url: 'wss://example.test/socket',
      },
      [collection],
      collection.workspaceId,
    );

    expect(request.name).toBe('WS socket');
  });

  it('normalizes gRPC request service metadata from storage', () => {
    const request = normalizeSavedRequest(
      {
        id: 'request-1',
        collectionId: collection.id,
        collection: collection.name,
        requestType: 'grpc',
        method: 'POST',
        url: 'localhost:50051',
        requestTab: 'service',
        bodyContent: '{"id":"1"}',
        grpcMethod: 'acme.Auth/Login',
        grpcMetadata: [{ id: 1, enabled: true, key: 'x-tenant', value: 'core', description: '' }],
        grpcUseReflection: false,
        grpcProtoFilePath: '/tmp/auth.proto',
        grpcProtoFileName: 'auth.proto',
        grpcProtoImportPaths: ['/tmp/protos'],
      },
      [collection],
      collection.workspaceId,
    );

    expect(request.requestType).toBe('grpc');
    expect(request.requestTab).toBe('service');
    expect(request.bodyType).toBe('json');
    expect(request.grpcMethod).toBe('acme.Auth/Login');
    expect(request.grpcUseReflection).toBe(false);
    expect(request.settings.grpcUseReflection).toBe(false);
    expect(request.grpcMetadata?.[0]?.key).toBe('x-tenant');
    expect(request.grpcProtoFileName).toBe('auth.proto');
    expect(request.name).toBe('gRPC localhost:50051');
  });

  it('generates and preserves Bruno-like filesystem names', () => {
    expect(filesystemNameFromName('API [v2] / Auth', 'fallback')).toBe('API-v2-Auth');

    const normalizedWorkspace = normalizeWorkspace({ id: 'workspace-2', name: 'Team Workspace' });
    expect(normalizedWorkspace.filesystemName).toBe('Team-Workspace');

    const normalizedCollection = normalizeCollection({ id: 'collection-2', name: 'Core API' }, collection.workspaceId);
    expect(normalizedCollection.filesystemName).toBe('Core-API');

    const normalizedEnvironment = normalizeEnvironment({ id: 'environment-1', name: 'Local Env' }, collection.workspaceId);
    expect(normalizedEnvironment.filesystemName).toBe('Local-Env');

    const request = normalizeSavedRequest(
      {
        id: 'request-1',
        name: 'Renamed display',
        filesystemName: 'stable-file',
        collectionId: collection.id,
        collection: collection.name,
        method: 'GET',
        url: 'https://example.test/users',
      },
      [collection],
      collection.workspaceId,
    );

    expect(request.name).toBe('Renamed display');
    expect(request.filesystemName).toBe('stable-file');
  });

  it('repairs legacy Socket.IO args without ids', () => {
    const args = normalizeSioArgs([
      { content: '{"ok":true}', bodyType: 'json' },
      { id: '1', content: 'hello', bodyType: 'unknown' as never, encoding: 'hex' },
    ]);

    expect(args).toEqual([
      { id: '1', content: '{"ok":true}', bodyType: 'json', encoding: 'base64' },
      { id: '1-2', content: 'hello', bodyType: 'json', encoding: 'hex' },
    ]);
  });
});

describe('normalizeHistoryEntry', () => {
  const request = { id: 'snapshot-1', name: 'Login', method: 'POST' as const, url: 'https://api.test/login', collectionId: 'collection-1' };

  it('keeps the id of the request a run came from', () => {
    const entry = normalizeHistoryEntry({ id: 'history-1', request, sourceRequestId: 'request-7', statusCode: 200, createdAt: 1 }, [collection], 'workspace-1');
    expect(entry?.sourceRequestId).toBe('request-7');
    expect(entry?.request.id).toBe('snapshot-1');
  });

  it('leaves entries written before the link existed without one', () => {
    const entry = normalizeHistoryEntry({ id: 'history-2', request, statusCode: 200, createdAt: 1 }, [collection], 'workspace-1');
    expect(entry).not.toBeNull();
    expect(entry && 'sourceRequestId' in entry).toBe(false);
  });

  it('keeps the protected mark on an environment and drops it when false', () => {
    expect(normalizeEnvironment({ id: 'environment-prod', name: 'Prod', protected: true }, 'workspace-1').protected).toBe(true);
    expect('protected' in normalizeEnvironment({ id: 'environment-local', name: 'Local', protected: false }, 'workspace-1')).toBe(false);
    expect('protected' in normalizeEnvironment({ id: 'environment-dev', name: 'Dev' }, 'workspace-1')).toBe(false);
  });
});
