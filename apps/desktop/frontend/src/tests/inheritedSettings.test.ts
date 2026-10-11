import { describe, expect, it } from 'vitest';
import { normalizeSavedRequest } from '../lib/normalizers';
import { emptyCollectionDefaults } from '../lib/collectionDefaults';
import { DEFAULT_REQUEST_SETTINGS } from '../lib/constants';
import type { Collection, SavedRequest } from '../lib/types/models';

const browserDefaults = {
  ...DEFAULT_REQUEST_SETTINGS,
  browserEmulation: true,
  browserEnforceCORS: true,
  browserOrigin: 'https://app.example.com',
  browserWithCredentials: true,
};

function collection(): Collection {
  return {
    id: 'collection-ef',
    workspaceId: 'workspace-1',
    name: 'EF',
    defaults: { ...emptyCollectionDefaults(), settings: { ...browserDefaults } },
  } as Collection;
}

function stored(settings: Partial<SavedRequest['settings']>): Partial<SavedRequest> {
  return {
    id: 'req-1', name: 'New Request', collectionId: 'collection-ef', method: 'GET',
    url: 'https://countries.trevorblades.com/', settings: { ...DEFAULT_REQUEST_SETTINGS, ...settings },
  };
}

describe('settings inherited from the collection', () => {
  it('are not turned into overrides when the file has none', () => {
    const request = normalizeSavedRequest(stored({
      browserEmulation: true,
      browserEnforceCORS: true,
      browserOrigin: 'https://app.example.com',
      browserWithCredentials: true,
    }), [collection()], 'workspace-1');
    expect(request.settingsOverrides).toEqual({});
  });

  it('still count as overrides when they differ from the collection', () => {
    const request = normalizeSavedRequest(stored({ browserOrigin: 'https://other.example.com', timeoutMs: 5000 }), [collection()], 'workspace-1');
    expect(request.settingsOverrides).toEqual({ browserOrigin: true, timeoutMs: true });
  });

  it('keep explicit overrides from the file', () => {
    const request = normalizeSavedRequest({ ...stored({ browserEmulation: true }), settingsOverrides: { browserEmulation: true } }, [collection()], 'workspace-1');
    expect(request.settingsOverrides).toEqual({ browserEmulation: true });
  });
});
