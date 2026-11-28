import { describe, it, expect, vi } from 'vitest';

import { collectionDefaultsFeature } from '../lib/stores/features/collectionDefaults';
import type { Collection, KVRow } from '../lib/types/models';
import { DEFAULT_REQUEST_SETTINGS } from '../lib/constants';
import { emptyAuthState } from '../lib/utils';

function row(id: number, key: string, value: string, over: Partial<KVRow> = {}): KVRow {
  return { id, enabled: true, key, value, description: '', ...over };
}

function makeCollection(variables: KVRow[]): Collection {
  return {
    id: 'col-1',
    workspaceId: 'ws-1',
    name: 'Smoke',
    filesystemName: 'Smoke',
    description: '',
    collapsed: false,
    defaults: {
      headers: [],
      variables,
      auth: emptyAuthState(),
      preRequestScriptJs: '',
      testScriptJs: '',
      settings: { ...DEFAULT_REQUEST_SETTINGS },
    },
  };
}

function makeHost(variables: KVRow[] = []) {
  const collection = makeCollection(variables);
  return {
    collections: [collection],
    collectionForRequest: () => collection,
    guardWorkspaceWritable: () => true,
    persistRequestStore: vi.fn().mockResolvedValue(true),
    applyCollectionVariableUpdates: collectionDefaultsFeature.applyCollectionVariableUpdates,
  } as any;
}

const req = { collectionId: 'col-1' };

describe('applyCollectionVariableUpdates', () => {
  it('adds a variable a script created', async () => {
    const host = makeHost();
    const changed = await host.applyCollectionVariableUpdates(req, { token: 'abc' }, undefined);
    expect(changed).toBe(true);
    expect(host.collections[0].defaults.variables).toEqual([
      { id: 1, enabled: true, key: 'token', value: 'abc', description: '' },
    ]);
    expect(host.persistRequestStore).toHaveBeenCalledTimes(1);
  });

  it('updates the last enabled row, the one a request uses', async () => {
    const host = makeHost([row(1, 'region', 'eu'), row(2, 'region', 'us'), row(3, 'region', 'off', { enabled: false })]);
    await host.applyCollectionVariableUpdates(req, { region: 'ap' }, undefined);
    expect(host.collections[0].defaults.variables.map((item: KVRow) => item.value)).toEqual(['eu', 'ap', 'off']);
  });

  it('reports a change that could not be saved', async () => {
    const host = makeHost([row(1, 'token', 'old')]);
    host.persistRequestStore.mockResolvedValue(false);
    expect(await host.applyCollectionVariableUpdates(req, { token: 'new' }, undefined)).toBe(false);
  });

  it('updates an existing row in place, preserving its flags and description', async () => {
    const host = makeHost([row(7, 'token', 'old', { secret: true, description: 'API token' })]);
    await host.applyCollectionVariableUpdates(req, { token: 'new' }, undefined);
    expect(host.collections[0].defaults.variables).toEqual([
      { id: 7, enabled: true, key: 'token', value: 'new', description: 'API token', secret: true },
    ]);
  });

  it('removes a variable a script unset', async () => {
    const host = makeHost([row(1, 'keep', 'a'), row(2, 'drop', 'b')]);
    const changed = await host.applyCollectionVariableUpdates(req, undefined, ['drop']);
    expect(changed).toBe(true);
    expect(host.collections[0].defaults.variables.map((r: KVRow) => r.key)).toEqual(['keep']);
  });

  it('assigns a fresh id that does not collide with existing rows', async () => {
    const host = makeHost([row(4, 'a', '1'), row(9, 'b', '2')]);
    await host.applyCollectionVariableUpdates(req, { c: '3' }, undefined);
    const added = host.collections[0].defaults.variables.find((r: KVRow) => r.key === 'c');
    expect(added.id).toBe(10);
  });

  it('does nothing and does not persist when there are no changes', async () => {
    const host = makeHost([row(1, 'token', 'same')]);
    const changed = await host.applyCollectionVariableUpdates(req, { token: 'same' }, undefined);
    expect(changed).toBe(false);
    expect(host.persistRequestStore).not.toHaveBeenCalled();
  });

  it('ignores an empty payload', async () => {
    const host = makeHost();
    expect(await host.applyCollectionVariableUpdates(req, undefined, undefined)).toBe(false);
    expect(await host.applyCollectionVariableUpdates(req, {}, [])).toBe(false);
    expect(host.persistRequestStore).not.toHaveBeenCalled();
  });

  it('writes an empty-string value', async () => {
    const host = makeHost([row(1, 'token', 'abc')]);
    const changed = await host.applyCollectionVariableUpdates(req, { token: '' }, undefined);
    expect(changed).toBe(true);
    expect(host.collections[0].defaults.variables[0].value).toBe('');
  });

  it('refuses to write into a read-only workspace', async () => {
    const host = makeHost();
    host.guardWorkspaceWritable = () => false;
    const changed = await host.applyCollectionVariableUpdates(req, { token: 'abc' }, undefined);
    expect(changed).toBe(false);
    expect(host.persistRequestStore).not.toHaveBeenCalled();
  });

  it('does nothing when the request has no collection', async () => {
    const host = makeHost();
    host.collectionForRequest = () => undefined;
    expect(await host.applyCollectionVariableUpdates(req, { token: 'abc' }, undefined)).toBe(false);
  });
});
