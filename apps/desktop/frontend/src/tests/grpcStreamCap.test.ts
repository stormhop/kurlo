import { describe, expect, it } from 'vitest';
import { GRPC_KEPT_MESSAGES, grpcFeature } from '../lib/stores/features/grpc';

describe('a long gRPC stream', () => {
  it('keeps only the latest messages in the response', () => {
    let response: any = { grpcCode: '', status: '', messages: [], body: '', size: 0, duration: 0, timestamp: 0 };
    const host: any = {
      grpcResponseTab: 'messages',
      ensureActiveGrpcResponse: () => response,
      setActiveGrpcResponse: (next: any) => { response = next; },
      setActiveGrpcResponseTab: () => {},
      grpcBodyFromMessages: grpcFeature.grpcBodyFromMessages,
    };
    const total = GRPC_KEPT_MESSAGES * 3 + 5;
    for (let index = 1; index <= total; index += 1) {
      grpcFeature.applyGrpcMessageEvent.call(host, { requestId: 'req', message: { index, direction: 'incoming', body: `{"n":${index}}`, size: 8, timestamp: index }, size: index * 8 });
    }
    grpcFeature.applyGrpcMessageEvent.call(host, { requestId: 'req', message: { index: total, direction: 'incoming', body: 'dup', size: 3, timestamp: 0 } });

    expect(response.messages).toHaveLength(GRPC_KEPT_MESSAGES);
    expect(response.messages[0].index).toBe(total - GRPC_KEPT_MESSAGES + 1);
    expect(response.messages.at(-1).index).toBe(total);
    expect(response.size).toBe(total * 8);
  });
});
