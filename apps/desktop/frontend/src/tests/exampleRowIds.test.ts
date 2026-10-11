import { describe, expect, it } from 'vitest';
import { normalizeRequestExample } from '../lib/examples';
import { mkRow } from '../lib/constants';
import type { KVRow } from '../lib/types/models';

describe('example row IDs across workspace reloads', () => {
  it('preserves snapshot and response row IDs on repeated loads', () => {
    const row = (id: number, key: string): KVRow => ({ ...mkRow(), id, key, value: 'value' });
    const original = normalizeRequestExample({
      id: 'example-1',
      createdAt: 1,
      snapshot: {
        method: 'GET', url: '/test', bodyType: 'none', bodyContent: '',
        params: [row(0, 'page')], headers: [row(158, 'Accept')],
      },
      response: {
        statusCode: 403, status: 'Forbidden', body: 'forbidden', bodyMediaType: 'text/plain',
        headers: [row(162, 'Content-Length'), row(163, 'Content-Type')],
      },
    }, 'request-1');
    expect(original.snapshot.params[0].id).toBe(0);
    expect(original.snapshot.headers[0].id).toBe(158);
    expect(original.response.headers.map(row => row.id)).toEqual([162, 163]);
    const serialized = JSON.stringify(original);
    for (let reload = 0; reload < 3; reload++) {
      for (let i = 0; i < 148; i++) mkRow();
      expect(JSON.stringify(normalizeRequestExample(JSON.parse(serialized), 'request-1'))).toBe(serialized);
    }
  });

  it('assigns a stable ID to imported rows without one and removes empty rows', () => {
    const row = { key: 'Content-Type', value: 'text/plain' } as KVRow;
    const first = normalizeRequestExample({
      response: { statusCode: 200, status: 'OK', body: '', bodyMediaType: 'text/plain', headers: [row, mkRow()] },
    }, 'request-1');
    expect(first.response.headers).toHaveLength(1);
    expect(Number.isFinite(first.response.headers[0].id)).toBe(true);
    const next = normalizeRequestExample(JSON.parse(JSON.stringify(first)), 'request-1');
    expect(next).toEqual(first);
  });
});
