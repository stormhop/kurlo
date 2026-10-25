import { describe, expect, it } from 'vitest';
import { normalizeLoadTest, normalizeLoadTests } from '../lib/loadTests';
import { makeCollection, makeWorkspace, normalizeCollection } from '../lib/normalizers';
import { requestPersistenceFeature } from '../lib/stores/features/requestPersistence';
import type { Collection } from '../lib/types/models';
import type { LoadTest } from '../lib/wire';

const checkout: LoadTest = {
  id: 'lt-checkout',
  name: 'Checkout flow',
  filesystemName: 'Checkout-flow',
  scenarios: [{
    id: 'sc-main',
    name: 'Checkout',
    executor: { type: 'ramping-vus', stages: [{ durationMs: 120000, target: 100 }, { durationMs: 600000, target: 100 }, { durationMs: 60000, target: 0 }] },
    steps: [
      {
        id: 'st-login', requestId: 'req-login', once: true,
        extract: [{ var: 'token', from: 'json', path: '$.access_token' }],
        checks: [{ type: 'status', value: '200' }],
      },
      {
        id: 'st-create', requestId: 'req-create', name: 'create_order', thinkTimeMs: 500, thinkJitterMs: 1000,
        checks: [{ type: 'jsonExists', path: '$.id' }],
      },
    ],
  }],
  thresholds: [
    { metric: 'http_req_duration', stat: 'p(95)', op: '<', value: 300 },
    { metric: 'http_req_failed', stat: 'rate', op: '<', value: 0.01, abortOnFail: true, step: 'st-create' },
  ],
  data: { path: 'data/users.csv', mode: 'per-vu' },
  settings: { environment: 'staging', insecure: true, timeoutMs: 10000 },
};

describe('normalizeLoadTest', () => {
  it('keeps a complete load test exactly as it was saved', () => {
    expect(normalizeLoadTest(JSON.parse(JSON.stringify(checkout)))).toEqual(checkout);
  });

  it('is stable when run on its own output', () => {
    const once = normalizeLoadTest(JSON.parse(JSON.stringify(checkout)));
    expect(normalizeLoadTest(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it('leaves out empty optional fields so the YAML stays short', () => {
    const minimal = normalizeLoadTest({
      id: 'lt-1', name: 'Smoke',
      scenarios: [{ id: 'sc', name: 'Main', executor: { type: 'constant-vus', vus: 2, durationMs: 60000, rate: 0 }, steps: [{ id: 'st', requestId: 'req', once: false, extract: [], checks: [], thinkTimeMs: 0 }] }],
      thresholds: [],
      data: { path: '', mode: 'per-vu' },
      settings: { environment: '', insecure: false, timeoutMs: 0 },
    });
    expect(minimal).toEqual({
      id: 'lt-1', name: 'Smoke',
      scenarios: [{ id: 'sc', name: 'Main', executor: { type: 'constant-vus', vus: 2, durationMs: 60000 }, steps: [{ id: 'st', requestId: 'req' }] }],
      settings: {},
    });
  });

  it('reads hand-edited YAML the way it was meant', () => {
    const edited = normalizeLoadTest({
      id: 'lt-1', name: 404,
      scenarios: [{ id: 'sc', name: 'Main', executor: { type: 'constant-vus', vus: '20', durationMs: '60000' }, steps: [{ id: 'st', requestId: 'req', checks: [{ type: 'status', value: 201 }], thinkTimeMs: '250' }] }],
      thresholds: [{ metric: 'http_req_duration', stat: 'p(95)', op: '<', value: '300' }],
      settings: { timeoutMs: '1500' },
    });
    expect(edited.name).toBe('404');
    expect(edited.scenarios[0].executor).toEqual({ type: 'constant-vus', vus: 20, durationMs: 60000 });
    expect(edited.scenarios[0].steps[0]).toEqual({ id: 'st', requestId: 'req', checks: [{ type: 'status', value: '201' }], thinkTimeMs: 250 });
    expect(edited.thresholds?.[0].value).toBe(300);
    expect(edited.settings.timeoutMs).toBe(1500);
  });

  it('keeps steps without an id so validation can point at them instead of losing them', () => {
    const test = normalizeLoadTest({ id: 'lt-1', name: 'x', scenarios: [{ executor: { type: 'constant-vus' }, steps: [{ requestId: 'req' }] }], settings: {} });
    expect(test.scenarios[0].steps).toEqual([{ id: '', requestId: 'req' }]);
  });

  it('never crashes on wrong types', () => {
    const garbage: unknown[] = [42, 'text', { a: 1 }, [1, 'x', null], null, true];
    const shapes = [
      (value: unknown) => ({ ...checkout, scenarios: value }),
      (value: unknown) => ({ ...checkout, thresholds: value }),
      (value: unknown) => ({ ...checkout, data: value }),
      (value: unknown) => ({ ...checkout, settings: value }),
      (value: unknown) => ({ ...checkout, scenarios: [{ ...checkout.scenarios[0], executor: value }] }),
      (value: unknown) => ({ ...checkout, scenarios: [{ ...checkout.scenarios[0], steps: value }] }),
      (value: unknown) => ({ ...checkout, scenarios: [{ ...checkout.scenarios[0], steps: [{ ...checkout.scenarios[0].steps[0], extract: value, checks: value }] }] }),
    ];
    for (const shape of shapes) {
      for (const value of garbage) {
        const test = normalizeLoadTest(shape(value) as Record<string, unknown>);
        expect(Array.isArray(test.scenarios)).toBe(true);
        expect(typeof test.settings).toBe('object');
        for (const scenario of test.scenarios) {
          expect(typeof scenario.executor.type).toBe('string');
          expect(Array.isArray(scenario.steps)).toBe(true);
        }
      }
    }
  });
});

describe('normalizeLoadTests', () => {
  it('drops entries without an id or with a repeated id', () => {
    const tests = normalizeLoadTests([checkout, { ...checkout, name: 'Copy' }, { name: 'No id' }, 'junk', null]);
    expect(tests?.map(test => test.name)).toEqual(['Checkout flow']);
  });

  it('returns nothing for an empty or missing list', () => {
    expect(normalizeLoadTests(undefined)).toBeUndefined();
    expect(normalizeLoadTests([])).toBeUndefined();
    expect(normalizeLoadTests('junk')).toBeUndefined();
  });
});

describe('load tests on a collection', () => {
  const workspace = makeWorkspace('Main');

  it('survives normalizing the collection', () => {
    const collection = normalizeCollection({ ...makeCollection(workspace.id, 'Core'), loadTests: [checkout] }, workspace.id);
    expect(collection.loadTests).toEqual([checkout]);
  });

  it('does not add a loadTests field to a collection without load tests', () => {
    const collection = normalizeCollection(makeCollection(workspace.id, 'Core'), workspace.id);
    expect('loadTests' in collection).toBe(false);
  });

  it('is part of the store that gets saved to the workspace', () => {
    const collection: Collection = { ...makeCollection(workspace.id, 'Core'), loadTests: [checkout] };
    const host = {
      requests: [],
      activeRequestId: '',
      openRequestIds: [],
      workspaces: [workspace],
      collections: [collection],
      activeWorkspaceId: workspace.id,
      requestHistory: [],
      environments: [],
      activeEnvironmentId: '',
      workspaceCookies: {},
      cookies: [],
      folderCollapseState: {},
      globalVariables: [],
      collectionLastRuns: {},
      pruneHistory: () => [],
    };
    const store = requestPersistenceFeature.requestStorePayload.call(host as never);
    const saved = JSON.parse(JSON.stringify(store.collections)) as Collection[];
    expect(normalizeCollection(saved[0], workspace.id).loadTests).toEqual([checkout]);
  });
});
