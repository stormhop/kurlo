import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultMatrixColumns,
  readMatrixColumns,
  toggleMatrixColumn,
  visibleMatrixEnvironments,
  writeMatrixColumns,
} from '../lib/environmentMatrixColumns';
import { readEnvironmentView } from '../lib/stores/features/environments';
import type { Environment } from '../lib/types/models';

function env(id: string): Environment {
  return { id, workspaceId: 'ws', name: id, filesystemName: id, values: [] };
}

const many = Array.from({ length: 38 }, (_, i) => env(`env-${String(i).padStart(2, '0')}`));
const ids = (list: Environment[]) => list.map(environment => environment.id);

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('environment matrix columns', () => {
  it('shows the environment in use and the first others up to five by default, in list order', () => {
    expect(defaultMatrixColumns(many, 'env-20')).toEqual(['env-00', 'env-01', 'env-02', 'env-03', 'env-20']);
    expect(defaultMatrixColumns(many, '')).toEqual(['env-00', 'env-01', 'env-02', 'env-03', 'env-04']);
    expect(defaultMatrixColumns(many.slice(0, 3), 'env-01')).toEqual(['env-00', 'env-01', 'env-02']);
  });

  it('keeps the environment in use visible and drops ids that no longer exist', () => {
    expect(ids(visibleMatrixEnvironments(many, ['env-07', 'gone'], 'env-30'))).toEqual(['env-07', 'env-30']);
    expect(ids(visibleMatrixEnvironments(many, null, 'env-01'))).toEqual(['env-00', 'env-01', 'env-02', 'env-03', 'env-04']);
    expect(ids(visibleMatrixEnvironments(many, ['gone'], ''))).toEqual(['env-00', 'env-01', 'env-02', 'env-03', 'env-04']);
  });

  it('toggles a column starting from what is visible', () => {
    expect(toggleMatrixColumn(many, null, 'env-00', 'env-37')).toEqual(['env-00', 'env-01', 'env-02', 'env-03', 'env-04', 'env-37']);
    expect(toggleMatrixColumn(many, ['env-00', 'env-05'], 'env-00', 'env-05')).toEqual(['env-00']);
  });

  it('remembers the choice per workspace', () => {
    expect(readMatrixColumns('ws')).toBeNull();
    writeMatrixColumns('ws', ['env-01']);
    writeMatrixColumns('other', ['env-02']);
    expect(readMatrixColumns('ws')).toEqual(['env-01']);
    writeMatrixColumns('ws', null);
    expect(readMatrixColumns('ws')).toBeNull();
    expect(readMatrixColumns('other')).toEqual(['env-02']);
    localStorage.setItem('kurlo.environmentMatrixColumns.v1', 'not json');
    expect(readMatrixColumns('other')).toBeNull();
  });

  it('opens environments one at a time unless the matrix was chosen', () => {
    expect(readEnvironmentView()).toBe('single');
    localStorage.setItem('kurlo.environmentView.v1', 'matrix');
    expect(readEnvironmentView()).toBe('matrix');
  });
});
