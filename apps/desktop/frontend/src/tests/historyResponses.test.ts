import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/backend', () => ({
  saveHistoryResponse: vi.fn(),
  loadHistoryResponse: vi.fn(),
  pruneHistoryResponses: vi.fn(),
  clearHistoryResponses: vi.fn(),
}));

import { clearHistoryResponses, loadHistoryResponse, pruneHistoryResponses, saveHistoryResponse } from '../lib/backend';
import { historyContentType, historyFeature, historyResponsePayload } from '../lib/stores/features/history';
import { emptyHttpResponse } from '../lib/wire';
import type { HttpResponse } from '../lib/backend';

const mockSave = vi.mocked(saveHistoryResponse);
const mockLoad = vi.mocked(loadHistoryResponse);
const mockPrune = vi.mocked(pruneHistoryResponses);
const mockClear = vi.mocked(clearHistoryResponses);

function makeHost(over: Record<string, unknown> = {}) {
  return {
    requestHistory: [],
    requests: [],
    workspaces: [],
    collections: [],
    openRequestIds: [],
    activeRequestId: 'req-1',
    activeWorkspaceId: 'ws-1',
    openHistoryMenuId: '',
    historyHeaderMenuOpen: false,
    requestError: '',
    collectionImportToast: '',
    guardWorkspaceWritable: () => true,
    normalizeSavedRequestCtx: (input: Record<string, unknown>) => input,
    snapshotActiveRequest: () => ({ name: 'Req', method: 'GET', url: 'https://example.test' }),
    currentRequestName: () => 'Req',
    persistRequestStore: vi.fn(async () => true),
    openConfirmDialog: vi.fn(async () => true),
    setActiveResponse: vi.fn(),
    setActiveResponseTab: vi.fn(),
    pruneHistory: historyFeature.pruneHistory,
    pruneStoredResponses: historyFeature.pruneStoredResponses,
    recordRequestHistory: historyFeature.recordRequestHistory,
    showHistoryResponse: historyFeature.showHistoryResponse,
    saveHistoryEntryAsExample: historyFeature.saveHistoryEntryAsExample,
    addCapturedExample: vi.fn(async () => undefined),
    activeSecretEnvironmentValues: () => [],
    loadStoredHistoryResponse: historyFeature.loadStoredHistoryResponse,
    deleteHistoryEntry: historyFeature.deleteHistoryEntry,
    clearRequestHistory: historyFeature.clearRequestHistory,
    openHistoryDetail: historyFeature.openHistoryDetail,
    closeHistoryDetail: historyFeature.closeHistoryDetail,
    historyDetailId: '',
    historyDetailResponse: null,
    historyDetailLoading: false,
    historyDetailError: '',
    topView: 'request',
    ...over,
  } as any;
}

const response = (over: Record<string, unknown> = {}) => ({
  ...emptyHttpResponse(),
  statusCode: 200,
  status: '200 OK',
  duration: 12,
  size: 34,
  body: '{"ok":true}',
  headers: [{ key: 'Content-Type', value: 'application/json', enabled: true, isFile: false, fileName: '' }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockSave.mockResolvedValue({ stored: true, truncated: false });
  mockLoad.mockResolvedValue({ stored: false, truncated: false });
  mockPrune.mockResolvedValue('');
  mockClear.mockResolvedValue('');
});

describe('recording a response', () => {
  it('stores the response and records what it was', async () => {
    const host = makeHost();
    await host.recordRequestHistory(response());

    expect(mockSave).toHaveBeenCalledTimes(1);
    const [id, payload] = mockSave.mock.calls[0];
    expect(id).toBe(host.requestHistory[0].id);
    expect(JSON.parse(payload).body).toBe('{"ok":true}');

    expect(host.requestHistory[0]).toMatchObject({
      statusCode: 200,
      responseStored: true,
      responseSize: 34,
      responseContentType: 'application/json',
    });
  });

  it('leaves the timeline and wire trace out of what it stores', async () => {
    const host = makeHost();
    await host.recordRequestHistory(response({
      timeline: [{ label: 'dns', atMs: 1 }],
      sentRequests: [{ method: 'GET', url: 'https://example.test', proto: 'HTTP/1.1', headers: [] }],
    }));

    const stored = JSON.parse(mockSave.mock.calls[0][1]);
    expect(stored.timeline).toEqual([]);
    expect(stored.sentRequests).toEqual([]);
  });

  it('does not store the body of a binary response', async () => {
    const host = makeHost();
    await host.recordRequestHistory(response({ bodyIsBinary: true, body: '���' }));

    expect(JSON.parse(mockSave.mock.calls[0][1]).body).toBe('');
    expect(host.requestHistory[0].responseStored).toBe(true);
  });

  it('still records the entry when the response cannot be stored', async () => {
    mockSave.mockRejectedValue(new Error('disk full'));
    const host = makeHost();
    await host.recordRequestHistory(response());

    expect(host.requestHistory).toHaveLength(1);
    expect(host.requestHistory[0].responseStored).toBe(false);
  });
});

describe('reopening a stored response', () => {
  it('leaves a request opened while the stored response was loading alone', async () => {
    let finish!: (value: unknown) => void;
    mockLoad.mockReturnValue(new Promise(done => { finish = done; }) as never);
    const host = makeHost({ requestHistory: [{ id: 'history-1', responseStored: true, request: { name: 'Req', method: 'GET', url: 'https://example.test' } }] });

    const showing = host.showHistoryResponse('history-1');
    const saving = host.saveHistoryEntryAsExample('history-1');
    host.activeRequestId = 'req-2';
    finish({ stored: true, truncated: false, payload: JSON.stringify(response()) });
    await Promise.all([showing, saving]);

    expect(host.setActiveResponse).not.toHaveBeenCalled();
    expect(host.addCapturedExample).not.toHaveBeenCalled();
    expect(host.collectionImportToast).toContain('another request was opened');
  });

  it('puts the stored response in the viewer', async () => {
    mockLoad.mockResolvedValue({ stored: true, truncated: false, payload: JSON.stringify(response({ body: 'stored body' })) });
    const host = makeHost({ requestHistory: [{ id: 'history-1', responseStored: true }] });

    await host.showHistoryResponse('history-1');

    expect(host.setActiveResponse).toHaveBeenCalledTimes(1);
    expect(host.setActiveResponse.mock.calls[0][0].body).toBe('stored body');
    expect(host.setActiveResponseTab).toHaveBeenCalledWith('body');
  });

  it('says so when a truncated response is reopened', async () => {
    mockLoad.mockResolvedValue({ stored: true, truncated: false, payload: JSON.stringify(response()) });
    const host = makeHost({ requestHistory: [{ id: 'history-1', responseStored: true, responseTruncated: true }] });

    await host.showHistoryResponse('history-1');

    expect(host.setActiveResponse.mock.calls[0][0].warnings.join(' ')).toContain('truncated');
  });

  it('reports an entry with nothing stored instead of failing', async () => {
    const host = makeHost({ requestHistory: [{ id: 'history-1' }] });

    await host.showHistoryResponse('history-1');

    expect(host.setActiveResponse).not.toHaveBeenCalled();
    expect(host.collectionImportToast).toContain('No response stored');
    expect(host.requestError).toBe('');
  });

  it('surfaces a read failure rather than showing nothing', async () => {
    mockLoad.mockResolvedValue({ stored: false, truncated: false, error: 'key mismatch' });
    const host = makeHost({ requestHistory: [{ id: 'history-1', responseStored: true }] });

    await host.showHistoryResponse('history-1');

    expect(host.requestError).toContain('key mismatch');
  });
});

describe('cleaning up stored responses', () => {
  it('keeps only the entries history still holds', async () => {
    const host = makeHost({ requestHistory: [{ id: 'keep-1' }, { id: 'keep-2' }] });
    await host.pruneStoredResponses();
    expect(mockPrune).toHaveBeenCalledWith(['keep-1', 'keep-2']);
  });

  it('prunes after an entry is deleted', async () => {
    const host = makeHost({ requestHistory: [{ id: 'history-1' }, { id: 'history-2' }] });
    await host.deleteHistoryEntry('history-1');
    expect(host.requestHistory.map((entry: { id: string }) => entry.id)).toEqual(['history-2']);
    expect(mockPrune).toHaveBeenCalledWith(['history-2']);
  });

  it('clears stored responses when history is cleared', async () => {
    const host = makeHost({ requestHistory: [{ id: 'history-1' }] });
    await host.clearRequestHistory();
    expect(host.requestHistory).toEqual([]);
    expect(mockClear).toHaveBeenCalledTimes(1);
  });
});

describe('opening an entry', () => {
  it('restores the response alongside the request', async () => {
    mockLoad.mockResolvedValue({ stored: true, truncated: false, payload: JSON.stringify(response({ body: 'from history' })) });
    const host = makeHost({
      requestHistory: [{ id: 'history-1', responseStored: true }],
      activeCollectionId: () => 'col-1',
      saveHistoryEntryToCollection: vi.fn(async () => undefined),
      openHistoryEntry: historyFeature.openHistoryEntry,
      showHistoryResponse: historyFeature.showHistoryResponse,
    });

    await host.openHistoryEntry('history-1');

    expect(host.saveHistoryEntryToCollection).toHaveBeenCalledWith('history-1', 'col-1');
    expect(host.setActiveResponse.mock.calls[0][0].body).toBe('from history');
  });

  it('opens an entry with no stored response without complaining', async () => {
    const host = makeHost({
      requestHistory: [{ id: 'history-1' }],
      activeCollectionId: () => 'col-1',
      saveHistoryEntryToCollection: vi.fn(async () => undefined),
      openHistoryEntry: historyFeature.openHistoryEntry,
      showHistoryResponse: historyFeature.showHistoryResponse,
    });

    await host.openHistoryEntry('history-1');

    expect(host.setActiveResponse).not.toHaveBeenCalled();
    expect(host.requestError).toBe('');
  });
});

describe('recording a failed send', () => {
  it('does not crash when the response carries no headers', () => {
    const failed = { ...emptyHttpResponse(), error: 'dial tcp: connection refused' } as HttpResponse;
    delete (failed as Partial<HttpResponse>).headers;
    expect(() => historyContentType(failed)).not.toThrow();
    expect(historyContentType(failed)).toBe('');

    const nulled = { ...emptyHttpResponse(), headers: null } as unknown as HttpResponse;
    expect(historyContentType(nulled)).toBe('');
  });

  it('still reads the content type when there is one', () => {
    const ok = {
      ...emptyHttpResponse(),
      headers: [{ key: 'Content-Type', value: 'application/json', enabled: true, isFile: false, fileName: '', contentType: '' }],
    } as HttpResponse;
    expect(historyContentType(ok)).toBe('application/json');
  });
});

describe('storing a response that is too large for history', () => {
  it('keeps a small response whole', () => {
    const { payload, truncated } = historyResponsePayload(response() as HttpResponse);
    expect(truncated).toBe(false);
    expect(JSON.parse(payload).body).toBe('{"ok":true}');
  });

  it('cuts the body so the stored snapshot stays valid JSON under the cap', () => {
    const body = '{"line":"\\n\\"quoted\\""}\n'.repeat(4_000);
    const { payload, truncated } = historyResponsePayload(response({ body }) as HttpResponse, 32_000);
    expect(truncated).toBe(true);
    expect(new TextEncoder().encode(payload).length).toBeLessThanOrEqual(32_000);
    const parsed = JSON.parse(payload) as HttpResponse;
    expect(parsed.statusCode).toBe(200);
    expect(body.startsWith(parsed.body)).toBe(true);
    expect(parsed.body.length).toBeGreaterThan(10_000);
  });

  it('records the cut on the history entry', async () => {
    mockSave.mockResolvedValueOnce({ stored: true, truncated: false } as never);
    const host = makeHost();
    await historyFeature.recordRequestHistory.call(host, response({ body: 'x'.repeat(3 * 1024 * 1024) }) as HttpResponse);
    const [, payload] = mockSave.mock.calls.at(-1)!;
    expect(() => JSON.parse(payload)).not.toThrow();
    expect(host.requestHistory[0].responseTruncated).toBe(true);
  });
});

describe('the history entry view', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    id: 'history-1',
    request: { name: 'Users', method: 'GET', url: 'https://api.test/users' },
    statusCode: 200,
    status: '200 OK',
    duration: 12,
    createdAt: Date.now(),
    responseStored: true,
    ...over,
  });

  it('opens an entry and loads its stored response', async () => {
    mockLoad.mockResolvedValueOnce({ stored: true, truncated: false, payload: JSON.stringify(response()) } as never);
    const host = makeHost({ requestHistory: [entry()] });
    await historyFeature.openHistoryDetail.call(host, 'history-1');
    expect(host.topView).toBe('history');
    expect(host.historyDetailId).toBe('history-1');
    expect(host.historyDetailLoading).toBe(false);
    expect(host.historyDetailResponse?.body).toBe('{"ok":true}');
    expect(host.historyDetailError).toBe('');
  });

  it('does not ask the backend when nothing was stored', async () => {
    mockLoad.mockClear();
    const host = makeHost({ requestHistory: [entry({ responseStored: false })] });
    await historyFeature.openHistoryDetail.call(host, 'history-1');
    expect(mockLoad).not.toHaveBeenCalled();
    expect(host.historyDetailResponse).toBeNull();
    expect(host.historyDetailLoading).toBe(false);
  });

  it('keeps a read error on the view instead of the request panel', async () => {
    mockLoad.mockResolvedValueOnce({ stored: false, error: 'decrypt failed' } as never);
    const host = makeHost({ requestHistory: [entry()] });
    await historyFeature.openHistoryDetail.call(host, 'history-1');
    expect(host.historyDetailError).toContain('decrypt failed');
    expect(host.requestError).toBe('');
  });

  it('ignores a slow load for an entry that is no longer shown', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    mockLoad.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }) as never);
    mockLoad.mockResolvedValueOnce({ stored: true, payload: JSON.stringify(response({ body: 'second' })) } as never);
    const host = makeHost({ requestHistory: [entry(), entry({ id: 'history-2' })] });
    const first = historyFeature.openHistoryDetail.call(host, 'history-1');
    await historyFeature.openHistoryDetail.call(host, 'history-2');
    resolveFirst({ stored: true, payload: JSON.stringify(response({ body: 'first' })) });
    await first;
    expect(host.historyDetailId).toBe('history-2');
    expect(host.historyDetailResponse?.body).toBe('second');
  });

  it('leaves the view when its entry is deleted', async () => {
    mockLoad.mockResolvedValueOnce({ stored: true, payload: JSON.stringify(response()) } as never);
    const host = makeHost({ requestHistory: [entry()], activeRequestId: '' });
    await historyFeature.openHistoryDetail.call(host, 'history-1');
    await historyFeature.deleteHistoryEntry.call(host, 'history-1');
    expect(host.historyDetailId).toBe('');
    expect(host.topView).toBe('overview');
  });
});

