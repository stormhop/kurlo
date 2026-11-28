import { describe, expect, it } from 'vitest';
import { methodColor, requestKindFor, requestKindFromTransportLabel, requestTransportLabel } from '../lib/utils';
import { normalizeSavedRequest } from '../lib/normalizers';

describe('request labels', () => {
  it('shows Socket.IO transport instead of the saved HTTP method', () => {
    expect(requestTransportLabel({ requestType: 'socketio', method: 'GET', url: 'localhost:3001' })).toBe('Socket.IO');
  });

  it('colors mixed-case realtime transport labels', () => {
    expect(methodColor('Socket.IO')).toBe('method-sio');
    expect(methodColor('GraphQL')).toBe('method-graphql');
    expect(methodColor('gRPC')).toBe('method-grpc');
  });

  it('shows gRPC transport instead of the saved HTTP method', () => {
    expect(requestTransportLabel({ requestType: 'grpc', method: 'POST', url: 'localhost:50051' })).toBe('gRPC');
  });

  it('maps every transport label back to the kind whose icon it shows', () => {
    const types = ['graphql', 'ws', 'socketio', 'grpc', 'kafka', 'mqtt', 'mcp', 'ai'] as const;
    for (const requestType of types) {
      const label = requestTransportLabel({ requestType, method: 'POST', url: 'localhost:1' });
      expect(requestKindFromTransportLabel(label)).toBe(requestKindFor({ requestType }));
    }
    expect(requestKindFromTransportLabel('DELETE')).toBe('http');
    expect(requestKindFromTransportLabel('SSE')).toBe('sse');
  });
});

describe('SSE requests and the Scripts tab', () => {
  it('moves a saved SSE request off the scripts tab', () => {
    const req = normalizeSavedRequest({ method: 'SSE', url: 'https://example.test/events', requestTab: 'scripts' }, [], 'ws-1');
    expect(req.requestTab).toBe('params');
  });

  it('leaves an ordinary HTTP request on the scripts tab', () => {
    const req = normalizeSavedRequest({ method: 'GET', url: 'https://example.test', requestTab: 'scripts' }, [], 'ws-1');
    expect(req.requestTab).toBe('scripts');
  });
});
