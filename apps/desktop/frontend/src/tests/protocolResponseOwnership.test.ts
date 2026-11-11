import { describe, expect, it } from 'vitest';
import { grpcFeature } from '../lib/stores/features/grpc';
import { mcpFeature } from '../lib/stores/features/mcp';

function host() {
  const visible = { body: 'visible', grpcCode: 'OK', messages: [], testResult: { tests: [] } };
  return {
    activeRequestId: 'visible',
    requestError: 'visible error',
    grpcResponse: visible,
    grpcResponses: new Map([['visible', visible]]),
    grpcResponseTab: 'trailers',
    grpcResponseTabs: new Map([['visible', 'trailers']]),
    mcpResponse: visible,
    mcpResponses: new Map([['visible', visible]]),
    requestIsActive: (id: string) => id === 'visible',
    requestForEditing: (id: string) => id === 'deleted' ? undefined : { id },
  };
}

describe('protocol response ownership', () => {
  it('stores background MCP results without replacing the visible result', () => {
    const state = host();
    const visible = state.mcpResponse;
    const result = { ...visible, body: 'background' };
    mcpFeature.setActiveMcpResponse.call(state as never, result as never, 'background');
    expect(state.mcpResponse).toBe(visible);
    expect(state.mcpResponses.get('background')).toBe(result);
  });

  it('stores background gRPC results and tabs without replacing visible fields', () => {
    const state = host();
    const visible = state.grpcResponse;
    const result = { ...visible, body: 'background' };
    grpcFeature.setActiveGrpcResponse.call(state as never, result as never, 'background');
    grpcFeature.setActiveGrpcResponseTab.call(state as never, 'messages', 'background');
    expect(state.grpcResponse).toBe(visible);
    expect(state.grpcResponseTab).toBe('trailers');
    expect(state.grpcResponses.get('background')).toBe(result);
    expect(state.grpcResponseTabs.get('background')).toBe('messages');
  });

  it('applies stream events to the initiating request and ignores deleted requests', () => {
    const state = host();
    const visible = state.grpcResponse;
    const background = { ...visible, body: 'background' };
    state.grpcResponses.set('background', background);
    expect(grpcFeature.ensureActiveGrpcResponse.call(state as never, 'background')).toBe(background);
    expect(grpcFeature.ensureActiveGrpcResponse.call(state as never, 'deleted')).toBeNull();
    const result = { ...background, body: 'complete' };
    Object.assign(state, {
      setActiveGrpcResponse: grpcFeature.setActiveGrpcResponse,
      setActiveGrpcResponseTab: grpcFeature.setActiveGrpcResponseTab,
      grpcSelectedMethodInfo: () => ({}),
      grpcEmptyMethodInfo: () => ({}),
      grpcBodyFromMessages: () => '',
    });
    grpcFeature.applyGrpcDoneEvent.call(state as never, { requestId: 'background', response: result, timestamp: 1 } as never);
    expect(state.grpcResponse).toBe(visible);
    expect(state.requestError).toBe('visible error');
    expect(state.grpcResponses.get('background')?.body).toBe('complete');
  });
});
