import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/backend', () => ({
  sendHttpRequest: vi.fn(),
  readOpenApiSourceFile: vi.fn(),
  readOpenApiBaseSpec: vi.fn(),
  writeOpenApiBaseSpec: vi.fn(async () => ''),
  deleteOpenApiBaseSpec: vi.fn(async () => ''),
}));

import { readOpenApiSourceFile, sendHttpRequest } from '../lib/backend';
import { openApiSyncFeature } from '../lib/stores/features/openapiSync';
import { makeCollection } from '../lib/normalizers';
import type { Collection } from '../lib/types/models';

const spec = JSON.stringify({ openapi: '3.0.0', info: { title: 'Pets' }, paths: { '/pets': { get: { summary: 'List' } } } });

function syncedCollection(source = 'https://{{specHost}}/openapi.json'): Collection {
  const collection = makeCollection('ws1', 'Pets');
  collection.defaults = { ...collection.defaults, variables: [{ id: 1, key: 'specHost', value: 'api.example.test', description: '', enabled: true }] };
  collection.openapi = { source, intervalMinutes: 15, headers: [{ id: 2, key: 'Authorization', value: 'Bearer {{specToken}}', description: '', enabled: true }] };
  return collection;
}

function host(collections: Collection[]) {
  const values: Record<string, string> = { specToken: 'secret-token' };
  return {
    collections,
    activeWorkspaceId: 'ws1',
    openApiSync: {} as Record<string, { checkedAt: number }>,
    activeEnvironmentValues: () => values,
    resolveTemplate: (value: string, vars: Record<string, string> = values) => value.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => vars[key] ?? ''),
    checkOpenApiSync: vi.fn(async () => {}),
  };
}

function sentHeaders() {
  const calls = vi.mocked(sendHttpRequest).mock.calls;
  return Object.fromEntries(calls.at(-1)![0].headers.map(header => [header.key, header.value]));
}

const memory = new Map<string, string>();
(globalThis as { localStorage?: Pick<Storage, 'getItem' | 'setItem' | 'clear'> }).localStorage = {
  getItem: key => memory.get(key) ?? null,
  setItem: (key, value) => { memory.set(key, String(value)); },
  clear: () => memory.clear(),
};
const page = { visibilityState: 'visible' as DocumentVisibilityState };
(globalThis as { document?: unknown }).document = page;

beforeEach(() => {
  localStorage.clear();
  page.visibilityState = 'visible';
  vi.mocked(sendHttpRequest).mockReset();
  vi.mocked(readOpenApiSourceFile).mockReset();
});

describe('fetchOpenApiSpec', () => {
  it('resolves variables in the URL and headers and reports the ETag', async () => {
    vi.mocked(sendHttpRequest).mockResolvedValueOnce({ statusCode: 200, body: spec, headers: [{ key: 'ETag', value: '"v1"' }, { key: 'Content-Type', value: 'application/json' }] } as never);
    const collection = syncedCollection();
    const result = await openApiSyncFeature.fetchOpenApiSpec.call(host([collection]) as never, collection, true);
    expect(vi.mocked(sendHttpRequest).mock.calls[0][0].url).toBe('https://api.example.test/openapi.json');
    expect(sentHeaders().Authorization).toBe('Bearer secret-token');
    expect(sentHeaders()['If-None-Match']).toBeUndefined();
    expect(result).toMatchObject({ kind: 'spec', etag: '"v1"' });
  });

  it('asks only for a changed spec and does nothing on 304', async () => {
    const collection = syncedCollection();
    localStorage.setItem('kurlo.openapiSync.v1', JSON.stringify({ [collection.id]: { etag: '"v1"', lastModified: 'Wed, 11 Nov 2026 10:00:00 GMT' } }));
    vi.mocked(sendHttpRequest).mockResolvedValueOnce({ statusCode: 304, body: '', headers: [] } as never);
    const result = await openApiSyncFeature.fetchOpenApiSpec.call(host([collection]) as never, collection, true);
    expect(sentHeaders()['If-None-Match']).toBe('"v1"');
    expect(sentHeaders()['If-Modified-Since']).toBe('Wed, 11 Nov 2026 10:00:00 GMT');
    expect(result).toEqual({ kind: 'unchanged' });
  });

  it('skips the conditional headers for a manual check', async () => {
    const collection = syncedCollection();
    localStorage.setItem('kurlo.openapiSync.v1', JSON.stringify({ [collection.id]: { etag: '"v1"' } }));
    vi.mocked(sendHttpRequest).mockResolvedValueOnce({ statusCode: 200, body: spec, headers: [] } as never);
    await openApiSyncFeature.fetchOpenApiSpec.call(host([collection]) as never, collection, false);
    expect(sentHeaders()['If-None-Match']).toBeUndefined();
  });

  it('reads a local file source and treats an identical file as unchanged', async () => {
    const collection = syncedCollection('../api/openapi.yaml');
    vi.mocked(readOpenApiSourceFile).mockResolvedValue({ content: spec, exists: true, path: '/repo/api/openapi.yaml' });
    const first = await openApiSyncFeature.fetchOpenApiSpec.call(host([collection]) as never, collection, true);
    expect(readOpenApiSourceFile).toHaveBeenCalledWith('../api/openapi.yaml');
    expect(sendHttpRequest).not.toHaveBeenCalled();
    expect(first.kind).toBe('spec');
    localStorage.setItem('kurlo.openapiSync.v1', JSON.stringify({ [collection.id]: { etag: first.kind === 'spec' ? first.etag : '' } }));
    expect(await openApiSyncFeature.fetchOpenApiSpec.call(host([collection]) as never, collection, true)).toEqual({ kind: 'unchanged' });
  });

  it('turns an error status into a readable message', async () => {
    vi.mocked(sendHttpRequest).mockResolvedValueOnce({ statusCode: 401, status: '401 Unauthorized', body: '', headers: [] } as never);
    const collection = syncedCollection();
    await expect(openApiSyncFeature.fetchOpenApiSpec.call(host([collection]) as never, collection, false)).rejects.toThrow('The spec URL answered 401 Unauthorized.');
  });
});

describe('openApiSchedulerTick', () => {
  it('checks only collections in the open workspace whose interval has passed', () => {
    const due = syncedCollection();
    const fresh = syncedCollection();
    const off = { ...syncedCollection(), openapi: { source: 'https://x.test/spec.json', intervalMinutes: 0 } };
    const otherWorkspace = { ...syncedCollection(), workspaceId: 'ws2' };
    const plain = makeCollection('ws1', 'Plain');
    localStorage.setItem('kurlo.openapiSync.v1', JSON.stringify({
      [due.id]: { lastCheckedAt: Date.now() - 16 * 60_000 },
      [fresh.id]: { lastCheckedAt: Date.now() - 60_000 },
    }));
    const vm = host([due, fresh, off, otherWorkspace, plain]);
    openApiSyncFeature.openApiSchedulerTick.call(vm as never);
    expect(vm.checkOpenApiSync.mock.calls.map(call => (call as unknown[])[0])).toEqual([due.id]);
  });

  it('waits while the window is hidden', () => {
    const due = syncedCollection();
    const vm = host([due]);
    page.visibilityState = 'hidden';
    openApiSyncFeature.openApiSchedulerTick.call(vm as never);
    expect(vm.checkOpenApiSync).not.toHaveBeenCalled();
    page.visibilityState = 'visible';
    openApiSyncFeature.openApiSchedulerTick.call(vm as never);
    expect(vm.checkOpenApiSync).toHaveBeenCalledWith(due.id);
  });
});
