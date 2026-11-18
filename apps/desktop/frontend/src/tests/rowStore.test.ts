import { describe, expect, it } from 'vitest';
import { cloneRowsForStore, restoreRows } from '../lib/utils';
import { mkRow } from '../lib/constants';
import type { KVRow } from '../lib/types/models';

function kv(partial: Partial<KVRow>): KVRow {
  return { ...mkRow(), ...partial };
}

describe('cloneRowsForStore', () => {
  it('stores plain header/param rows without file or secret noise', () => {
    const [stored] = cloneRowsForStore([kv({ id: 1, key: 'X-Trace', value: 'abc', description: 'trace id' })]);

    expect(stored).toEqual({ id: 1, enabled: true, key: 'X-Trace', value: 'abc', description: 'trace id' });
    expect(Object.keys(stored)).toEqual(['id', 'enabled', 'key', 'value', 'description']);
  });

  it('drops explicitly-false isFile/fileName/secret so headers stay clean', () => {
    const [stored] = cloneRowsForStore([kv({ id: 2, key: 'k', value: 'v', isFile: false, fileName: '', secret: false })]);

    expect('isFile' in stored).toBe(false);
    expect('fileName' in stored).toBe(false);
    expect('secret' in stored).toBe(false);
  });

  it('preserves the secret flag for secret variable rows (secret masking depends on it)', () => {
    const [stored] = cloneRowsForStore([kv({ id: 3, key: 'token', value: 's3cr3t', secret: true })]);

    expect(stored.secret).toBe(true);
  });

  it('preserves isFile + fileName for form-data file rows', () => {
    const [stored] = cloneRowsForStore([kv({ id: 4, key: 'avatar', value: '', isFile: true, fileName: 'me.png' })]);

    expect(stored.isFile).toBe(true);
    expect(stored.fileName).toBe('me.png');
  });

  it('keeps isFile but no fileName key when no file picked yet', () => {
    const [stored] = cloneRowsForStore([kv({ id: 5, key: 'doc', value: '', isFile: true })]);

    expect(stored.isFile).toBe(true);
    expect('fileName' in stored).toBe(false);
  });

  it('filters out empty trailing rows', () => {
    expect(cloneRowsForStore([kv({ key: 'a', value: '1' }), mkRow()])).toHaveLength(1);
  });

  it('produces byte-identical JSON for logically equal rows (stable dirty-detection fingerprint)', () => {
    const lean = cloneRowsForStore([kv({ id: 9, key: 'A', value: '1' })]);
    const noisy = cloneRowsForStore([kv({ id: 9, key: 'A', value: '1', isFile: false, fileName: '', secret: false })]);

    expect(JSON.stringify(lean)).toBe(JSON.stringify(noisy));
  });

  it('is idempotent through the restore -> clone load cycle (ignoring volatile ids)', () => {
    const source = [
      kv({ key: 'X-Env', value: 'prod', description: 'env' }),
      kv({ key: 'token', value: 's3cr3t', secret: true }),
      kv({ key: 'file', value: '', isFile: true, fileName: 'a.bin' }),
    ];
    const strip = (rows: KVRow[]) => cloneRowsForStore(rows).map(({ id: _id, ...rest }) => rest);

    expect(strip(restoreRows(cloneRowsForStore(source)))).toEqual(strip(source));
  });
});

describe('restoreRows', () => {
  it('keeps the first stored secret ID and gives other rows distinct IDs', () => {
    const blank = mkRow();
    const secret = { ...blank, id: blank.id + 1, key: 'token', value: 'secret-ref', secret: true };
    const restored = restoreRows([
      { ...blank, key: 'host', value: 'local' },
      secret,
      { ...secret, key: 'secondToken' },
    ]);

    expect(cloneRowsForStore(restored)[1]).toMatchObject({ id: secret.id, key: secret.key, secret: true });
    expect(new Set(restored.map(row => row.id)).size).toBe(restored.length);
    expect(restored.map(row => row.id)).not.toContain(mkRow().id);
  });
});
