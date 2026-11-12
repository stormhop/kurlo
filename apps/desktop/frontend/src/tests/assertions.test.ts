import { describe, expect, it } from 'vitest';
import {
  assertionLabel, assertionsForSend, assertionsForStore, assertionsToPostmanScript, assertionsWithoutUiIds,
  newAssertionRow, normalizeAssertions, requestTypeSupportsAssertions,
} from '../lib/assertions';
import { buildPostmanCollection, postmanRequestsFromItems } from '../lib/postman';
import { normalizeSavedRequest } from '../lib/normalizers';
import { requestDiffersFromSavedSnapshot } from '../lib/manualSave';

describe('assertions', () => {
  it('normalizes loaded rows and drops unknown operators to equals', () => {
    const rows = normalizeAssertions([
      { target: 'status', operator: 'eq', value: 201 },
      { target: 'body.id', operator: 'exists', enabled: false },
      { target: 'body.x', operator: 'roughly', value: 'y' },
      'junk',
    ]);
    expect(rows.map(({ id, ...row }) => row)).toEqual([
      { enabled: true, target: 'status', operator: 'eq', value: '201' },
      { enabled: false, target: 'body.id', operator: 'exists', value: '' },
      { enabled: true, target: 'body.x', operator: 'eq', value: 'y' },
    ]);
    expect(new Set(rows.map(row => row.id)).size).toBe(3);
    expect(normalizeAssertions('nope')).toEqual([]);
  });

  it('keeps only filled rows, clears values of value-less checks and sends enabled rows resolved', () => {
    const rows = [
      newAssertionRow({ target: 'status', operator: 'eq', value: '{{code}}' }),
      newAssertionRow({ target: ' ', operator: 'eq', value: '1' }),
      newAssertionRow({ target: 'body.id', operator: 'exists', value: 'stale' }),
      newAssertionRow({ target: 'size', operator: 'lt', value: '10', enabled: false }),
    ];
    expect(assertionsWithoutUiIds(rows)).toEqual([
      { enabled: true, target: 'status', operator: 'eq', value: '{{code}}' },
      { enabled: true, target: 'body.id', operator: 'exists', value: '' },
      { enabled: false, target: 'size', operator: 'lt', value: '10' },
    ]);
    expect(assertionsForSend(rows, value => value.replace('{{code}}', '201'))).toEqual([
      { enabled: true, target: 'status', operator: 'eq', value: '201' },
      { enabled: true, target: 'body.id', operator: 'exists', value: '' },
    ]);
    expect(assertionsForStore(undefined)).toEqual([]);
  });

  it('names a check the way the test results show it', () => {
    expect(assertionLabel({ target: 'status', operator: 'in', value: '200, 201' })).toBe('status is one of 200, 201');
    expect(assertionLabel({ target: 'body.id', operator: 'exists', value: '' })).toBe('body.id exists');
  });

  it('applies to HTTP and GraphQL requests only', () => {
    expect(['http', 'graphql', undefined].map(requestTypeSupportsAssertions)).toEqual([true, true, true]);
    expect(['ws', 'socketio', 'sse', 'grpc', 'mcp', 'ai'].map(requestTypeSupportsAssertions)).toEqual([false, false, false, false, false, false]);
  });

  it('loads assertions with a request and leaves them off other request types', () => {
    const http = normalizeSavedRequest({ id: 'r1', name: 'r1', method: 'GET', url: 'https://api.test', assertions: [{ target: 'status', operator: 'eq', value: '200' }] as never }, [], '');
    expect(http.assertions?.map(row => row.target)).toEqual(['status']);
    const socket = normalizeSavedRequest({ id: 'r2', name: 'r2', method: 'GET', url: 'wss://api.test', requestType: 'ws', assertions: [{ target: 'status', operator: 'eq', value: '200' }] as never }, [], '');
    expect(socket.assertions).toBeUndefined();
  });

  it('does not mark a request dirty when only the row ids differ', () => {
    const saved = normalizeSavedRequest({ id: 'r1', name: 'r1', method: 'GET', url: 'https://api.test', assertions: [{ target: 'status', operator: 'eq', value: '200' }] as never }, [], '');
    const reloaded = normalizeSavedRequest({ id: 'r1', name: 'r1', method: 'GET', url: 'https://api.test', assertions: [{ target: 'status', operator: 'eq', value: '200' }] as never }, [], '');
    expect(saved.assertions?.[0].id).not.toBe(reloaded.assertions?.[0].id);
    expect(requestDiffersFromSavedSnapshot(reloaded, saved)).toBe(false);
    const edited = { ...reloaded, assertions: [{ ...reloaded.assertions![0], value: '201' }] };
    expect(requestDiffersFromSavedSnapshot(edited, saved)).toBe(true);
  });

  it('writes Postman tests that check the same things', () => {
    const script = assertionsToPostmanScript([
      newAssertionRow({ target: 'status', operator: 'in', value: '200, 201' }),
      newAssertionRow({ target: 'header.X-Count', operator: 'eq', value: '5' }),
      newAssertionRow({ target: 'body.items[0]["sku-code"]', operator: 'exists' }),
      newAssertionRow({ target: 'body.tags[-1]', operator: 'eq', value: '"sale"' }),
      newAssertionRow({ target: 'responseTime', operator: 'lt', value: '1000' }),
      newAssertionRow({ target: 'cookies.sid', operator: 'exists' }),
      newAssertionRow({ target: 'status', operator: 'eq', value: '500', enabled: false }),
    ]);
    expect(script).toContain('pm.test("status is one of 200, 201", function () {');
    expect(script).toContain('pm.expect([200, 201]).to.deep.include(pm.response.code);');
    expect(script).toContain('pm.expect(pm.response.headers.get("X-Count")).to.eql("5");');
    expect(script).toContain('pm.expect(pm.response.json()["items"][0]["sku-code"]).to.not.be.undefined;');
    expect(script).toContain('pm.expect(pm.response.json()["tags"].at(-1)).to.eql("sale");');
    expect(script).toContain('pm.expect(Number(pm.response.responseTime)).to.be.below(1000);');
    expect(script).not.toContain('cookies');
    expect(script).not.toContain('500');
  });

  it('round-trips through a Postman export without doubling the checks', () => {
    const [req] = postmanRequestsFromItems([{
      name: 'Checked',
      request: { method: 'GET', url: 'https://api.example.test/orders' },
      event: [{ listen: 'test', script: { exec: ['pm.test("own", () => pm.expect(1).to.eql(1))'] } }],
    }], 'collection-1', 'API', undefined);
    req.testScript = 'pm.test("own", () => pm.expect(1).to.eql(1))';
    req.assertions = [newAssertionRow({ target: 'status', operator: 'eq', value: '200' })];

    const exported = buildPostmanCollection('API', '', [req], s => s, true) as { item: Array<Record<string, unknown> & { event?: Array<{ script: { exec: string[] } }> }> };
    const exec = exported.item[0].event?.[0].script.exec.join('\n') ?? '';
    expect(exec).toContain('pm.test("own"');
    expect(exec).toContain('pm.test("status equals 200"');

    const [again] = postmanRequestsFromItems(exported.item, 'collection-1', 'API', undefined);
    expect(again.assertions?.map(({ id, ...row }) => row)).toEqual([{ enabled: true, target: 'status', operator: 'eq', value: '200' }]);
    expect(again.testScript).toBe('pm.test("own", () => pm.expect(1).to.eql(1))');
  });
});
