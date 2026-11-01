import type { Environment, KVRow } from './types/models';

export type InheritedRow = { row: KVRow; sourceId: string; sourceName: string };

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

export function effectiveEnvironmentRows(environments: Environment[], environmentId: string): Map<string, InheritedRow> {
  const effective = new Map<string, InheritedRow>();
  for (const environment of environmentChain(environments, environmentId).reverse()) {
    for (const row of environment.values) {
      const key = row.key.trim();
      if (!row.enabled || !key) continue;
      effective.set(key, { row, sourceId: environment.id, sourceName: environment.name });
    }
  }
  return effective;
}

export function inheritedEnvironmentRows(environments: Environment[], environmentId: string): Map<string, InheritedRow> {
  const parent = environmentChain(environments, environmentId)[1];
  return parent ? effectiveEnvironmentRows(environments, parent.id) : new Map();
}

export function inheritedEnvironmentValues(environments: Environment[], environmentId: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, { row }] of inheritedEnvironmentRows(environments, environmentId)) values[key] = row.value;
  return values;
}

export function flattenedEnvironment(environments: Environment[], environment: Environment): Environment {
  if (!environment.parentId) return environment;
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
