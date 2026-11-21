import { beforeEach, describe, expect, it } from 'vitest';
import { effectiveEnvironmentRows, flattenedEnvironment, inheritedEnvironmentRows } from '../lib/environmentInheritance';
import { isLinkedSecretMarker, normalizeSecretSources, secretSourceId, secretSourceMapping, toggleSecretSourceKey } from '../lib/linkedSecrets';
import { normalizeEnvironment } from '../lib/normalizers';
import { mergeEnvironmentRowsWithValues } from '../lib/stores/features/environments';
import { ensureSecretImportKeys, resetSecretImportsForTests, secretImports } from '../lib/stores/secretImports.svelte';
import type { Environment, KVRow, SecretSource } from '../lib/types/models';

const vault: SecretSource = { provider: 'vault-prod', path: 'kv/data/app' };

function row(key: string, value = '', extra: Partial<KVRow> = {}): KVRow {
  return { id: Math.floor(Math.random() * 1e6), enabled: true, key, value, description: '', ...extra };
}

function env(id: string, values: KVRow[], extra: Partial<Environment> = {}): Environment {
  return { id, workspaceId: 'ws', name: id, filesystemName: id, values, ...extra };
}

async function withKeys(source: SecretSource, keys: string[]) {
  ensureSecretImportKeys('ws');
  await new Promise(resolve => setTimeout(resolve, 0));
  secretImports.keys = { ...secretImports.keys, ws: { ...(secretImports.keys.ws ?? {}), [secretSourceId(source)]: { keys, loadedAt: 1 } } };
}

describe('secret sources', () => {
  beforeEach(() => resetSecretImportsForTests());

  it('normalizes sources from the store and drops broken ones', () => {
    expect(normalizeSecretSources([{ provider: ' vault-prod ', path: 'kv/data/app', prefix: 'db_', keys: ['user', ' user', '', 'pass'] }, { provider: 'x' }, 'nope'])).toEqual([
      { provider: 'vault-prod', path: 'kv/data/app', prefix: 'db_', keys: ['user', 'pass'] },
    ]);
    expect(normalizeEnvironment({ name: 'Prod', values: [], secretSources: [vault] }, 'ws').secretSources).toEqual([vault]);
    expect(normalizeEnvironment({ name: 'Prod', values: [] }, 'ws')).not.toHaveProperty('secretSources');
  });

  it('turns loaded keys into linked variables that rows override', async () => {
    const source = { ...vault, prefix: 'db_' };
    await withKeys(source, ['user', 'password']);
    const prod = env('prod', [row('db_password', 'typed')], { secretSources: [source] });
    const effective = effectiveEnvironmentRows([prod], 'prod');
    const user = effective.get('db_user');
    expect(user?.imported).toEqual(source);
    expect(user?.row.secretRef).toEqual({ provider: 'vault-prod', path: 'kv/data/app', field: 'user' });
    expect(effective.get('db_password')?.row.value).toBe('typed');
    expect(effective.get('db_password')?.imported).toBeUndefined();
  });

  it('uses the keys filter without loaded keys and lets a parent row win over a child import', async () => {
    const base = env('base', [row('token', 'from-base')]);
    const prod = env('prod', [], { parentId: 'base', secretSources: [{ ...vault, keys: ['token', 'apiKey'] }] });
    const effective = effectiveEnvironmentRows([base, prod], 'prod');
    expect(effective.get('token')?.row.value).toBe('from-base');
    expect(effective.get('apiKey')?.imported).toBeTruthy();
    expect(inheritedEnvironmentRows([base, prod], 'prod').get('apiKey')?.imported).toBeTruthy();
    expect(flattenedEnvironment([base, prod], prod).values.map(item => item.key).sort()).toEqual(['apiKey', 'token']);
  });

  it('keeps a script value for an imported key in memory only', async () => {
    await withKeys(vault, ['user']);
    const prod = env('prod', [], { secretSources: [vault] });
    const rows = mergeEnvironmentRowsWithValues(prod.values, { user: '[secret]', plain: 'x' }, inheritedEnvironmentRows([prod], 'prod'));
    expect(rows.filter(item => item.key).map(item => item.key)).toEqual(['plain']);
  });

  it('describes each key of a source', async () => {
    const first = { ...vault, keys: ['user', 'password', 'gone'] };
    const second: SecretSource = { provider: 'op', path: 'op://Payments/Checkout', keys: ['user'] };
    await withKeys(first, ['user', 'password', 'redis_url']);
    const prod = env('prod', [row('password', 'typed')], { secretSources: [first, second] });
    const mapping = secretSourceMapping(first, ['user', 'password', 'redis_url'], effectiveEnvironmentRows([prod], 'prod'), 'prod');
    expect(mapping.map(item => [item.key, item.state])).toEqual([
      ['user', 'replaced'], ['password', 'row'], ['redis_url', 'skipped'], ['gone', 'missing'],
    ]);
    expect(mapping[0].detail).toBe('op · op://Payments/Checkout wins');
  });

  it('toggles keys and drops the filter when every loaded key is checked', () => {
    const loaded = ['user', 'password'];
    const unchecked = toggleSecretSourceKey(vault, 'password', false, loaded);
    expect(unchecked.keys).toEqual(['user']);
    expect(toggleSecretSourceKey(unchecked, 'password', true, loaded)).toEqual(vault);
    expect(toggleSecretSourceKey({ ...vault, keys: ['a'] }, 'b', true, undefined).keys).toEqual(['a', 'b']);
  });

  it('sends imported variables as linked markers', async () => {
    await withKeys(vault, ['user']);
    const prod = env('prod', [], { secretSources: [vault] });
    const value = effectiveEnvironmentRows([prod], 'prod').get('user')?.row;
    const { environmentRowValue } = await import('../lib/linkedSecrets');
    expect(isLinkedSecretMarker(environmentRowValue(value!))).toBe(true);
  });
});
