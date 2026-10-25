import { describe, expect, it } from 'vitest';
import {
  addMatrixKey,
  buildEnvironmentMatrix,
  matrixKeyProblem,
  removeMatrixKey,
  renameMatrixKey,
  setMatrixSecret,
  setMatrixValue,
  unsetMatrixValue,
} from '../lib/environmentMatrix';
import type { Environment, KVRow } from '../lib/types/models';

let nextId = 1;
function row(key: string, value: string, extra: Partial<KVRow> = {}): KVRow {
  return { id: nextId++, enabled: true, key, value, description: '', secret: false, ...extra };
}
const blank = () => row('', '');

function env(id: string, values: KVRow[]): Environment {
  return { id, workspaceId: 'ws', name: id, filesystemName: id, values };
}

const keys = (values: KVRow[]) => values.map(value => value.key);

describe('buildEnvironmentMatrix', () => {
  it('lines every variable up across the environments, by name', () => {
    const local = env('local', [row('baseUrl', 'http://localhost'), row('token', 'dev'), blank()]);
    const staging = env('staging', [row('token', 'stg', { secret: true }), row('baseUrl', 'https://staging'), row('region', 'eu'), blank()]);

    const matrix = buildEnvironmentMatrix([local, staging]);

    expect(matrix.map(entry => entry.key)).toEqual(['baseUrl', 'token', 'region']);
    expect(matrix[0].cells.local?.value).toBe('http://localhost');
    expect(matrix[0].cells.staging?.value).toBe('https://staging');
    expect(matrix[2].cells.local).toBeNull();
    expect(matrix[1].secret).toBe(true);
  });

  it('reads the last enabled row of a duplicated name, as the request resolver does', () => {
    const local = env('local', [row('baseUrl', 'first'), row('baseUrl', 'second')]);
    expect(buildEnvironmentMatrix([local])[0].cells.local).toEqual({ index: 1, value: 'second', enabled: true });

    const withDisabled = env('local', [row('baseUrl', 'first'), { ...row('baseUrl', 'off'), enabled: false }]);
    expect(buildEnvironmentMatrix([withDisabled])[0].cells.local).toEqual({ index: 0, value: 'first', enabled: true });
    expect(setMatrixValue(withDisabled, 'baseUrl', 'new').map(item => item.value)).toEqual(['new', 'off']);
  });
});

describe('matrix edits', () => {
  it('sets a value where the variable exists and adds it where it does not', () => {
    const local = env('local', [row('baseUrl', 'old'), blank()]);
    expect(setMatrixValue(local, 'baseUrl', 'new')[0].value).toBe('new');

    const added = setMatrixValue(local, 'token', 'abc', true);
    expect(keys(added)).toEqual(['baseUrl', 'token', '']);
    expect(added[1]).toMatchObject({ key: 'token', value: 'abc', enabled: true, secret: true });
  });

  it('unsets, renames, marks secret and removes by name', () => {
    const local = env('local', [row('a', '1'), row('b', '2'), blank()]);
    expect(keys(unsetMatrixValue(local, 'a'))).toEqual(['b', '']);
    expect(keys(renameMatrixKey(local, 'b', 'c'))).toEqual(['a', 'c', '']);
    expect(setMatrixSecret(local, 'a', true)[0].secret).toBe(true);
    expect(keys(removeMatrixKey(local, 'b'))).toEqual(['a', '']);
  });

  it('adds a new variable empty, once', () => {
    const local = env('local', [row('a', '1'), blank()]);
    const added = addMatrixKey(local, 'b');
    expect(keys(added)).toEqual(['a', 'b', '']);
    expect(addMatrixKey({ ...local, values: added }, 'b')).toBe(added);
  });

  it('keeps exactly one blank row at the end', () => {
    const local = env('local', [row('a', '1')]);
    expect(keys(setMatrixValue(local, 'b', '2'))).toEqual(['a', 'b', '']);
    expect(keys(unsetMatrixValue(env('x', [row('a', '1'), blank()]), 'a'))).toEqual(['']);
  });
});

describe('matrixKeyProblem', () => {
  it('refuses empty, spaced, braced and duplicate names', () => {
    expect(matrixKeyProblem([], '  ')).not.toBe('');
    expect(matrixKeyProblem([], 'base url')).not.toBe('');
    expect(matrixKeyProblem([], '{{baseUrl}}')).not.toBe('');
    expect(matrixKeyProblem(['baseUrl'], 'baseUrl')).not.toBe('');
    expect(matrixKeyProblem(['baseUrl'], 'baseUrl', 'baseUrl')).toBe('');
    expect(matrixKeyProblem(['baseUrl'], 'token')).toBe('');
  });
});
