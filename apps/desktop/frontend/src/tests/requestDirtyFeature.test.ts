import { describe, expect, it } from 'vitest';
import { DEFAULT_REQUEST_SETTINGS } from '../lib/constants';
import { requestDirtyFeature } from '../lib/stores/features/requestDirty';
import type { SavedRequest } from '../lib/types/models';
import { emptyAuthState } from '../lib/utils';

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
    preRequestScript: '',
    testScript: '',
    requestNotes: '',
    settings: { ...DEFAULT_REQUEST_SETTINGS },
    ...overrides,
  };
}

function hostFor(requests: SavedRequest[]) {
  const host = {
    autosave: false,
    dirtyRequestIdList: [] as string[],
    dirtyRequestIds: new Set<string>(),
    draftRequestIds: new Set<string>(),
    requests,
    savedRequestSnapshots: new Map(requests.filter(req => !req.isDraft).map(req => [req.id, requestDirtyFeature.savedRequestSnapshot.call(null as never, req)])),
    unsavedRequestSnapshots: new Map<string, SavedRequest>(),
    requestHasContent: (req: SavedRequest) => Boolean(req.name || req.url || req.bodyContent),
  };
  Object.defineProperties(host, Object.getOwnPropertyDescriptors(requestDirtyFeature));
  return host as typeof host & typeof requestDirtyFeature;
}

describe('requestDirtyFeature', () => {
  it('keeps manual-save edits out of store payload but available for editing', () => {
    const saved = request();
    const edited = { ...saved, url: 'https://changed.example.test' };
    const host = hostFor([saved]);

    host.updateRequestDirtyState(saved.id, edited);

    expect(host.isRequestDirty(saved.id)).toBe(true);
    expect(host.requestForEditing(saved.id)?.url).toBe('https://changed.example.test');
    expect(host.requestsForStore([edited])[0].url).toBe('https://example.test');
  });

  it('clears dirty state for drafts', () => {
    const saved = request();
    const draft = request({ id: 'draft-1', isDraft: true, url: 'https://draft.example.test' });
    const host = hostFor([saved, draft]);
    host.syncDirtyRequestIds(new Set([draft.id]));
    host.unsavedRequestSnapshots.set(draft.id, draft);

    host.updateRequestDirtyState(draft.id, draft);

    expect(host.isRequestDirty(draft.id)).toBe(false);
    expect(host.requestForEditing(draft.id)?.url).toBe('https://draft.example.test');
  });
});

describe('requestDirtyFingerprint', () => {
  it('ignores the order object keys were built in', () => {
    const base = request();
    const reordered = request({
      auth: Object.fromEntries(Object.entries(base.auth).reverse()) as typeof base.auth,
    });
    expect(requestDirtyFeature.requestDirtyFingerprint.call(null as never, reordered))
      .toBe(requestDirtyFeature.requestDirtyFingerprint.call(null as never, base));
  });

  it('still notices a value that actually changed', () => {
    const before = request({ auth: { ...request().auth, bearerToken: 'a' } });
    const after = request({ auth: { ...request().auth, bearerToken: 'b' } });
    expect(requestDirtyFeature.requestDirtyFingerprint.call(null as never, after))
      .not.toBe(requestDirtyFeature.requestDirtyFingerprint.call(null as never, before));
  });

  it('still notices reordered rows', () => {
    const before = request({ params: [{ id: 1, enabled: true, key: 'a', value: '1', description: '' }, { id: 2, enabled: true, key: 'a', value: '2', description: '' }] });
    const after = request({ params: [{ id: 3, enabled: true, key: 'a', value: '2', description: '' }, { id: 4, enabled: true, key: 'a', value: '1', description: '' }] });
    expect(requestDirtyFeature.requestDirtyFingerprint.call(null as never, after))
      .not.toBe(requestDirtyFeature.requestDirtyFingerprint.call(null as never, before));
  });

  it('ignores the row ids the editor hands out', () => {
    const before = request({ params: [{ id: 1, enabled: true, key: 'a', value: '1', description: '' }] });
    const after = request({ params: [{ id: 99, enabled: true, key: 'a', value: '1', description: '' }] });
    expect(requestDirtyFeature.requestDirtyFingerprint.call(null as never, after))
      .toBe(requestDirtyFeature.requestDirtyFingerprint.call(null as never, before));
  });
});
