import { stableStringify } from './manualSave';
import type { Environment, KVRow } from './types/models';
import { cloneRowsForStore } from './utils';

function rowsFingerprint(rows: KVRow[]) {
  return cloneRowsForStore(rows).map(({ id, ...row }) => row);
}

export function environmentFingerprint(environment: Environment) {
  return stableStringify({ ...environment, values: rowsFingerprint(environment.values) });
}

export function globalsFingerprint(rows: KVRow[]) {
  return stableStringify(rowsFingerprint(rows));
}

export function trackEnvironmentEdit(previous: Environment[], next: Environment[], baselines: Map<string, Environment>) {
  const before = new Map(previous.map(environment => [environment.id, environment]));
  const result = new Map(baselines);
  for (const environment of next) {
    const old = before.get(environment.id);
    if (old && old !== environment && !result.has(environment.id)) result.set(environment.id, old);
  }
  const current = new Map(next.map(environment => [environment.id, environment]));
  for (const [id, baseline] of result) {
    const environment = current.get(id);
    if (!environment || environmentFingerprint(environment) === environmentFingerprint(baseline)) result.delete(id);
  }
  return result;
}

export function environmentsForStore(environments: Environment[], baselines: Map<string, Environment>) {
  if (!baselines.size) return environments;
  return environments.map(environment => baselines.get(environment.id) ?? environment);
}

export function mapEnvironmentBaselines(baselines: Map<string, Environment>, change: (environment: Environment) => Environment) {
  if (!baselines.size) return baselines;
  return new Map([...baselines].map(([id, environment]) => [id, change(environment)]));
}

export function trackGlobalsEdit(previous: KVRow[], next: KVRow[], baseline: KVRow[] | null) {
  const saved = baseline ?? previous;
  return globalsFingerprint(saved) === globalsFingerprint(next) ? null : saved;
}

export function enabledValues(rows: KVRow[]) {
  const values: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key && row.enabled) values[key] = row.value;
  }
  return values;
}

export function changedValues(before: Record<string, string>, after: Record<string, string>) {
  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(after)) {
    if (before[key] !== value) updates[key] = value;
  }
  return updates;
}
