import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ loadRequestExamples: vi.fn() }));
vi.mock('../lib/backend', async importOriginal => ({ ...(await importOriginal<object>()), loadRequestExamples: backend.loadRequestExamples }));

import { examplesFeature, forgetLoadingExamples } from '../lib/stores/features/examples';
import { examplesOnDisk, markExamplesOnDisk } from '../lib/examplesOnDisk';
import { normalizeRequestExample } from '../lib/examples';
import { vm } from '../lib/stores/app.svelte';
import { makeCollection, normalizeSavedRequest } from '../lib/normalizers';
import type { RequestExample, SavedRequest } from '../lib/types/models';

function example(id: string, requestId: string, body = '{}'): RequestExample {
  return normalizeRequestExample({ id, name: id, response: { statusCode: 200, status: '200 OK', headers: [], body, bodyMediaType: 'application/json' } }, requestId);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function stored(id: string): SavedRequest {
  return { id, name: id, collectionId: 'c1', exampleCount: 1, url: `https://example.test/${id}` } as SavedRequest;
}

function host(requests: SavedRequest[], activeRequestId: string) {
  const state = {
    ...examplesFeature,
    requests,
    activeRequestId,
    requestExamplesLoaded: false,
    requestExamplesSource: null,
    savedRequestSnapshots: new Map<string, SavedRequest>(),
    unsavedRequestSnapshots: new Map<string, SavedRequest>(),
    requestExamples: [] as RequestExample[],
    selectedExampleId: '',
    requestTab: 'body',
    collectionImportToast: '',
    snapshotActiveRequest: () => requests.find(req => req.id === state.activeRequestId)!,
    scheduleActiveRequestPersist: vi.fn(),
  };
  return state;
}

afterEach(() => backend.loadRequestExamples.mockReset());

describe('example loading races', () => {
  it('does not add a response to the request opened while examples were loading', async () => {
    const load = deferred<Record<string, unknown[]>>();
    backend.loadRequestExamples.mockReturnValue(load.promise);
    const state = host([stored('a'), stored('b')], 'a');

    const saving = examplesFeature.addCapturedExample.call(state as never, example('captured', 'a'));
    state.activeRequestId = 'b';
    state.requestExamples = [example('b-1', 'b')];
    state.requestExamplesLoaded = true;
    load.resolve({ a: [example('a-1', 'a')] });
    await saving;

    expect(state.requestExamples.map(item => item.id)).toEqual(['b-1']);
    expect(state.scheduleActiveRequestPersist).not.toHaveBeenCalled();
    expect(state.collectionImportToast).toContain('another request was opened');
  });

  it('keeps the response on its own request when it stays open', async () => {
    backend.loadRequestExamples.mockResolvedValue({ a: [example('a-1', 'a')] });
    const state = host([stored('a')], 'a');
    await examplesFeature.addCapturedExample.call(state as never, example('captured', 'x'));
    expect(state.requestExamples.map(item => [item.id, item.requestId])).toEqual([['a-1', 'a'], ['captured', 'a']]);
  });

  it('drops examples that arrive after the workspace was reloaded', async () => {
    const load = deferred<Record<string, unknown[]>>();
    backend.loadRequestExamples.mockReturnValue(load.promise);
    const state = host([stored('a')], 'a');

    const loading = examplesFeature.ensureRequestExamples.call(state as never, ['a']);
    forgetLoadingExamples(state);
    const reloaded = stored('a');
    state.requests = [reloaded];
    load.resolve({ a: [example('old', 'a')] });
    await loading;

    expect(state.requests[0]).toBe(reloaded);
    expect(state.requestExamplesLoaded).toBe(false);
    backend.loadRequestExamples.mockResolvedValue({ a: [example('fresh', 'a')] });
    await examplesFeature.ensureRequestExamples.call(state as never, ['a']);
    expect(state.requests[0].examples?.map(item => item.id)).toEqual(['fresh']);
  });
});

describe('active request snapshots and examples on disk', () => {
  it('reuses the saved example list until an example changes', () => {
    vm.activeWorkspaceId = 'w-snap';
    vm.collections = [{ ...makeCollection('w-snap', 'API'), id: 'c-snap' }];
    const examples = [example('big', 'r-snap', 'x'.repeat(1_000_000))];
    markExamplesOnDisk(examples);
    const request = { ...normalizeSavedRequest({ id: 'r-snap', name: 'Big', collectionId: 'c-snap', method: 'GET', url: 'https://example.test' }, vm.collections, 'w-snap'), examples };
    vm.requests = [request];
    vm.activeRequestId = 'r-snap';
    vm.applySavedRequest(request);

    vm.url = 'https://example.test/edited';
    const first = vm.snapshotActiveRequest();
    expect(first.url).toBe('https://example.test/edited');
    expect(first.examples).toBe(examples);
    expect(examplesOnDisk(first.examples)).toBe(true);

    vm.updateExample('big', { name: 'Renamed' });
    const changed = vm.snapshotActiveRequest();
    expect(changed.examples).not.toBe(examples);
    expect(changed.examples?.[0].name).toBe('Renamed');
    expect(vm.snapshotActiveRequest().examples).toBe(changed.examples);
  });
});
