import { beforeEach, describe, expect, it, vi } from 'vitest';
import { grpcFeature } from '../lib/stores/features/grpc';

const bridge = { GrpcStreamSend: vi.fn(), GrpcStreamEnd: vi.fn() };

function host(body: string) {
  const state: any = {
    activeRequestId: 'req',
    bodyContent: body,
    grpcStreams: new Map(),
    grpcResponses: new Map(),
    grpcResponse: null,
    resolveTemplate: (value: string) => value.replace('{{sku}}', 'sku-9'),
    environmentValuesForRequest: () => ({}),
    snapshotActiveRequest: () => ({}),
    requestForEditing: () => ({}),
    requestIsActive: () => true,
    grpcResponseTab: 'messages',
    grpcResponseTabs: new Map(),
    grpcMethod: 'shop.Inventory/WatchStock',
    grpcServiceDefinition: { source: '', services: [], methods: [] },
  };
  for (const [name, value] of Object.entries(grpcFeature)) {
    if (typeof value === 'function') state[name] = value;
  }
  state.applyGrpcStreamEvent({ requestId: 'req', method: { fullName: 'shop.Inventory/WatchStock' }, timestamp: 1 });
  return state;
}

describe('an interactive gRPC stream', () => {
  beforeEach(() => {
    bridge.GrpcStreamSend.mockReset();
    bridge.GrpcStreamEnd.mockReset();
    vi.stubGlobal('window', { go: { api: { App: bridge } } });
  });

  it('sends the resolved editor message and counts it', async () => {
    bridge.GrpcStreamSend.mockResolvedValue({ ok: true, sent: 1 });
    const state = host('{"sku":"{{sku}}"}');
    await state.grpcStreamSendCurrentMessage();
    expect(bridge.GrpcStreamSend).toHaveBeenCalledWith('req', '{"sku":"sku-9"}');
    expect(state.grpcStreamState()).toEqual({ status: 'open', sent: 1 });
  });

  it('keeps invalid JSON in the editor instead of sending it', async () => {
    const state = host('{"sku":');
    await state.grpcStreamSendCurrentMessage();
    expect(bridge.GrpcStreamSend).not.toHaveBeenCalled();
  });

  it('adds a send failure to the message log once', async () => {
    bridge.GrpcStreamSend.mockResolvedValueOnce({ ok: false, sent: 0, error: 'the gRPC stream is closed' });
    bridge.GrpcStreamSend.mockResolvedValueOnce({ ok: false, sent: 0, error: 'already logged', recorded: true });
    const state = host('{}');
    await state.grpcStreamSendCurrentMessage();
    await state.grpcStreamSendCurrentMessage();
    const messages = state.grpcResponses.get('req').messages;
    expect(messages.map((message: any) => [message.direction, message.body])).toEqual([['error', 'the gRPC stream is closed']]);
    expect(state.grpcBodyFromMessages(messages)).toBe('');
  });

  it('half-closes once and clears the stream when the call finishes', async () => {
    bridge.GrpcStreamEnd.mockResolvedValue({ ok: true, sent: 0 });
    const state = host('{}');
    await state.grpcStreamEnd();
    await state.grpcStreamEnd();
    expect(bridge.GrpcStreamEnd).toHaveBeenCalledTimes(1);
    expect(state.grpcStreamState()?.status).toBe('ended');
    state.setActiveGrpcResponse = () => {};
    state.applyGrpcDoneEvent({ requestId: 'req', response: { messages: [], testResult: { tests: [] } }, timestamp: 2 });
    expect(state.grpcStreamState()).toBeUndefined();
  });
});
