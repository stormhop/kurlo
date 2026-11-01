import { describe, expect, it, vi } from 'vitest';
import { mkRow } from '../lib/constants';
import {
  effectiveEnvironmentRows,
  environmentIsProtected,
  environmentParentCandidates,
  flattenedEnvironment,
  inheritedEnvironmentValues,
} from '../lib/environmentInheritance';
import { normalizeEnvironment } from '../lib/normalizers';
import { environmentFeature, mergeEnvironmentRowsWithValues } from '../lib/stores/features/environments';
import type { Environment, KVRow } from '../lib/types/models';

function row(key: string, value: string, extra: Partial<KVRow> = {}): KVRow {
  return { ...mkRow(), key, value, enabled: true, ...extra };
}

function env(id: string, values: KVRow[], extra: Partial<Environment> = {}): Environment {
  return { id, workspaceId: 'ws', name: id[0].toUpperCase() + id.slice(1), filesystemName: id, values, ...extra };
}

const base = env('base', [row('baseUrl', 'https://base'), row('token', 't', { secret: true, description: 'API credential' }), row('off', 'x', { enabled: false })]);
const stage = env('stage', [row('baseUrl', 'https://stage'), row('region', 'eu')], { parentId: 'base' });
const stageEu = env('stageEu', [row('token', '', { enabled: false })], { parentId: 'stage' });
const all = [base, stage, stageEu];

describe('environment inheritance', () => {
  it('takes every value an environment does not set from the nearest ancestor', () => {
    const effective = effectiveEnvironmentRows(all, 'stageEu');
    expect(Object.fromEntries([...effective].map(([key, item]) => [key, [item.row.value, item.sourceName]]))).toEqual({
      baseUrl: ['https://stage', 'Stage'],
      token: ['t', 'Base'],
      region: ['eu', 'Stage'],
    });
    expect(effective.get('token')?.row.secret).toBe(true);
  });

  it('reports only what the parent chain provides as inherited', () => {
    expect(inheritedEnvironmentValues(all, 'stage')).toEqual({ baseUrl: 'https://base', token: 't' });
    expect(inheritedEnvironmentValues(all, 'base')).toEqual({});
  });

  it('flattens an environment for export with its own rows winning', () => {
    const flat = flattenedEnvironment(all, stage);
    expect(flat.parentId).toBeUndefined();
    expect(flat.values.map(item => [item.key, item.value])).toEqual([['token', 't'], ['baseUrl', 'https://stage'], ['region', 'eu']]);
  });

  it('stops at a cycle and at a parent from another workspace', () => {
    const loop = [env('a', [row('x', 'a')], { parentId: 'b' }), env('b', [row('y', 'b')], { parentId: 'a', protected: true })];
    expect(Object.keys(Object.fromEntries(effectiveEnvironmentRows(loop, 'a')))).toEqual(['y', 'x']);
    const foreign = [base, env('other', [], { parentId: 'base', workspaceId: 'ws-2' })];
    expect(effectiveEnvironmentRows(foreign, 'other').size).toBe(0);
  });

  it('treats an environment under a protected one as protected', () => {
    const guarded = [{ ...base, protected: true }, stage, stageEu];
    expect(environmentIsProtected(guarded, 'stageEu')).toBe(true);
    expect(environmentIsProtected(all, 'stageEu')).toBe(false);
  });

  it('offers only parents that would not make a cycle', () => {
    expect(environmentParentCandidates(all, base).map(item => item.id)).toEqual([]);
    expect(environmentParentCandidates(all, stageEu).map(item => item.id)).toEqual(['base', 'stage']);
  });

  it('keeps parentId through normalization unless it points at itself', () => {
    expect(normalizeEnvironment({ id: 'e1', name: 'E', parentId: ' base ', values: [] }, 'ws').parentId).toBe('base');
    expect(normalizeEnvironment({ id: 'e1', name: 'E', parentId: 'e1', values: [] }, 'ws').parentId).toBeUndefined();
  });
});

describe('environment inheritance in the store', () => {
  function host(environments: Environment[], activeEnvironmentId = 'stage') {
    const h = {
      environments,
      activeEnvironmentId,
      activeWorkspaceId: 'ws',
      guardWorkspaceWritable: () => true,
      persistRequestStore: vi.fn().mockResolvedValue(true),
      syncBackendEnvironment: vi.fn().mockResolvedValue(undefined),
      openConfirmDialog: vi.fn().mockResolvedValue(true),
      topView: 'environment',
      get activeWorkspaceEnvironments() { return h.environments; },
    } as Record<string, unknown> & { environments: Environment[] };
    for (const [name, fn] of Object.entries(environmentFeature)) {
      if (typeof fn === 'function') h[name] = (fn as (...args: unknown[]) => unknown).bind(h);
    }
    return h as typeof h & typeof environmentFeature;
  }

  it('resolves values and secrets through the parent', () => {
    const h = host(all, 'stageEu');
    expect(h.activeEnvironmentValues()).toEqual({ baseUrl: 'https://stage', region: 'eu', token: 't' });
    expect(h.activeSecretEnvironmentKeys()).toEqual(['token']);
  });

  it('writes script changes to the child without copying inherited values', async () => {
    const h = host(all.map(item => ({ ...item, values: [...item.values] })));
    await h.mergeActiveEnvironmentValues({ baseUrl: 'https://stage', region: 'eu', token: 't', session: 'abc' });
    expect(h.environments[1].values.filter(item => item.key).map(item => [item.key, item.value])).toEqual([
      ['baseUrl', 'https://stage'], ['region', 'eu'], ['session', 'abc'],
    ]);
    await h.mergeActiveEnvironmentValues({ baseUrl: 'https://stage', region: 'eu', token: 'changed', session: 'abc' });
    expect(h.environments[1].values.find(item => item.key === 'token')?.value).toBe('changed');
    expect(h.environments[1].values.find(item => item.key === 'token')?.secret).toBe(true);
    expect(h.environments[1].values.find(item => item.key === 'token')?.description).toBe('API credential');
    expect(h.environments[1].values.find(item => item.key === 'token')?.id).not.toBe(base.values[1].id);
    expect(h.activeSecretEnvironmentValues()).toContain('changed');
    expect(h.redactedActiveEnvironmentValues().token).toBe('{{token}}');
    expect(h.environments[0].values.find(item => item.key === 'token')?.value).toBe('t');
  });

  it('keeps inherited secrets secret when a response updates an environment that is no longer active', async () => {
    const h = host(all.map(item => ({ ...item, values: [...item.values] })), 'base');
    h.syncBackendEnvironment = vi.fn().mockResolvedValue(undefined);
    await h.applyEnvironmentChangesFromResponse({ environmentUpdates: { token: 'rotated' } }, 'stage');
    expect(h.environments[1].values).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'token', value: 'rotated', secret: true, description: 'API credential' }),
    ]));
    expect(h.environments[0].values[1].value).toBe('t');
    expect(h.persistRequestStore).toHaveBeenCalled();
  });

  it('skips inherited values that scripts left unchanged', () => {
    const inherited = new Map([['inherited', { row: row('inherited', 'p'), sourceId: 'base', sourceName: 'Base' }]]);
    const merged = mergeEnvironmentRowsWithValues([row('own', '1')], { own: '1', inherited: 'p' }, inherited);
    expect(merged.filter(item => item.key).map(item => item.key)).toEqual(['own']);
  });

  it('refuses a parent that would make a cycle and clears it with an empty id', async () => {
    const h = host(all.map(item => ({ ...item })));
    await h.setEnvironmentParent('base', 'stageEu');
    expect(h.environments[0].parentId).toBeUndefined();
    await h.setEnvironmentParent('stageEu', 'base');
    expect(h.environments[2].parentId).toBe('base');
    await h.setEnvironmentParent('stageEu', '');
    expect(h.environments[2].parentId).toBeUndefined();
  });

  it('moves children to the grandparent when their parent is deleted', async () => {
    const h = host(all.map(item => ({ ...item })), 'base');
    await h.deleteEnvironment('stage');
    expect(h.environments.map(item => [item.id, item.parentId])).toEqual([['base', undefined], ['stageEu', 'base']]);
    expect(h.openConfirmDialog.mock.calls[0][1]).toContain('StageEu inherits from it and will inherit from Base instead');
  });
});
