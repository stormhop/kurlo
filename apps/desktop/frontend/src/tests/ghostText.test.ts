import { describe, expect, it } from 'vitest';
import { jsonKeyGhost, jsonKeySchema, urlGhost, urlGhostCandidates } from '../lib/ghostText';
import type { RequestHistoryEntry, SavedRequest } from '../lib/types/models';

function saved(id: string, url: string, extra: Partial<SavedRequest> = {}): SavedRequest {
  return { id, name: '', url, collectionId: 'col-1', requestType: 'http', ...extra } as SavedRequest;
}

function visited(url: string, createdAt: number, extra: Partial<SavedRequest> = {}): RequestHistoryEntry {
  return { id: `h-${createdAt}`, request: saved(`hr-${createdAt}`, url, extra), statusCode: 200, status: '200 OK', duration: 1, createdAt };
}

describe('urlGhostCandidates', () => {
  it('puts the newest history first, then saved requests, without duplicates', () => {
    const candidates = urlGhostCandidates(
      [saved('a', '{{base}}/users', { name: 'List users' }), saved('b', 'https://api.test/orders')],
      [visited('https://api.test/orders', 1), visited('https://api.test/users/7', 5)],
    );
    expect(candidates.map(candidate => candidate.url)).toEqual(['https://api.test/users/7', 'https://api.test/orders', '{{base}}/users']);
    expect(candidates[2].name).toBe('List users');
  });

  it('skips drafts, other workspaces, the open request and other protocols', () => {
    const candidates = urlGhostCandidates(
      [
        saved('draft', 'https://draft.test', { isDraft: true }),
        saved('other', 'https://other.test', { collectionId: 'col-2' }),
        saved('open', 'https://open.test'),
        saved('ws', 'wss://socket.test', { requestType: 'ws' }),
        saved('gql', 'https://graph.test', { requestType: 'graphql' }),
      ],
      [],
      { workspaceCollectionIds: new Set(['col-1']), requestType: 'http', excludeRequestId: 'open' },
    );
    expect(candidates.map(candidate => candidate.url)).toEqual(['https://graph.test']);
  });
});

describe('urlGhost', () => {
  const candidates = [
    { url: 'https://api.test/users/7', name: '' },
    { url: '{{base}}/users', name: 'List users' },
  ];

  it('completes the rest of a URL that starts with what was typed', () => {
    expect(urlGhost('https://api', candidates)).toEqual({ kind: 'suffix', text: '.test/users/7', value: 'https://api.test/users/7' });
    expect(urlGhost('{{ba', candidates)).toEqual({ kind: 'suffix', text: 'se}}/users', value: '{{base}}/users' });
  });

  it('keeps the casing that was typed', () => {
    expect(urlGhost('HTTPS://API', candidates)?.value).toBe('HTTPS://API.test/users/7');
  });

  it('offers the URL of a request whose name starts with what was typed', () => {
    expect(urlGhost('list', candidates)).toEqual({ kind: 'replace', text: ' users → {{base}}/users', value: '{{base}}/users' });
  });

  it('stays quiet for one character, a full match or no match', () => {
    expect(urlGhost('h', candidates)).toBeNull();
    expect(urlGhost('https://api.test/users/7', candidates)).toBeNull();
    expect(urlGhost('ftp://', candidates)).toBeNull();
    expect(urlGhost('', candidates)).toBeNull();
  });
});

describe('jsonKeySchema', () => {
  it('collects keys per object path from example bodies, arrays included', () => {
    const schema = jsonKeySchema([
      '{ "name": "Ada", "address": { "city": "Paris" }, "tags": [{ "id": 1 }] }',
      '// note\n{ "name": {{name}}, "email": "a@b.test" }',
      'not json',
    ]);
    expect(schema.get('$')).toEqual(['name', 'address', 'tags', 'email']);
    expect(schema.get('$.address')).toEqual(['city']);
    expect(schema.get('$.tags[]')).toEqual(['id']);
  });
});

describe('jsonKeyGhost', () => {
  const schema = jsonKeySchema(['{ "name": "Ada", "email": "a@b.test", "address": { "city": "Paris", "zip": "75001" } }']);
  const at = (doc: string) => {
    const pos = doc.indexOf('|');
    return jsonKeyGhost(doc.replace('|', ''), pos, schema);
  };

  it('completes a key typed inside quotes, with the closing quote the editor inserted', () => {
    expect(at('{\n  "na|"\n}')).toEqual({ text: 'me', from: 7, to: 8, insert: 'me": ' });
    expect(at('{\n  "em|')).toEqual({ text: 'ail', from: 7, to: 7, insert: 'ail": ' });
  });

  it('offers the next missing key after a comma', () => {
    expect(at('{\n  "name": "Ada",\n  |\n}')).toEqual({ text: '"email": ', from: 21, to: 21, insert: '"email": ' });
  });

  it('skips keys that are already in the object, before or after the cursor', () => {
    const doc = '{\n  "name": "Ada",\n  "|",\n  "email": "x"\n}';
    expect(at(doc)?.insert).toBe('address": ');
  });

  it('uses the keys of the nested object the cursor is in', () => {
    expect(at('{ "address": { "c|" } }')?.insert).toBe('ity": ');
    expect(at('{ "address": { "city": "Paris", | } }')?.insert).toBe('"zip": ');
  });

  it('stays quiet in values, strings that are not keys and unknown objects', () => {
    expect(at('{ "name": "A|" }')).toBeNull();
    expect(at('{ "name": | }')).toBeNull();
    expect(at('{ "other": { | } }')).toBeNull();
    expect(at('[ | ]')).toBeNull();
    expect(jsonKeyGhost('{ ', 2, new Map())).toBeNull();
  });

  it('does not suggest once every key is present', () => {
    expect(at('{ "address": { "city": "x", "zip": "y", | } }')).toBeNull();
  });
});
