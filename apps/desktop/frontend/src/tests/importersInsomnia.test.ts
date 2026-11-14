import { testRequest, testRow, strip } from './support/importers';
import { describe, it, expect } from 'vitest';
import { insomniaRequestsFromResources, buildInsomniaExport } from '../lib/insomnia';
import { DEFAULT_REQUEST_SETTINGS } from '../lib/constants';

describe('insomniaRequestsFromResources', () => {
  it('imports v4 request resources with folders, params, headers, and JSON body', () => {
    const payload = {
      resources: [
        { _id: 'wrk_1', _type: 'workspace', name: 'Shop API' },
        { _id: 'fld_1', _type: 'request_group', parentId: 'wrk_1', name: 'Orders' },
        {
          _id: 'req_1',
          _type: 'request',
          parentId: 'fld_1',
          name: 'Create order',
          method: 'POST',
          url: '{{baseUrl}}/orders',
          parameters: [{ name: 'dryRun', value: 'true' }],
          headers: [{ name: 'Authorization', value: 'Bearer {{token}}' }],
          body: { mimeType: 'application/json', text: '{"id":1}' },
        },
      ],
    };

    const requests = insomniaRequestsFromResources(payload, 'collection-1', 'Shop API');

    expect(requests).toHaveLength(1);
    expect(requests[0].folderPath).toEqual(['Orders']);
    expect(requests[0].params[0]).toMatchObject({ key: 'dryRun', value: 'true' });
    expect(requests[0].headers[0]).toMatchObject({ key: 'Authorization', value: 'Bearer {{token}}' });
    expect(requests[0].bodyType).toBe('json');
    expect(requests[0].bodyContent).toBe('{"id":1}');
  });

  it('imports Insomnia GraphQL requests as GraphQL requests', () => {
    const requests = insomniaRequestsFromResources({
      resources: [
        { _id: 'wrk_1', _type: 'workspace', name: 'Workspace' },
        {
          _id: 'req_gql',
          _type: 'request',
          parentId: 'wrk_1',
          name: 'GraphQL viewer',
          method: 'POST',
          url: 'https://api.example.test/graphql',
          body: {
            mimeType: 'application/graphql',
            text: 'query Viewer { viewer { id } }',
          },
        },
      ],
    }, 'collection-1', 'Insomnia API');

    expect(requests[0]).toMatchObject({
      requestType: 'graphql',
      method: 'POST',
      requestTab: 'query',
      bodyType: 'graphql',
    });
    expect(JSON.parse(requests[0].bodyContent)).toMatchObject({
      query: 'query Viewer { viewer { id } }',
      variables: {},
    });
  });

  it('imports Insomnia JSON GraphQL bodies as GraphQL requests', () => {
    const requests = insomniaRequestsFromResources({
      resources: [
        {
          _id: 'req_gql_json',
          _type: 'request',
          name: 'GraphQL JSON',
          method: 'POST',
          url: 'https://api.example.test/graphql',
          body: {
            mimeType: 'application/json',
            text: '{"query":"query Viewer { viewer { id } }","variables":{"id":"123"}}',
          },
        },
      ],
    }, 'collection-1', 'Insomnia API');

    expect(requests[0].requestType).toBe('graphql');
    expect(JSON.parse(requests[0].bodyContent)).toMatchObject({
      query: 'query Viewer { viewer { id } }',
      variables: { id: '123' },
    });
  });

  it('keeps regular Insomnia JSON bodies with query fields as HTTP requests', () => {
    const requests = insomniaRequestsFromResources({
      resources: [
        {
          _id: 'req_search',
          _type: 'request',
          name: 'Search',
          method: 'POST',
          url: 'https://api.example.test/search',
          body: {
            mimeType: 'application/json',
            text: '{"query":"coffee","limit":10}',
          },
        },
      ],
    }, 'collection-1', 'Insomnia API');

    expect(requests[0]).toMatchObject({
      requestType: 'http',
      bodyType: 'json',
      bodyContent: '{"query":"coffee","limit":10}',
    });
  });

  it('imports Insomnia WebSocket and Socket.IO resources', () => {
    const requests = insomniaRequestsFromResources({
      resources: [
        { _id: 'req_ws', _type: 'websocket_request', name: 'WS', url: 'wss://api.example.test/ws' },
        { _id: 'req_sio', _type: 'socketio_request', name: 'SIO', url: 'https://api.example.test/realtime/socket.io/?EIO=3&transport=polling' },
      ],
    }, 'collection-1', 'Insomnia API');

    expect(requests[0]).toMatchObject({ requestType: 'ws', requestTab: 'body', url: 'wss://api.example.test/ws' });
    expect(requests[1]).toMatchObject({
      requestType: 'socketio',
      requestTab: 'events',
      url: 'https://api.example.test/realtime',
      settings: expect.objectContaining({ sioPath: '/socket.io', sioClientVersion: 'v2' }),
    });
  });

  it('round-trips all Kurlo request types through Insomnia export metadata', () => {
    const exported = buildInsomniaExport('Mixed API', '', [
      testRequest({ id: 'req-http', name: 'HTTP', requestType: 'http', url: 'https://api.example.test/ping' }),
      testRequest({
        id: 'req-gql',
        name: 'GraphQL',
        requestType: 'graphql',
        requestTab: 'query',
        bodyType: 'graphql',
        bodyContent: JSON.stringify({ query: '{ viewer { id } }', variables: {} }),
      }),
      testRequest({
        id: 'req-ws',
        name: 'WS',
        requestType: 'ws',
        requestTab: 'body',
        url: 'wss://api.example.test/ws',
        bodyType: 'text',
        rawBodyType: 'text',
        bodyContent: 'hello',
      }),
      testRequest({
        id: 'req-sio',
        name: 'Socket.IO',
        requestType: 'socketio',
        requestTab: 'events',
        url: 'https://api.example.test/realtime',
        settings: { ...DEFAULT_REQUEST_SETTINGS, sioClientVersion: 'v2', sioPath: '/socket.io' },
        sioEvents: [testRow('server:event', '')],
        sioArgs: [{ id: 'arg-1', content: '{"ok":true}', bodyType: 'json', encoding: 'base64' }],
      }),
      testRequest({
        id: 'req-grpc',
        name: 'gRPC',
        requestType: 'grpc',
        requestTab: 'body',
        url: 'grpc.example.test:443',
        bodyType: 'json',
        bodyContent: '{"id":"1"}',
        grpcMethod: 'shop.Inventory/GetItem',
        grpcMetadata: [testRow('authorization', 'Bearer {{token}}')],
      }),
    ], strip, true);

    const imported = insomniaRequestsFromResources(exported, 'collection-2', 'Mixed API');

    expect(imported.map(request => request.requestType)).toEqual(['http', 'graphql', 'ws', 'socketio', 'grpc']);
    expect(imported.find(request => request.requestType === 'socketio')).toMatchObject({
      sioArgs: [expect.objectContaining({ content: '{"ok":true}', bodyType: 'json' })],
      settings: expect.objectContaining({ sioClientVersion: 'v2', sioPath: '/socket.io' }),
    });
    expect(imported.find(request => request.requestType === 'grpc')).toMatchObject({
      grpcMethod: 'shop.Inventory/GetItem',
      grpcMetadata: [expect.objectContaining({ key: 'authorization', value: 'Bearer {{token}}' })],
      bodyContent: '{"id":"1"}',
    });
  });
});
