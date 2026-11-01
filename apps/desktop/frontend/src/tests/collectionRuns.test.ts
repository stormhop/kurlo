import { describe, expect, it } from 'vitest';
import { collectionRunRecord, LAST_RUN_RESULT_LIMIT, normalizeCollectionRuns, relativeTime, tallyCollectionRun } from '../lib/collectionRuns';
import type { CollectionRunnerResult } from '../lib/types/models';
import { collectionRunnerFeature } from '../lib/stores/features/collectionRunner';

function result(over: Partial<CollectionRunnerResult> = {}): CollectionRunnerResult {
  return {
    runId: 'r1:1:0',
    requestId: 'r1',
    iteration: 1,
    name: 'List users',
    method: 'GET',
    url: '{{base}}/users',
    status: 'passed',
    statusCode: 200,
    duration: 42,
    testsPassed: 2,
    testsTotal: 2,
    error: '',
    tests: [{ name: 'status is 200', passed: true }],
    ...over,
  };
}

describe('collectionRunRecord', () => {
  it('keeps a finished run for its collection', () => {
    const record = collectionRunRecord('col-1', 'Users API', 1_000, 2_500, [result(), result({ runId: 'r2', status: 'failed' })]);
    expect(record).toMatchObject({ collectionId: 'col-1', title: 'Users API', startedAt: 1_000, finishedAt: 2_500 });
    expect(record?.results).toHaveLength(2);
  });

  it('does not keep a run where nothing was sent', () => {
    expect(collectionRunRecord('col-1', 'Users API', 1, 2, [result({ status: 'skipped' })])).toBeNull();
    expect(collectionRunRecord('', 'Users API', 1, 2, [result()])).toBeNull();
  });

  it('stores requests that never finished as skipped', () => {
    const record = collectionRunRecord('col-1', 'Users API', 1, 2, [result(), result({ runId: 'r2', status: 'running' }), result({ runId: 'r3', status: 'queued' })]);
    expect(record?.results.map(entry => entry.status)).toEqual(['passed', 'skipped', 'skipped']);
  });

  it('caps the stored results', () => {
    const many = Array.from({ length: LAST_RUN_RESULT_LIMIT + 20 }, (_, index) => result({ runId: `r${index}` }));
    expect(collectionRunRecord('col-1', 'Users API', 1, 2, many)?.results).toHaveLength(LAST_RUN_RESULT_LIMIT);
  });
});

describe('tallyCollectionRun', () => {
  it('counts errors as failures', () => {
    const record = collectionRunRecord('col-1', 'Users API', 1, 2, [
      result(),
      result({ runId: 'r2', status: 'failed' }),
      result({ runId: 'r3', status: 'error' }),
      result({ runId: 'r4', status: 'skipped' }),
    ])!;
    expect(tallyCollectionRun(record)).toEqual({ total: 4, passed: 1, failed: 2, skipped: 1 });
  });
});

describe('normalizeCollectionRuns', () => {
  const ids = new Set(['col-1']);

  it('reads back what was stored', () => {
    const record = collectionRunRecord('col-1', 'Users API', 1, 2, [result()])!;
    expect(normalizeCollectionRuns(JSON.parse(JSON.stringify({ 'col-1': record })), ids)).toEqual({ 'col-1': record });
  });

  it('keeps failures and test totals beyond the stored detail limit after reopening a run', () => {
    const results = Array.from({ length: LAST_RUN_RESULT_LIMIT + 1 }, (_, index) => result({
      runId: `r${index}`,
      status: index === LAST_RUN_RESULT_LIMIT ? 'failed' : 'passed',
      testsPassed: index === LAST_RUN_RESULT_LIMIT ? 1 : 2,
    }));
    const record = collectionRunRecord('col-1', 'Users API', 1_000, 2_500, results)!;
    const runs = normalizeCollectionRuns(JSON.parse(JSON.stringify({ 'col-1': record })), ids);
    expect(runs['col-1'].results).toHaveLength(LAST_RUN_RESULT_LIMIT);
    expect(runs['col-1'].results.at(-1)?.status).toBe('failed');
    expect(tallyCollectionRun(runs['col-1'])).toEqual({ total: 501, passed: 500, failed: 1, skipped: 0 });
    const host = {
      collectionLastRuns: runs,
      collectionRunnerCollectionId: 'col-1',
      collectionRunnerRunning: false,
      collectionRunnerShowingLastRun: false,
      collectionRunnerResults: [] as CollectionRunnerResult[],
    };
    collectionRunnerFeature.showCollectionLastRun.call(host as never, 'col-1');
    expect(collectionRunnerFeature.buildCollectionRunnerSummary.call(host as never)).toEqual({
      total: 501, completed: 501, passed: 500, failed: 1, skipped: 0,
      testsPassed: 1001, testsTotal: 1002, duration: 1500, allPassed: false,
    });
  });

  it('counts every result before limiting details when a stored summary is missing or damaged', () => {
    const results = Array.from({ length: LAST_RUN_RESULT_LIMIT + 1 }, (_, index) => result({
      runId: `r${index}`, status: index === LAST_RUN_RESULT_LIMIT ? 'error' : 'passed',
    }));
    for (const summary of [undefined, { total: -1 }, { total: 501, passed: 501, failed: 0, skipped: 0, testsPassed: 1002, testsTotal: 1002 }]) {
      const runs = normalizeCollectionRuns({ 'col-1': { results, summary } }, ids);
      expect(tallyCollectionRun(runs['col-1'])).toMatchObject({ total: 501, failed: 1, passed: 500 });
      expect(runs['col-1'].results).toHaveLength(LAST_RUN_RESULT_LIMIT);
    }
  });

  it('drops runs of collections that no longer exist', () => {
    const record = collectionRunRecord('col-2', 'Gone', 1, 2, [result()])!;
    expect(normalizeCollectionRuns({ 'col-2': record }, ids)).toEqual({});
  });

  it('survives a damaged store', () => {
    expect(normalizeCollectionRuns(null, ids)).toEqual({});
    expect(normalizeCollectionRuns([], ids)).toEqual({});
    expect(normalizeCollectionRuns({ 'col-1': 'nope' }, ids)).toEqual({});
    expect(normalizeCollectionRuns({ 'col-1': { results: [null, { status: 'weird', statusCode: 'x' }] } }, ids)['col-1'].results).toEqual([
      expect.objectContaining({ status: 'skipped', statusCode: 0, name: '' }),
    ]);
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-09-30T12:00:00Z').getTime();

  it('reads like a person would say it', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 60 * 60_000, now)).toBe('1 hour ago');
    expect(relativeTime(now - 3 * 60 * 60_000, now)).toBe('3 hours ago');
    expect(relativeTime(now - 24 * 60 * 60_000, now)).toBe('yesterday');
    expect(relativeTime(now - 3 * 24 * 60 * 60_000, now)).toBe('3 days ago');
  });

  it('falls back to a date after a week', () => {
    expect(relativeTime(now - 10 * 24 * 60 * 60_000, now)).not.toContain('ago');
  });
});
