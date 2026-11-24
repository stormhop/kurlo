import { describe, expect, it } from 'vitest';
import {
  requestDiffersFromSavedSnapshot,
  requestForEditingSnapshot,
  updateManualRequestSnapshot,
} from '../lib/manualSave';
import { DEFAULT_REQUEST_SETTINGS } from '../lib/constants';
import { cloneRowsForStore, emptyAuthState, restoreRows } from '../lib/utils';
import type { SavedRequest } from '../lib/types/models';

function request(overrides: Partial<SavedRequest> = {}): SavedRequest {
  return {
    id: 'req-1',
    name: 'Original',
    nameAuto: false,
    requestType: 'http',
    isDraft: false,
    collectionId: 'collection-1',
    collection: 'Collection',
    folderPath: [],
    method: 'GET',
    url: 'https://example.test',
    requestTab: 'params',
    params: [],
    headers: [],
    auth: emptyAuthState(),
    bodyType: 'none',
    rawBodyType: 'json',
    bodyContent: '',
    bodyFilePath: '',
    bodyFileName: '',
    formRows: [],
    requestNotes: '',
    settings: { ...DEFAULT_REQUEST_SETTINGS },
    ...overrides,
  };
}

describe('manual save request snapshots', () => {
  it('keeps request title changes outside the saved list until Save', () => {
    const saved = request();
    const edited = { ...saved, name: 'Unsaved title' };

    const state = updateManualRequestSnapshot(
      saved.id,
      edited,
      new Map([[saved.id, saved]]),
      new Set(),
      new Map(),
    );

    expect(saved.name).toBe('Original');
    expect(state.dirtyRequestIds.has(saved.id)).toBe(true);
    expect(state.unsavedRequestSnapshots.get(saved.id)?.name).toBe('Unsaved title');
    expect(requestForEditingSnapshot(saved.id, [saved], state.unsavedRequestSnapshots)?.name).toBe('Unsaved title');
  });

  it('clears the unsaved snapshot once the edit matches the saved request again', () => {
    const saved = request();
    const dirty = updateManualRequestSnapshot(
      saved.id,
      { ...saved, url: 'https://changed.example.test' },
      new Map([[saved.id, saved]]),
      new Set(),
      new Map(),
    );

    const clean = updateManualRequestSnapshot(
      saved.id,
      { ...saved },
      new Map([[saved.id, saved]]),
      dirty.dirtyRequestIds,
      dirty.unsavedRequestSnapshots,
    );

    expect(clean.dirtyRequestIds.has(saved.id)).toBe(false);
    expect(clean.unsavedRequestSnapshots.has(saved.id)).toBe(false);
    expect(requestForEditingSnapshot(saved.id, [saved], clean.unsavedRequestSnapshots)?.name).toBe('Original');
  });

  it('does not mark a request dirty when only the active editor tab changes', () => {
    const saved = request();
    const state = updateManualRequestSnapshot(
      saved.id,
      { ...saved, requestTab: 'auth' },
      new Map([[saved.id, saved]]),
      new Set(),
      new Map(),
    );

    expect(state.dirtyRequestIds.has(saved.id)).toBe(false);
    expect(state.unsavedRequestSnapshots.has(saved.id)).toBe(false);
  });

  it('does not mark a request dirty when only generated row ids change', () => {
    const saved = request({
      params: [{ id: 1, enabled: true, key: 'q', value: '1', description: '', isFile: false, fileName: '', secret: false }],
      headers: [{ id: 2, enabled: true, key: 'Accept', value: 'application/json', description: '', isFile: false, fileName: '', secret: false }],
      formRows: [{ id: 3, enabled: true, key: 'file', value: '', description: '', isFile: true, fileName: 'data.json', secret: false }],
      sioEvents: [{ id: 4, enabled: true, key: 'message', value: '', description: '', isFile: false, fileName: '', secret: false }],
      sioArgs: [{ id: 'arg-1', content: '{"ok":true}', bodyType: 'json', encoding: 'base64' }],
    });
    const edited = request({
      ...saved,
      params: [{ id: 11, enabled: true, key: 'q', value: '1', description: '', isFile: false, fileName: '', secret: false }],
      headers: [{ id: 12, enabled: true, key: 'Accept', value: 'application/json', description: '', isFile: false, fileName: '', secret: false }],
      formRows: [{ id: 13, enabled: true, key: 'file', value: '', description: '', isFile: true, fileName: 'data.json', secret: false }],
      sioEvents: [{ id: 14, enabled: true, key: 'message', value: '', description: '', isFile: false, fileName: '', secret: false }],
      sioArgs: [{ id: 'arg-2', content: '{"ok":true}', bodyType: 'json', encoding: 'base64' }],
    });

    const state = updateManualRequestSnapshot(
      saved.id,
      edited,
      new Map([[saved.id, saved]]),
      new Set(),
      new Map(),
    );

    expect(state.dirtyRequestIds.has(saved.id)).toBe(false);
    expect(state.unsavedRequestSnapshots.has(saved.id)).toBe(false);
  });

  it('does not mark a request dirty after open→send when it has content rows', () => {

    const storedHeaders = cloneRowsForStore([
      { id: 5, enabled: true, key: 'Accept', value: 'application/json', description: '', isFile: false, fileName: '', secret: false },
    ]);
    const saved = request({ headers: storedHeaders });


    const edited = request({ headers: cloneRowsForStore(restoreRows(saved.headers)) });

    const state = updateManualRequestSnapshot(
      saved.id,
      edited,
      new Map([[saved.id, saved]]),
      new Set(),
      new Map(),
    );

    expect(state.dirtyRequestIds.has(saved.id)).toBe(false);
    expect(state.unsavedRequestSnapshots.has(saved.id)).toBe(false);
  });

  it('keeps cloneRowsForStore key order stable regardless of input order', () => {
    const canonical = cloneRowsForStore([
      { id: 1, enabled: true, key: 'k', value: 'v', description: '', isFile: false, fileName: '', secret: false },
    ]);
    const shuffled = cloneRowsForStore([
      { secret: false, fileName: '', isFile: false, description: '', value: 'v', key: 'k', enabled: true, id: 1 } as never,
    ]);
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(canonical));
  });

  it('stores a plain snapshot when request arrays are proxies', () => {
    const saved = request();
    const proxiedParams = new Proxy([{ id: 'row-1', enabled: true, key: 'q', value: '1' }], {});
    const edited = request({ name: 'Proxy edit', params: proxiedParams });

    const state = updateManualRequestSnapshot(
      saved.id,
      edited,
      new Map([[saved.id, saved]]),
      new Set(),
      new Map(),
    );

    expect(state.dirtyRequestIds.has(saved.id)).toBe(true);
    expect(state.unsavedRequestSnapshots.get(saved.id)?.params).toEqual([{ id: 'row-1', enabled: true, key: 'q', value: '1' }]);
  });
});

describe('requestDiffersFromSavedSnapshot', () => {
  it('ignores collection names but detects moving to another collection', () => {
    const saved = request();
    expect(requestDiffersFromSavedSnapshot(request({ collection: 'Renamed' }), saved)).toBe(false);
    expect(requestDiffersFromSavedSnapshot(request({ collectionId: 'collection-2' }), saved)).toBe(true);
  });

  it('treats a missing draft flag as a saved request', () => {
    const saved = request();
    delete (saved as Partial<SavedRequest>).isDraft;
    expect(requestDiffersFromSavedSnapshot(request(), saved)).toBe(false);
    expect(requestDiffersFromSavedSnapshot(request({ isDraft: true }), saved)).toBe(true);
    expect(requestDiffersFromSavedSnapshot(request({ url: 'https://example.test ' }), saved)).toBe(true);
  });

  it('keeps URL-only and params-only saved requests clean after editor hydration', () => {
    const urlOnly = request({ url: 'https://example.test/items?tag=red&tag=blue&limit=2', params: [] });
    const hydratedUrlOnly = request({
      url: 'https://example.test/items?tag=red&tag=blue&limit=2',
      params: [
        { id: 1, enabled: true, key: 'tag', value: 'red', description: '' },
        { id: 2, enabled: true, key: 'tag', value: 'blue', description: '' },
        { id: 3, enabled: true, key: 'limit', value: '2', description: '' },
        { id: 4, enabled: true, key: '', value: '', description: '' },
      ],
    });
    const paramsOnly = request({
      url: 'https://example.test/items',
      params: [{ id: 1, enabled: true, key: 'tag', value: 'red', description: '' }],
    });
    const hydratedParamsOnly = request({
      url: 'https://example.test/items?tag=red',
      params: [
        { id: 2, enabled: true, key: 'tag', value: 'red', description: '' },
        { id: 3, enabled: true, key: '', value: '', description: '' },
      ],
    });

    expect(requestDiffersFromSavedSnapshot(hydratedUrlOnly, urlOnly)).toBe(false);
    expect(requestDiffersFromSavedSnapshot(hydratedParamsOnly, paramsOnly)).toBe(false);
  });

  it('detects edits to one of several duplicate URL query values', () => {
    const saved = request({ url: 'https://example.test/items?tag=red&tag=blue&limit=2', params: [] });
    const edited = request({
      url: 'https://example.test/items?tag=red&tag=green&limit=2',
      params: [
        { id: 1, enabled: true, key: 'tag', value: 'red', description: '' },
        { id: 2, enabled: true, key: 'tag', value: 'green', description: '' },
        { id: 3, enabled: true, key: 'limit', value: '2', description: '' },
        { id: 4, enabled: true, key: '', value: '', description: '' },
      ],
    });

    expect(requestDiffersFromSavedSnapshot(edited, saved)).toBe(true);
  });
});
