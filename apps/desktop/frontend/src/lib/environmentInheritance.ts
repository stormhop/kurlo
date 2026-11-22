import type { Environment, KVRow, SecretSource } from './types/models';
import { importedEnvironmentRows } from './stores/secretImports.svelte';

export type InheritedRow = { row: KVRow; sourceId: string; sourceName: string; imported?: SecretSource };

export function environmentChain(environments: Environment[], environmentId: string): Environment[] {
  const chain: Environment[] = [];
  const seen = new Set<string>();
  let current = environments.find(environment => environment.id === environmentId);
  const workspaceId = current?.workspaceId;
  while (current && !seen.has(current.id) && current.workspaceId === workspaceId) {
    chain.push(current);
    seen.add(current.id);
    const parentId = current.parentId;
    current = parentId ? environments.find(environment => environment.id === parentId) : undefined;
  }
  return chain;
}

export function parentEnvironment(environments: Environment[], environment: Environment): Environment | undefined {
  return environmentChain(environments, environment.id)[1];
}

function addImportedRows(target: Map<string, InheritedRow>, environment: Environment) {
  for (const [key, row, source] of importedEnvironmentRows(environment)) {
    const existing = target.get(key);
    if (existing && !existing.imported) continue;
    target.set(key, { row, sourceId: environment.id, sourceName: environment.name, imported: source });
  }
}

export function effectiveEnvironmentRows(environments: Environment[], environmentId: string): Map<string, InheritedRow> {
  const effective = new Map<string, InheritedRow>();
  const chain = environmentChain(environments, environmentId).reverse();
  for (const environment of chain) addImportedRows(effective, environment);
  for (const environment of chain) {
    for (const row of environment.values) {
      const key = row.key.trim();
      if (!row.enabled || !key) continue;
      effective.set(key, { row, sourceId: environment.id, sourceName: environment.name });
    }
  }
  return effective;
}

export function inheritedEnvironmentRows(environments: Environment[], environmentId: string): Map<string, InheritedRow> {
  const [own, parent] = environmentChain(environments, environmentId);
  const inherited = parent ? effectiveEnvironmentRows(environments, parent.id) : new Map<string, InheritedRow>();
  if (own) addImportedRows(inherited, own);
  return inherited;
}

export function inheritedEnvironmentValues(environments: Environment[], environmentId: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, { row }] of inheritedEnvironmentRows(environments, environmentId)) values[key] = row.value;
  return values;
}

export function flattenedEnvironment(environments: Environment[], environment: Environment): Environment {
  if (!environment.parentId && !environment.secretSources?.length) return environment;
  const ownKeys = new Set(environment.values.filter(row => row.enabled && row.key.trim()).map(row => row.key.trim()));
  const inherited = [...inheritedEnvironmentRows(environments, environment.id).entries()]
    .filter(([key]) => !ownKeys.has(key))
    .map(([, { row }]) => ({ ...row }));
  const { parentId: _parentId, ...rest } = environment;
  return { ...rest, values: [...inherited, ...environment.values] };
}

export function environmentIsProtected(environments: Environment[], environmentId: string): boolean {
  return environmentChain(environments, environmentId).some(environment => environment.protected);
}

export function protectingAncestor(environments: Environment[], environmentId: string): Environment | undefined {
  return environmentChain(environments, environmentId).slice(1).find(environment => environment.protected);
}

export function environmentParentCandidates(environments: Environment[], environment: Environment): Environment[] {
  return environments.filter(candidate =>
    candidate.workspaceId === environment.workspaceId
    && candidate.id !== environment.id
    && !environmentChain(environments, candidate.id).some(ancestor => ancestor.id === environment.id));
}

export function environmentChildren(environments: Environment[], environmentId: string): Environment[] {
  return environments.filter(environment => environment.parentId === environmentId);
}
