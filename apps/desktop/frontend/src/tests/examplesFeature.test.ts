import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_REQUEST_SETTINGS } from '../lib/constants';
import { examplesFeature } from '../lib/stores/features/examples';
import { normalizeRequestExample } from '../lib/examples';
import { emptyHttpResponse } from '../lib/wire';
import type { HttpResponse } from '../lib/backend';
import type { RequestExample, SavedRequest } from '../lib/types/models';
import { emptyAuthState } from '../lib/utils';
import { mkRow } from '../lib/constants';

function savedRequest(overrides: Partial<SavedRequest> = {}): SavedRequest {
  return {
    id: 'req-1',
    name: 'Create order',
    filesystemName: 'Create-order',
    requestType: 'http',
    isDraft: false,
    collectionId: 'collection-1',
    collection: 'Collection',
    folderPath: [],
    method: 'POST',
    url: 'https://api.example.test/orders',
    requestTab: 'params',
    params: [],
    headers: [],
    auth: emptyAuthState(),
    bodyType: 'json',
    rawBodyType: 'json',
    bodyContent: '',
    bodyFilePath: '',
    bodyFileName: '',
    formRows: [],
    preRequestScript: '',
    testScript: '',
    requestNotes: '',
    settings: { ...DEFAULT_REQUEST_SETTINGS },
    ...overrides,
  };
}

function response(overrides: Partial<HttpResponse> = {}): HttpResponse {
  return {
    ...emptyHttpResponse(),
    statusCode: 201,
    status: '201 Created',
    body: '{"id":"ord_1"}',
    headers: [{ key: 'Content-Type', value: 'application/json', enabled: true, isFile: false, fileName: '', contentType: '' }],
    ...overrides,
  };
}

function example(overrides: Partial<RequestExample> = {}): RequestExample {
  return normalizeRequestExample(
    {
      id: 'ex-1',
      name: 'Created',
      response: { statusCode: 201, status: '201 Created', headers: [], body: '{}', bodyMediaType: 'application/json' },
      ...overrides,
    },
    'req-1',
  );
}

function hostFor(options: {
  examples?: RequestExample[];
  response?: HttpResponse | null;
  writable?: boolean;
  confirm?: boolean;
  prompt?: string | null;
  secretValues?: string[];
} = {}) {
  const host = {
    ...examplesFeature,
    requests: [],
    activeRequestId: 'req-1',
    requestExamplesLoaded: true,
    savedRequestSnapshots: new Map(),
    unsavedRequestSnapshots: new Map(),
    requestExamples: options.examples ?? [],
    selectedExampleId: '',
    requestTab: 'body',
    response: options.response ?? null,
    requestError: '',
    collectionImportToast: '',
    snapshotActiveRequest: () => savedRequest(),
    activeSecretEnvironmentValues: () => options.secretValues ?? [],
    scheduleActiveRequestPersist: vi.fn(),
    guardWorkspaceWritable: vi.fn(() => options.writable ?? true),
    openConfirmDialog: vi.fn(async () => options.confirm ?? true),
    openNameDialog: vi.fn(async () => (options.prompt === undefined ? null : options.prompt)),
  };
  return host as unknown as ExamplesTestHost;
}

type ExamplesTestHost = Parameters<typeof examplesFeature.moveExample>[0] & {
  requestExamples: RequestExample[];
  selectedExampleId: string;
  requestTab: string;
  collectionImportToast: string;
};

describe('saveResponseAsExample', () => {
  it('appends the captured response, selects it and opens the tab', async () => {
    const host = hostFor({ response: response() });
    await examplesFeature.saveResponseAsExample.call(host);

    const state = host;
    expect(state.requestExamples).toHaveLength(1);
    expect(state.requestExamples[0].response.statusCode).toBe(201);
    expect(state.requestExamples[0].match.pathTemplate).toBe('/orders');
    expect(state.selectedExampleId).toBe(state.requestExamples[0].id);
    expect(state.requestTab).toBe('examples');
    expect(state.collectionImportToast).toContain('as an example');
  });

  it('does nothing when there is no response', async () => {
    const host = hostFor({ response: null });
    await examplesFeature.saveResponseAsExample.call(host);
    expect(host.requestExamples).toHaveLength(0);
  });

  it('refuses when the workspace is not writable', async () => {
    const host = hostFor({ response: response(), writable: false });
    await examplesFeature.saveResponseAsExample.call(host);
    expect(host.requestExamples).toHaveLength(0);
  });

  it('disambiguates a name that is already taken', async () => {
    const host = hostFor({ response: response(), examples: [example({ id: 'ex-0', name: '201 Created' })] });
    await examplesFeature.saveResponseAsExample.call(host);
    const state = host;
    expect(state.requestExamples.map(item => item.name)).toEqual(['201 Created', '201 Created (2)']);
  });

  it('warns when the captured response still holds something credential-shaped', async () => {
    const host = hostFor({ response: response({ body: 'set token=abcdef123456', headers: [] }) });
    await examplesFeature.saveResponseAsExample.call(host);
    const state = host;
    expect(state.requestExamples[0].response.body).toContain('abcdef123456');
    expect(state.collectionImportToast).toContain('Saved');
  });

  it('takes its confirmation back down again', async () => {
    vi.useFakeTimers();
    try {
      const host = hostFor({ response: response() });
      await examplesFeature.saveResponseAsExample.call(host);
      expect(host.collectionImportToast).toContain('as an example');

      vi.advanceTimersByTime(2199);
      expect(host.collectionImportToast).not.toBe('');

      vi.advanceTimersByTime(2);
      expect(host.collectionImportToast).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let an earlier timer cut short a later toast', async () => {
    vi.useFakeTimers();
    try {
      const host = hostFor({ response: response() });
      await examplesFeature.saveResponseAsExample.call(host);
      vi.advanceTimersByTime(2000);

      await examplesFeature.saveResponseAsExample.call(host);
      const second = host.collectionImportToast;
      expect(second).toContain('(2)');

      vi.advanceTimersByTime(300);
      expect(host.collectionImportToast).toBe(second);

      vi.advanceTimersByTime(2000);
      expect(host.collectionImportToast).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('masks a known secret value before the example is stored', async () => {
    const host = hostFor({
      response: response({ body: '{"next":"https://cb?t=sk-live-123"}' }),
      secretValues: ['sk-live-123'],
    });
    await examplesFeature.saveResponseAsExample.call(host);
    const state = host;
    expect(state.requestExamples[0].response.body).not.toContain('sk-live-123');
  });
});

describe('addCapturedExample', () => {
  it('re-points the example at the request being edited', () => {
    const host = hostFor();
    examplesFeature.addCapturedExample.call(host, example({ id: 'ex-x', requestId: 'req-from-history' }));

    expect(host.requestExamples[0].requestId).toBe('req-1');
    expect(host.selectedExampleId).toBe('ex-x');
    expect(host.requestTab).toBe('examples');
  });

  it('does not share structure with the example it was handed', () => {
    const host = hostFor();
    const source = example({ id: 'ex-y' });
    examplesFeature.addCapturedExample.call(host, source);

    host.requestExamples[0].response.headers.push({ ...mkRow(), key: 'X', value: 'y' });
    expect(source.response.headers).toHaveLength(0);
  });
});

describe('example list management', () => {
  it('deletes after confirmation and moves the selection on', async () => {
    const host = hostFor({ examples: [example({ id: 'ex-1' }), example({ id: 'ex-2', name: 'Rejected' })], confirm: true });
    host.selectedExampleId = 'ex-1';

    await examplesFeature.deleteExample.call(host, 'ex-1');
    const state = host;
    expect(state.requestExamples.map(item => item.id)).toEqual(['ex-2']);
    expect(state.selectedExampleId).toBe('ex-2');
  });

  it('keeps the example when the confirmation is declined', async () => {
    const host = hostFor({ examples: [example({ id: 'ex-1' })], confirm: false });
    await examplesFeature.deleteExample.call(host, 'ex-1');
    expect(host.requestExamples).toHaveLength(1);
  });

  it('reorders, and refuses to move past either end', () => {
    const host = hostFor({ examples: [example({ id: 'ex-1' }), example({ id: 'ex-2' }), example({ id: 'ex-3' })] });
    const state = host;

    examplesFeature.moveExample.call(host, 'ex-3', -1);
    expect(state.requestExamples.map(item => item.id)).toEqual(['ex-1', 'ex-3', 'ex-2']);

    examplesFeature.moveExample.call(host, 'ex-1', -1);
    expect(state.requestExamples.map(item => item.id)).toEqual(['ex-1', 'ex-3', 'ex-2']);

    examplesFeature.moveExample.call(host, 'ex-2', 1);
    expect(state.requestExamples.map(item => item.id)).toEqual(['ex-1', 'ex-3', 'ex-2']);
  });

  it('renames, keeping the new name unique', async () => {
    const host = hostFor({
      examples: [example({ id: 'ex-1', name: 'Created' }), example({ id: 'ex-2', name: 'Rejected' })],
      prompt: 'Rejected',
    });
    await examplesFeature.renameExample.call(host, 'ex-1');
    const state = host;
    expect(state.requestExamples[0].name).toBe('Rejected (2)');
  });

  it('leaves the name alone when the prompt is cancelled', async () => {
    const host = hostFor({ examples: [example({ id: 'ex-1', name: 'Created' })], prompt: null });
    await examplesFeature.renameExample.call(host, 'ex-1');
    expect(host.requestExamples[0].name).toBe('Created');
  });

  it('selects the first example when the stored selection is gone', () => {
    const host = hostFor({ examples: [example({ id: 'ex-1' }), example({ id: 'ex-2' })] });
    host.selectedExampleId = 'ex-missing';
    expect(examplesFeature.selectedExample.call(host)?.id).toBe('ex-1');
  });
});

describe('updateExampleResponse', () => {
  it('keeps the media type in step with an edited Content-Type header', () => {
    const host = hostFor({
      examples: [
        example({
          id: 'ex-1',
          response: {
            statusCode: 200,
            status: 'OK',
            body: '<xml/>',
            bodyMediaType: 'application/json',
            headers: [{ id: 1, enabled: true, key: 'Content-Type', value: 'application/xml; charset=utf-8', description: '' }],
          } as never,
        }),
      ],
    });
    examplesFeature.updateExampleResponse.call(host, 'ex-1', { body: '<xml></xml>' });
    const state = host;
    expect(state.requestExamples[0].response.bodyMediaType).toBe('application/xml');
    expect(state.requestExamples[0].response.body).toBe('<xml></xml>');
  });

  it('does not touch the other examples', () => {
    const host = hostFor({ examples: [example({ id: 'ex-1' }), example({ id: 'ex-2', name: 'Other' })] });
    examplesFeature.updateExampleResponse.call(host, 'ex-1', { statusCode: 500 });
    const state = host;
    expect(state.requestExamples[0].response.statusCode).toBe(500);
    expect(state.requestExamples[1].response.statusCode).toBe(201);
  });
});
