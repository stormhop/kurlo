import type { SavedRequest } from '../lib/types/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  migrateRequestSectionPreferences,
  requestSectionPreference,
  saveRequestSectionPreference,
} from '../lib/requestTabPreferences';

let storage = new Map<string, string>();

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('request section preferences', () => {
  it('migrates legacy selections to the owning workspace', () => {
    const requests: Pick<SavedRequest, 'id' | 'requestTab' | 'collectionId'>[] = [
      { id: 'http', collectionId: '', requestTab: 'headers' },
      { id: 'query', collectionId: 'graphql-collection', requestTab: 'query' },
    ];
    migrateRequestSectionPreferences('/workspaces', 'workspace-a', [{ id: 'graphql-collection', workspaceId: 'workspace-b' }], requests);

    expect(requestSectionPreference('/workspaces', 'workspace-a', 'http')).toBe('headers');
    expect(requestSectionPreference('/workspaces', 'workspace-b', 'query')).toBe('query');
  });

  it('isolates physical roots, workspaces and requests with safe flat keys', () => {
    saveRequestSectionPreference('/workspaces', '__proto__', 'constructor', 'file');
    saveRequestSectionPreference('/other-root', '__proto__', 'constructor', 'settings');

    expect(requestSectionPreference('/workspaces', '__proto__', 'constructor')).toBe('file');
    expect(requestSectionPreference('/other-root', '__proto__', 'constructor')).toBe('settings');
    expect(requestSectionPreference('/workspaces', '__proto__', 'other')).toBeUndefined();
  });

  it('keeps a valid preference ahead of legacy values and ignores invalid values', () => {
    saveRequestSectionPreference('/workspaces', 'workspace-a', 'request', 'body');
    migrateRequestSectionPreferences('/workspaces', 'workspace-a', [], [{ id: 'request', collectionId: '', requestTab: 'headers' }]);
    saveRequestSectionPreference('/workspaces', 'workspace-a', 'bad', 'headers');
    for (const [key, value] of storage) if (value === 'headers') storage.set(key, 'invalid');

    expect(requestSectionPreference('/workspaces', 'workspace-a', 'request')).toBe('body');
    expect(requestSectionPreference('/workspaces', 'workspace-a', 'bad')).toBeUndefined();
  });

  it('remembers the selection for this session when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('unavailable'); }, setItem: () => { throw new Error('unavailable'); } });

    saveRequestSectionPreference('/offline', 'workspace-a', 'request', 'headers');
    expect(requestSectionPreference('/offline', 'workspace-a', 'request')).toBe('headers');
  });
});
