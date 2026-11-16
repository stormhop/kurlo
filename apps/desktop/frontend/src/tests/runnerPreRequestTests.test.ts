import { describe, it, expect } from 'vitest';

import { collectionRunnerFeature } from '../lib/stores/features/collectionRunner';
import type { HttpResponse } from '../lib/backend';
import type { CollectionRunnerResult, SavedRequest } from '../lib/types/models';

function makeHost() {
  return {
    runnerResultShell: (
      req: SavedRequest,
      status: CollectionRunnerResult['status'] = 'queued',
      runId = '',
      iteration = 1,
    ): CollectionRunnerResult => ({
      runId,
      requestId: req.id,
      name: req.name,
      method: req.method,
      url: req.url,
      status,
      statusCode: 0,
      duration: 0,
      testsPassed: 0,
      testsTotal: 0,
      error: '',
      tests: [],
      iteration,
    }) as any,
    runnerResultFromResponse: collectionRunnerFeature.runnerResultFromResponse,
    runnerResultFromGrpcResponse: collectionRunnerFeature.runnerResultFromGrpcResponse,
  } as any;
}

const req = { id: 'r1', name: 'Charge card', method: 'POST', url: 'https://api/charge' } as any;

function response(over: Partial<HttpResponse> = {}): HttpResponse {
  return {
    statusCode: 200,
    status: '200 OK',
    headers: [],
    body: '{}',
    duration: 5,
    size: 2,
    preRequestResult: { tests: [] },
    testResult: { tests: [] },
    ...over,
  };
}

describe('runnerResultFromResponse — pre-request tests', () => {
  it('reports a failed pre-request test as a failed run', () => {
    const host = makeHost();
    const result = host.runnerResultFromResponse(
      req,
      response({ preRequestResult: { tests: [{ name: 'token present', passed: false, error: 'expected undefined to exist' }] } }),
      'run-1',
      1,
    );
    expect(result.status).toBe('failed');
    expect(result.testsTotal).toBe(1);
    expect(result.testsPassed).toBe(0);
    expect(result.tests[0].name).toBe('token present');
  });

  it('combines pre-request and test-script results', () => {
    const host = makeHost();
    const result = host.runnerResultFromResponse(
      req,
      response({
        preRequestResult: { tests: [{ name: 'pre passes', passed: true, error: '' }] },
        testResult: { tests: [{ name: 'test fails', passed: false, error: 'expected 1 to equal 2' }] },
      }),
      'run-1',
      1,
    );
    expect(result.status).toBe('failed');
    expect(result.testsTotal).toBe(2);
    expect(result.testsPassed).toBe(1);
    expect(result.tests.map(test => test.name)).toEqual(['pre passes', 'test fails']);
  });
});

describe('runnerResultFromGrpcResponse — pre-request tests', () => {
  it('reports a failed pre-request test as a failed run', () => {
    const host = makeHost();
    const result = host.runnerResultFromGrpcResponse(
      req,
      {
        grpcCode: 'OK',
        preRequestResult: { tests: [{ name: 'grpc pre', passed: false, error: 'expected 1 to equal 2' }] },
        testResult: { tests: [] },
      },
      'run-1',
      1,
    );
    expect(result.status).toBe('failed');
    expect(result.testsTotal).toBe(1);
    expect(result.tests[0].name).toBe('grpc pre');
  });
});
