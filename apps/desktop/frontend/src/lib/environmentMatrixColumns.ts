import type { Environment } from './types/models';

export const MATRIX_DEFAULT_COLUMNS = 5;
export const MATRIX_COLUMNS_KEY = 'kurlo.environmentMatrixColumns.v1';

export function defaultMatrixColumns(environments: Environment[], activeId: string, limit = MATRIX_DEFAULT_COLUMNS): string[] {
  const picked = new Set<string>();
  if (environments.some(environment => environment.id === activeId)) picked.add(activeId);
  for (const environment of environments) {
    if (picked.size >= limit) break;
    picked.add(environment.id);
  }
  return environments.filter(environment => picked.has(environment.id)).map(environment => environment.id);
}

export function visibleMatrixEnvironments(environments: Environment[], chosen: string[] | null, activeId: string): Environment[] {
  const ids = new Set(chosen ?? defaultMatrixColumns(environments, activeId));
  if (environments.some(environment => environment.id === activeId)) ids.add(activeId);
  const visible = environments.filter(environment => ids.has(environment.id));
  if (visible.length) return visible;
  const fallback = new Set(defaultMatrixColumns(environments, activeId));
  return environments.filter(environment => fallback.has(environment.id));
}

export function toggleMatrixColumn(environments: Environment[], chosen: string[] | null, activeId: string, environmentId: string): string[] {
  const current = visibleMatrixEnvironments(environments, chosen, activeId).map(environment => environment.id);
  const next = current.includes(environmentId) ? current.filter(id => id !== environmentId) : [...current, environmentId];
  const ids = new Set(next);
  return environments.filter(environment => ids.has(environment.id)).map(environment => environment.id);
}

function readAll(): Record<string, string[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(MATRIX_COLUMNS_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function readMatrixColumns(workspaceId: string): string[] | null {
  const value = readAll()[workspaceId];
  return Array.isArray(value) && value.every(id => typeof id === 'string') ? value : null;
}

export function writeMatrixColumns(workspaceId: string, ids: string[] | null) {
  const all = readAll();
  if (ids) all[workspaceId] = ids;
  else delete all[workspaceId];
  try {
    localStorage.setItem(MATRIX_COLUMNS_KEY, JSON.stringify(all));
  } catch {}
}
