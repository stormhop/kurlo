import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  k6Info: vi.fn(),
  startLoadRun: vi.fn(),
  stopLoadRun: vi.fn(),
  loadTestTargets: vi.fn(),
  lastLoadRun: vi.fn(),
  loadRunSummaryJSON: vi.fn(),
  openLoadRunReport: vi.fn(),
  openFileDialog: vi.fn(),
  loadRunStatus: vi.fn(),
  loadRunLog: vi.fn(),
}));

vi.mock('../lib/backend', async (importOriginal) => ({ ...(await importOriginal<object>()), ...backend }));

import { emptyLoadRunState } from '../lib/backend';
import { isLoopbackHost, loadRunFeature } from '../lib/stores/features/loadRuns';
import type { Collection, Environment } from '../lib/types/models';
import type { LoadRunResult, LoadRunState, LoadTest } from '../lib/wire';

const test: LoadTest = { id: 'lt-1', name: 'Smoke', scenarios: [], settings: {} };
const collection = { id: 'col', workspaceId: 'ws', name: 'Shop' } as Collection;

function makeHost(environment?: Partial<Environment>) {
  return {
    ...loadRunFeature,
    activeLoadTestId: 'lt-1',
    collections: [collection],
    k6Path: '',
    k6Info: null,
    k6MissingOpen: false,
    loadRun: emptyLoadRunState(),
    loadRunLogLines: ['old line'],
    loadRunLogTestId: 'other',
    loadRunResults: {} as Record<string, LoadRunResult>,
    loadTestTab: 'flow' as 'flow' | 'load' | 'data' | 'results',
    guardWorkspaceWritable: () => true,
    openAlertDialog: vi.fn().mockResolvedValue(undefined),
    openConfirmDialog: vi.fn().mockResolvedValue(true),
    openPromptDialog: vi.fn().mockResolvedValue(null),
    saveTextFile: vi.fn().mockResolvedValue(true),
    loadTestEnvironment: () => (environment ? { id: 'env', workspaceId: 'ws', name: 'prod', filesystemName: 'prod', values: [], ...environment } : undefined),
    loadTestPayload: vi.fn().mockReturnValue('{"payload":true}'),
  };
}

const running: LoadRunState = { ...emptyLoadRunState(), running: true, loadTestId: 'lt-1', plannedMs: 60000 };

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('window', {});
  for (const fn of Object.values(backend)) fn.mockReset();
  backend.k6Info.mockResolvedValue({ found: true, path: '/usr/bin/k6', version: 'v1.3.0' });
  backend.loadTestTargets.mockResolvedValue(['localhost']);
  backend.startLoadRun.mockResolvedValue(running);
  backend.loadRunStatus.mockResolvedValue(emptyLoadRunState());
  backend.loadRunLog.mockResolvedValue([]);
});

describe('isLoopbackHost', () => {
  it('knows the addresses of this computer', () => {
    for (const host of ['localhost', 'api.localhost', '127.0.0.1', '127.10.0.3', '::1', '[::1]']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['staging.shop.test', '10.0.0.5', '128.0.0.1', 'localhost.evil.test']) expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('running a load test', () => {
  it('starts k6 against this computer without asking and shows the results tab', async () => {
    const host = makeHost();
    await host.runLoadTest('col', test);
    expect(backend.startLoadRun).toHaveBeenCalledWith('{"payload":true}', '');
    expect(host.openConfirmDialog).not.toHaveBeenCalled();
    expect(host.loadRun).toEqual(running);
    expect(host.loadTestTab).toBe('results');
    expect(host.loadRunLogLines).toEqual([]);
    expect(host.loadRunLogTestId).toBe('lt-1');
  });

  it('opens the install dialog when k6 is missing', async () => {
    backend.k6Info.mockResolvedValue({ found: false, path: '', version: '', error: 'k6 is not installed' });
    const host = makeHost();
    await host.runLoadTest('col', test);
    expect(host.k6MissingOpen).toBe(true);
    expect(backend.startLoadRun).not.toHaveBeenCalled();
  });

  it('asks before sending load to another machine, and stops when declined', async () => {
    backend.loadTestTargets.mockResolvedValue(['127.0.0.1', 'staging.shop.test']);
    const host = makeHost();
    host.openConfirmDialog.mockResolvedValueOnce(false);
    await host.runLoadTest('col', test);
    expect(host.openConfirmDialog.mock.calls[0][1]).toContain('staging.shop.test');
    expect(host.openConfirmDialog.mock.calls[0][1]).not.toContain('127.0.0.1');
    expect(backend.startLoadRun).not.toHaveBeenCalled();
  });

  it('wants the host typed for a protected environment', async () => {
    backend.loadTestTargets.mockResolvedValue(['api.shop.test']);
    const host = makeHost({ protected: true });
    host.openPromptDialog.mockResolvedValueOnce('api.shop');
    await host.runLoadTest('col', test);
    expect(backend.startLoadRun).not.toHaveBeenCalled();
    host.openPromptDialog.mockResolvedValueOnce(' API.shop.test ');
    await host.runLoadTest('col', test);
    expect(backend.startLoadRun).toHaveBeenCalledTimes(1);
    expect(host.openConfirmDialog).not.toHaveBeenCalled();
  });

  it('explains why k6 did not start', async () => {
    backend.startLoadRun.mockResolvedValue({ ...emptyLoadRunState(), error: 'Fix the problems in the load test before running it: Step 1 has no request.' });
    const host = makeHost();
    await host.runLoadTest('col', test);
    expect(host.openAlertDialog).toHaveBeenCalledWith('Load test did not start', expect.stringContaining('Step 1 has no request'));
    expect(host.loadRun.running).toBe(false);
  });

  it('refuses a second run while one is going', async () => {
    const host = makeHost();
    host.loadRun = running;
    await host.runLoadTest('col', test);
    expect(backend.startLoadRun).not.toHaveBeenCalled();
    expect(host.openAlertDialog).toHaveBeenCalled();
  });

  it('marks the run as stopping when stopped', async () => {
    backend.stopLoadRun.mockResolvedValue(running);
    const host = makeHost();
    host.loadRun = running;
    await host.stopLoadTest();
    expect(host.loadRun.stopping).toBe(true);
  });
});

describe('load run results', () => {
  it('loads the last run once per test', async () => {
    const result = { loadTestId: 'lt-1', status: 'passed' } as LoadRunResult;
    backend.lastLoadRun.mockResolvedValue(result);
    const host = makeHost();
    await host.loadLastLoadRun('lt-1');
    await host.loadLastLoadRun('lt-1');
    expect(host.loadRunResults['lt-1']).toBe(result);
    expect(backend.lastLoadRun).toHaveBeenCalledTimes(1);
  });

  it('saves the k6 summary to a file', async () => {
    backend.loadRunSummaryJSON.mockResolvedValue('{"metrics":{}}');
    const host = makeHost();
    await host.saveLoadTestSummary('lt-1', 'smoke-summary.json');
    expect(host.saveTextFile).toHaveBeenCalledWith('smoke-summary.json', '{"metrics":{}}');
  });

  it('remembers a chosen k6 program', async () => {
    backend.openFileDialog.mockResolvedValue('/opt/k6/k6');
    const host = makeHost();
    await host.chooseK6Binary();
    expect(host.k6Path).toBe('/opt/k6/k6');
    expect(localStorage.getItem('kurlo.k6Path.v1')).toBe('/opt/k6/k6');
    expect(backend.k6Info).toHaveBeenCalledWith('/opt/k6/k6');
  });

  it('follows the run through events', async () => {
    const handlers: Record<string, (payload: unknown) => void> = {};
    vi.stubGlobal('window', { runtime: { EventsOn: (name: string, callback: (payload: unknown) => void) => { handlers[name] = callback; return () => {}; } } });
    const host = makeHost();
    host.initLoadRunListeners();
    handlers['load:progress'](running);
    expect(host.loadRunLogLines).toEqual([]);
    handlers['load:log']('running (01.0s), 2/2 VUs, 8 complete and 0 interrupted iterations');
    handlers['load:done']({ loadTestId: 'lt-1', status: 'failed' });
    expect(host.loadRun.running).toBe(true);
    expect(host.loadRunLogLines).toHaveLength(1);
    expect(host.loadRunResults['lt-1'].status).toBe('failed');
  });
});
