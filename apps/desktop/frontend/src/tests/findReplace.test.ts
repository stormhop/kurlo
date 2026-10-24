import { describe, expect, it } from 'vitest';
import { DEFAULT_REQUEST_SETTINGS, mkRow } from '../lib/constants';
import { expandReplacement, findFields, findInRequests, replaceMatches, type FindOptions } from '../lib/findReplace';
import { parseGraphQLPayload, serializeGraphQLPayload } from '../lib/graphql';
import type { SavedRequest } from '../lib/types/models';
import { emptyAuthState } from '../lib/utils';

const plain: FindOptions = { matchCase: false, wholeWord: false, regex: false };

function row(key: string, value: string, extra: Partial<ReturnType<typeof mkRow>> = {}) {
  return { ...mkRow(), enabled: true, key, value, ...extra };
}

function request(id: string, overrides: Partial<SavedRequest> = {}): SavedRequest {
  return {
    id,
    name: id,
    filesystemName: id,
    collectionId: 'c1',
    collection: 'API',
    folderPath: [],
    method: 'GET',
    url: 'https://staging.example.test/users',
    requestTab: 'params',
    params: [],
    headers: [],
    auth: emptyAuthState(),
    bodyType: 'none',
    rawBodyType: 'json',
    bodyContent: '',
    bodyFilePath: '',
    bodyFileName: '',
    formRows: [],
    preRequestScript: '',
    testScript: '',
    requestNotes: '',
    settings: { ...DEFAULT_REQUEST_SETTINGS },
    ...overrides,
  };
}

describe('find and replace', () => {
  it('finds matches across the URL, rows, body, scripts, docs and plain auth fields', () => {
    const req = request('r1', {
      params: [row('env', 'staging')],
      headers: [row('X-Env', 'staging'), row('Authorization', 'Bearer staging-token', { secret: true })],
      bodyType: 'json',
      bodyContent: '{\n  "host": "staging"\n}',
      testScriptJs: 'pm.expect(pm.environment.get("host")).to.eql("staging")',
      requestNotes: 'Runs against staging.',
      auth: { ...emptyAuthState(), type: 'oauth2', oauth2TokenURL: 'https://staging.example.test/token', oauth2Secret: 'staging-secret' },
    });
    const result = findInRequests([req], 'staging', plain);
    const fields = result.matches.map(match => match.fieldId);
    expect(fields).toEqual([
      'url', 'params.0.value', 'headers.0.value', 'bodyContent', 'testScriptJs', 'requestNotes', 'auth.oauth2TokenURL',
    ]);
    const body = result.matches.find(match => match.fieldId === 'bodyContent')!;
    expect(body).toMatchObject({ line: 2, before: '  "host": "', after: '"' });
  });

  it('numbers the lines of many matches in one long body', () => {
    const lines = Array.from({ length: 50_000 }, (_, index) => index % 25 === 0 ? `"host": "staging-${index}"` : `"line": ${index}`);
    const req = request('r1', { url: 'https://api.example.test', bodyType: 'json', bodyContent: `staging\n${lines.join('\n')}\nstaging staging` });
    const started = performance.now();
    const result = findInRequests([req], 'staging', plain);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.total).toBe(2003);
    expect(result.truncated).toBe(true);
    const body = result.matches.filter(match => match.fieldId === 'bodyContent');
    expect(body.slice(0, 3).map(match => match.line)).toEqual([1, 2, 27]);
    expect(body[1999].line).toBe(2 + 1998 * 25);
    const tail = findInRequests([req], 'staging', plain, 5000).matches.slice(-2).map(match => match.line);
    expect(tail).toEqual([50_002, 50_002]);
  });

  it('never searches secret values or secret auth fields', () => {
    const req = request('r1', {
      url: 'https://api.example.test',
      headers: [row('X-Token', 'abc123', { secret: true })],
      auth: { ...emptyAuthState(), type: 'bearer', bearerToken: 'abc123' },
    });
    expect(findInRequests([req], 'abc123', plain).total).toBe(0);
    expect(findFields(req).some(field => field.id === 'headers.0.key')).toBe(true);
  });

  it('honours match case, whole word and regular expressions', () => {
    const req = request('r1', { url: 'https://api.test/User/users/user_id' });
    expect(findInRequests([req], 'user', plain).total).toBe(3);
    expect(findInRequests([req], 'user', { ...plain, matchCase: true }).total).toBe(2);
    expect(findInRequests([req], 'user', { ...plain, wholeWord: true }).total).toBe(1);
    expect(findInRequests([req], 'u(se)r', { ...plain, regex: true }).total).toBe(3);
    expect(findInRequests([req], '(', { ...plain, regex: true }).error).not.toBe('');
    expect(findInRequests([req], '^', { ...plain, regex: true }).total).toBe(0);
  });

  it('replaces everything, keeping secrets and other requests untouched', () => {
    const one = request('r1', { headers: [row('X-Env', 'staging'), row('X-Key', 'staging', { secret: true })] });
    const two = request('r2', { url: 'https://prod.example.test' });
    const result = replaceMatches([one, two], 'staging', 'prod', plain);
    expect(result.replaced).toBe(2);
    expect(result.requests.map(req => req.id)).toEqual(['r1']);
    const [changed] = result.requests;
    expect(changed.url).toBe('https://prod.example.test/users');
    expect(changed.headers[0].value).toBe('prod');
    expect(changed.headers[1].value).toBe('staging');
    expect(one.url).toContain('staging');
  });

  it('replaces only the picked match and skips one that moved', () => {
    const req = request('r1', { url: 'https://a.test/a/a' });
    const found = findInRequests([req], 'a', { ...plain, matchCase: true });
    const second = found.matches[1];
    const result = replaceMatches([req], 'a', 'b', { ...plain, matchCase: true }, [second]);
    expect(result.requests[0].url).toBe('https://a.test/b/a');

    const moved = { ...second, start: second.start + 1, end: second.end + 1 };
    expect(replaceMatches([req], 'a', 'b', { ...plain, matchCase: true }, [moved]).replaced).toBe(0);
  });

  it('expands capture groups only in regex mode', () => {
    const req = request('r1', { url: 'https://api.test/v1/users' });
    const regex = replaceMatches([req], 'v(\\d)', 'v$1-beta', { ...plain, regex: true });
    expect(regex.requests[0].url).toBe('https://api.test/v1-beta/users');
    const literal = replaceMatches([req], 'v1', '$1', plain);
    expect(literal.requests[0].url).toBe('https://api.test/$1/users');
    const match = /(?<word>a)(b)/.exec('ab')!;
    expect(expandReplacement('$$ $& $2 $<word> $9', match)).toBe('$ ab b a $9');
  });

  it('edits GraphQL queries and variables without breaking the stored payload', () => {
    const bodyContent = serializeGraphQLPayload({ query: 'query { user(id: "1") { name } }', variables: '{\n  "id": "1"\n}', operationName: '' });
    const req = request('r1', { requestType: 'graphql', bodyType: 'graphql', bodyContent, url: 'https://api.test/graphql' });
    const found = findInRequests([req], '"1"', plain);
    expect(found.matches.map(match => match.fieldId)).toEqual(['graphql.query', 'graphql.variables']);
    const result = replaceMatches([req], '"1"', '"2"', plain);
    const payload = parseGraphQLPayload(result.requests[0].bodyContent);
    expect(payload.query).toBe('query { user(id: "2") { name } }');
    expect(JSON.parse(payload.variables)).toEqual({ id: '2' });
  });

  it('caps the preview list but counts every match', () => {
    const req = request('r1', { url: 'https://api.test', requestNotes: 'x'.repeat(30) });
    const result = findInRequests([req], 'x', plain, 10);
    expect(result.matches).toHaveLength(10);
    expect(result.total).toBe(30);
    expect(result.truncated).toBe(true);
  });
});

describe('find and replace in the store', async () => {
  const { findReplaceFeature } = await import('../lib/stores/features/findReplace');

  function host(autosave: boolean, dirty: string[] = []) {
    const persisted: SavedRequest[][] = [];
    const applied: string[] = [];
    const state = {
      activeRequestId: 'r1',
      autosave,
      collections: [],
      dirtyRequestIds: new Set(dirty),
      draftRequestIds: new Set<string>(),
      findReplaceScope: null as null | { collectionId: string; folderPath: string[] },
      findReplaceUndo: null as null | { before: SavedRequest[]; after: SavedRequest[]; replaced: number },
      requests: [request('r1'), request('r2', { folderPath: ['Admin'] }), request('r3', { collectionId: 'c2' })],
      applySavedRequest: (req: SavedRequest) => { applied.push(req.id); },
      closeFloatingMenus: () => {},
      flushPendingPersist: () => {},
      folderPathMatches: (path: string[] = [], prefix: string[] = []) => prefix.length > 0 && prefix.every((part, index) => path[index] === part),
      guardWorkspaceWritable: () => true,
      persistActiveRequestNow: async () => {},
      persistRequestStore: async () => { persisted.push(state.requests); return true; },
      findReplaceUnsavedIds(): Set<string> { return findReplaceFeature.findReplaceUnsavedIds.call(state); },
    };
    return { state, persisted, applied };
  }

  it('scopes to a collection or a folder', async () => {
    const { state } = host(true);
    await findReplaceFeature.openFindReplace.call(state as never, 'c1');
    expect(findReplaceFeature.findReplaceRequests.call(state as never).map(req => req.id)).toEqual(['r1', 'r2']);
    await findReplaceFeature.openFindReplace.call(state as never, 'c1', ['Admin']);
    expect(findReplaceFeature.findReplaceRequests.call(state as never).map(req => req.id)).toEqual(['r2']);
  });

  it('saves the replacement, reloads the open request and undoes it', async () => {
    const { state, persisted, applied } = host(true);
    const { requests } = replaceMatches(state.requests.slice(0, 2), 'staging', 'prod', plain);
    expect(await findReplaceFeature.applyFindReplace.call(state as never, requests, 2)).toBe(true);
    expect(state.requests.map(req => req.url)).toEqual([
      'https://prod.example.test/users', 'https://prod.example.test/users', 'https://staging.example.test/users',
    ]);
    expect(persisted).toHaveLength(1);
    expect(applied).toEqual(['r1']);
    expect(state.findReplaceUndo?.after).toHaveLength(2);

    expect(await findReplaceFeature.undoFindReplace.call(state as never)).toBe(true);
    expect(state.requests.every(req => req.url.includes('staging'))).toBe(true);
    expect(state.findReplaceUndo).toBeNull();
  });

  it('leaves requests with unsaved edits alone in manual-save mode', async () => {
    const { state } = host(false, ['r1']);
    const { requests } = replaceMatches(state.requests.slice(0, 2), 'staging', 'prod', plain);
    expect(await findReplaceFeature.applyFindReplace.call(state as never, requests, 2)).toBe(true);
    expect(state.requests[0].url).toContain('staging');
    expect(state.requests[1].url).toContain('prod');
  });

  it('does not undo over a request that changed again', async () => {
    const { state } = host(true);
    const { requests } = replaceMatches(state.requests.slice(0, 1), 'staging', 'prod', plain);
    await findReplaceFeature.applyFindReplace.call(state as never, requests, 1);
    state.requests = state.requests.map(req => req.id === 'r1' ? { ...req, url: 'https://edited.test' } : req);
    await findReplaceFeature.undoFindReplace.call(state as never);
    expect(state.requests[0].url).toBe('https://edited.test');
  });
});

describe('find and replace keeps the URL query and the Params rows in step', () => {
  it('searches the URL without its query and rewrites the query from the rows', () => {
    const req = request('r1', {
      url: 'https://staging.example.test/users?owner=staging-bot&page=2',
      params: [row('owner', 'staging-bot'), row('page', '2'), row('debug', 'staging', { enabled: false })],
    });
    const found = findInRequests([req], 'staging', plain);
    expect(found.matches.map(match => match.fieldId)).toEqual(['url', 'params.0.value', 'params.2.value']);

    const param = found.matches.find(match => match.fieldId === 'params.0.value')!;
    const one = replaceMatches([req], 'staging', 'prod', plain, [param]).requests[0];
    expect(one.url).toBe('https://staging.example.test/users?owner=prod-bot&page=2');
    expect(one.params[0].value).toBe('prod-bot');

    const all = replaceMatches([req], 'staging', 'prod', plain).requests[0];
    expect(all.url).toBe('https://prod.example.test/users?owner=prod-bot&page=2');
    expect(all.params[2].value).toBe('prod');
  });

  it('leaves path variable names to the URL', () => {
    const req = request('r1', { url: 'https://api.test/users/:userId', pathParams: [row('userId', 'user-1')] });
    expect(findInRequests([req], 'user', plain).matches.map(match => match.fieldId)).toEqual(['url', 'url', 'pathParams.0.value']);
  });
});
