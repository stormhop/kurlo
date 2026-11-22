import { listSecretImportKeys, loadSecretImportKeys } from '../secretProvidersBackend';
import { secretSourceId, secretSourceRow, secretSourceVariables } from '../linkedSecrets';
import type { Environment, KVRow, SecretSource } from '../types/models';

export type SecretImportKeyset = { keys: string[]; loadedAt: number };

export const secretImports = $state({
  keys: {} as Record<string, Record<string, SecretImportKeyset>>,
  loading: {} as Record<string, boolean>,
});

let requested: Record<string, true> = {};

export function ensureSecretImportKeys(workspaceId: string) {
  if (!workspaceId || requested[workspaceId]) return;
  requested[workspaceId] = true;
  void refreshSecretImportKeys(workspaceId);
}

export async function refreshSecretImportKeys(workspaceId: string) {
  if (!workspaceId) return;
  const listed = await listSecretImportKeys(workspaceId);
  const next: Record<string, SecretImportKeyset> = {};
  for (const item of listed) next[secretSourceId(item)] = { keys: item.keys ?? [], loadedAt: item.loadedAt ?? 0 };
  secretImports.keys = { ...secretImports.keys, [workspaceId]: next };
}

export function secretImportKeyset(workspaceId: string, source: Pick<SecretSource, 'provider' | 'path' | 'version'>): SecretImportKeyset | undefined {
  ensureSecretImportKeys(workspaceId);
  return secretImports.keys[workspaceId]?.[secretSourceId(source)];
}

export async function loadKeysForSource(workspaceId: string, source: Pick<SecretSource, 'provider' | 'path' | 'version'>) {
  const id = `${workspaceId}\u0000${secretSourceId(source)}`;
  secretImports.loading = { ...secretImports.loading, [id]: true };
  try {
    const result = await loadSecretImportKeys(workspaceId, { provider: source.provider, path: source.path, ...(source.version ? { version: source.version } : {}) });
    if (result.ok) {
      const current = secretImports.keys[workspaceId] ?? {};
      secretImports.keys = { ...secretImports.keys, [workspaceId]: { ...current, [secretSourceId(source)]: { keys: result.keys ?? [], loadedAt: result.loadedAt } } };
    }
    return result;
  } finally {
    const { [id]: _done, ...rest } = secretImports.loading;
    secretImports.loading = rest;
  }
}

export function secretSourceLoading(workspaceId: string, source: Pick<SecretSource, 'provider' | 'path' | 'version'>) {
  return Boolean(secretImports.loading[`${workspaceId}\u0000${secretSourceId(source)}`]);
}

export function importedEnvironmentRows(environment: Environment): Array<[string, KVRow, SecretSource]> {
  const sources = environment.secretSources ?? [];
  if (!sources.length) return [];
  const out: Array<[string, KVRow, SecretSource]> = [];
  let index = 0;
  for (const source of sources) {
    const keyset = source.keys ? undefined : secretImportKeyset(environment.workspaceId, source);
    for (const { key, variable } of secretSourceVariables(source, keyset?.keys)) {
      if (!variable.trim()) continue;
      out.push([variable, secretSourceRow(source, key, index++), source]);
    }
  }
  return out;
}

export function resetSecretImportsForTests() {
  requested = {};
  secretImports.keys = {};
  secretImports.loading = {};
}
