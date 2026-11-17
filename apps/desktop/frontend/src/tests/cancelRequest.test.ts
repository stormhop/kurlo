import { describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ cancelHttpRequest: vi.fn() }));
vi.mock('../lib/backend', async importOriginal => ({ ...(await importOriginal<object>()), cancelHttpRequest: backend.cancelHttpRequest }));

import { requestExecutionFeature } from '../lib/stores/features/requestExecution';

describe('cancelling a request', () => {
  it('stops loading even when the backend cancel call fails', async () => {
    backend.cancelHttpRequest.mockRejectedValue(new Error('bridge closed'));
    const loading = new Set(['req-1']);
    const host = {
      activeRequestId: 'req-1',
      inFlightRequestIds: loading,
      requestType: 'http',
      grpcResponse: null,
      requestError: '',
      markRequestLoading: vi.fn((id: string, on: boolean) => { if (!on) loading.delete(id); }),
      requestIsActive: () => true,
      setActiveResponse: vi.fn(),
      setActiveGrpcResponse: vi.fn(),
    };

    await requestExecutionFeature.cancelActiveRequest.call(host as never);

    expect(loading.has('req-1')).toBe(false);
    expect(host.requestError).not.toBe('');
  });
});
