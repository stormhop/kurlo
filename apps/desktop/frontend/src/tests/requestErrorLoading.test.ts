import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/backend', () => ({
  cancelHttpRequest: vi.fn(),
  sendHttpRequest: vi.fn(),
  sendHttpRequestToFile: vi.fn(),
  setEnvironment: vi.fn().mockResolvedValue(undefined),
  setGlobalVariables: vi.fn().mockResolvedValue(undefined),
}));

import { sendHttpRequest } from '../lib/backend';
import { requestExecutionFeature } from '../lib/stores/features/requestExecution';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('transport error while sending', () => {
  it('stops loading before the history entry is written', async () => {
    vi.mocked(sendHttpRequest).mockResolvedValueOnce({
      error: 'tls: failed to verify certificate',
      statusCode: 0,
    } as never);
    const history = deferred();
    const inFlight = new Set<string>();
    let loadingWhileRecording: boolean | undefined;
    const snapshot = { method: 'GET' };
    const host = {
      activeRequestId: 'request-a',
      url: 'https://example.test',
      authType: 'none',
      bearerToken: '',
      requestType: 'http',
      requestError: '',
      disableCookieJar: true,
      get loading() {
        return inFlight.has(this.activeRequestId);
      },
      guardWorkspaceWritable: () => true,
      markRequestLoading(id: string, value: boolean) {
        if (value) inFlight.add(id);
        else inFlight.delete(id);
      },
      snapshotActiveRequest: () => snapshot,
      activeEnvironmentValues: () => ({}),
      activeSecretEnvironmentValues: () => [],
      activeSecretEnvironmentKeys: () => [],
      globalVariableValues: () => ({}),
      headerValidationErrorForRequest: () => '',
      savedRequestToRunnableHttpRequest: () => ({ auth: {} }),
      clearTransientSSESession: vi.fn(),
      persistActiveRequestNow: vi.fn().mockResolvedValue(undefined),
      ensureValidOAuth2TokenForRequest: (request: unknown) => Promise.resolve(request),
      applyEnvironmentChangesFromResponse: vi.fn().mockResolvedValue(undefined),
      applyCollectionVariableUpdates: vi.fn().mockResolvedValue(undefined),
      syncGlobalsFromBackend: vi.fn().mockResolvedValue(undefined),
      isEventStreamResponse: () => false,
      requestForEditing: () => true,
      requestIsActive: () => true,
      setActiveResponse: vi.fn(),
      recordRequestHistory() {
        loadingWhileRecording = this.loading;
        return history.promise;
      },
    };

    const sending = requestExecutionFeature.send.call(host as never);
    await vi.waitFor(() => expect(loadingWhileRecording).toBeDefined());

    expect(host.requestError).toBe('tls: failed to verify certificate');
    expect(loadingWhileRecording).toBe(false);
    expect(host.loading).toBe(false);

    history.resolve();
    await sending;
    expect(host.loading).toBe(false);
  });
});
