import { mkRow } from './constants';
import type { Environment, KVRow } from './types/models';

export type MatrixCell = { index: number; value: string; enabled: boolean } | null;

export type MatrixRow = {
  key: string;
  secret: boolean;
  cells: Record<string, MatrixCell>;
};

function namedRows(environment: Environment): Array<{ row: KVRow; index: number }> {
  return environment.values
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.key.trim() !== '');
}

function effectiveRowIndex(values: KVRow[], key: string): number {
  let fallback = -1;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index].key.trim() !== key) continue;
    if (values[index].enabled) return index;
    if (fallback < 0) fallback = index;
  }
  return fallback;
}

function effectiveRowIndexes(values: KVRow[]): Map<string, number> {
  const indexes = new Map<string, number>();
  values.forEach((row, index) => {
    const key = row.key.trim();
    if (!key) return;
    const current = indexes.get(key);
    if (current === undefined || row.enabled || !values[current].enabled) indexes.set(key, index);
  });
  return indexes;
}

export function buildEnvironmentMatrix(environments: Environment[]): MatrixRow[] {
  const rows = new Map<string, MatrixRow>();
  for (const environment of environments) {
    const effective = effectiveRowIndexes(environment.values);
    for (const { row, index } of namedRows(environment)) {
      const key = row.key.trim();
      let matrixRow = rows.get(key);
      if (!matrixRow) {
        matrixRow = { key, secret: false, cells: Object.fromEntries(environments.map(env => [env.id, null])) };
        rows.set(key, matrixRow);
      }
      if (effective.get(key) === index) {
        matrixRow.cells[environment.id] = { index, value: row.value, enabled: row.enabled };
      }
      if (row.secret) matrixRow.secret = true;
    }
  }
  return [...rows.values()];
}

function withTrailingBlank(rows: KVRow[]): KVRow[] {
  const last = rows.at(-1);
  if (last && !last.key && !last.value && !last.description && !last.isFile) return rows;
  return [...rows, mkRow()];
}

function withoutTrailingBlank(rows: KVRow[]): KVRow[] {
  const last = rows.at(-1);
  if (last && !last.key && !last.value && !last.description && !last.isFile) return rows.slice(0, -1);
  return rows;
}

export function secretFor(environments: Environment[], key: string): boolean {
  return environments.some(environment => environment.values.some(row => row.key.trim() === key && row.secret));
}

export function setMatrixValue(environment: Environment, key: string, value: string, secret = false): KVRow[] {
  const index = effectiveRowIndex(environment.values, key);
  if (index >= 0) {
    return environment.values.map((row, rowIndex) => (rowIndex === index ? { ...row, value } : row));
  }
  return withTrailingBlank([...withoutTrailingBlank(environment.values), { ...mkRow(), key, value, enabled: true, secret }]);
}

export function unsetMatrixValue(environment: Environment, key: string): KVRow[] {
  return withTrailingBlank(environment.values.filter(row => row.key.trim() !== key));
}

export function renameMatrixKey(environment: Environment, from: string, to: string): KVRow[] {
  return environment.values.map(row => (row.key.trim() === from ? { ...row, key: to } : row));
}

export function setMatrixSecret(environment: Environment, key: string, secret: boolean): KVRow[] {
  return environment.values.map(row => (row.key.trim() === key ? { ...row, secret } : row));
}

export function removeMatrixKey(environment: Environment, key: string): KVRow[] {
  return unsetMatrixValue(environment, key);
}

export function addMatrixKey(environment: Environment, key: string): KVRow[] {
  if (environment.values.some(row => row.key.trim() === key)) return environment.values;
  return withTrailingBlank([...withoutTrailingBlank(environment.values), { ...mkRow(), key, value: '', enabled: true }]);
}

export function matrixKeyProblem(existing: string[], key: string, current = ''): string {
  const trimmed = key.trim();
  if (!trimmed) return 'A variable needs a name.';
  if (/\s/.test(trimmed)) return 'Variable names cannot contain spaces.';
  if (/[{}]/.test(trimmed)) return 'Leave out the braces — {{name}} is how a request refers to it.';
  if (trimmed !== current && existing.includes(trimmed)) return `There is already a variable called ${trimmed}.`;
  return '';
}
