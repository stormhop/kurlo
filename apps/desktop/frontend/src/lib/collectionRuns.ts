import type { CollectionRunnerResult, CollectionRunnerStatus } from './types/models';

export const LAST_RUN_RESULT_LIMIT = 500;

export type CollectionRunRecord = {
  collectionId: string;
  title: string;
  startedAt: number;
  finishedAt: number;
  results: CollectionRunnerResult[];
};

export type CollectionRunTally = { total: number; passed: number; failed: number; skipped: number };

const FINISHED_STATUSES: CollectionRunnerStatus[] = ['passed', 'failed', 'error', 'skipped'];
const STATUSES: CollectionRunnerStatus[] = ['queued', 'running', ...FINISHED_STATUSES];

export function collectionRunRecord(collectionId: string, title: string, startedAt: number, finishedAt: number, results: CollectionRunnerResult[]): CollectionRunRecord | null {
  if (!collectionId || !results.some(result => result.status !== 'skipped')) return null;
  return {
    collectionId,
    title,
    startedAt,
    finishedAt,
    results: results.slice(0, LAST_RUN_RESULT_LIMIT).map(result => ({
      ...result,
      status: FINISHED_STATUSES.includes(result.status) ? result.status : 'skipped',
      tests: result.tests?.map(test => ({ ...test })),
    })),
  };
}

export function tallyCollectionRun(record: CollectionRunRecord): CollectionRunTally {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const result of record.results) {
    if (result.status === 'passed') passed += 1;
    else if (result.status === 'failed' || result.status === 'error') failed += 1;
    else skipped += 1;
  }
  return { total: record.results.length, passed, failed, skipped };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizeResult(value: unknown): CollectionRunnerResult | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const status = STATUSES.includes(raw.status as CollectionRunnerStatus) ? raw.status as CollectionRunnerStatus : 'skipped';
  const tests = Array.isArray(raw.tests)
    ? raw.tests
      .filter((test): test is Record<string, unknown> => Boolean(test) && typeof test === 'object')
      .map(test => ({ name: stringOr(test.name), passed: test.passed === true, ...(typeof test.error === 'string' ? { error: test.error } : {}) }))
    : undefined;
  return {
    runId: stringOr(raw.runId),
    requestId: stringOr(raw.requestId),
    iteration: numberOr(raw.iteration, 1),
    name: stringOr(raw.name),
    method: stringOr(raw.method),
    url: stringOr(raw.url),
    status: FINISHED_STATUSES.includes(status) ? status : 'skipped',
    statusCode: numberOr(raw.statusCode, 0),
    duration: numberOr(raw.duration, 0),
    testsPassed: numberOr(raw.testsPassed, 0),
    testsTotal: numberOr(raw.testsTotal, 0),
    error: stringOr(raw.error),
    ...(tests ? { tests } : {}),
  };
}

export function normalizeCollectionRuns(value: unknown, collectionIds: Set<string>): Record<string, CollectionRunRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const runs: Record<string, CollectionRunRecord> = {};
  for (const [collectionId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!collectionIds.has(collectionId) || !raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const results = Array.isArray(record.results)
      ? record.results.map(normalizeResult).filter((result): result is CollectionRunnerResult => Boolean(result)).slice(0, LAST_RUN_RESULT_LIMIT)
      : [];
    if (!results.length) continue;
    runs[collectionId] = {
      collectionId,
      title: stringOr(record.title),
      startedAt: numberOr(record.startedAt, 0),
      finishedAt: numberOr(record.finishedAt, 0),
      results,
    };
  }
  return runs;
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: new Date(timestamp).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}
