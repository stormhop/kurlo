import { isRecord } from './utils';
import type {
  LoadCheck,
  LoadDataSource,
  LoadExecutor,
  LoadExtract,
  LoadScenario,
  LoadSettings,
  LoadStage,
  LoadStep,
  LoadTest,
  LoadThreshold,
} from './wire';

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function numeric(value: unknown): number {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function count(value: unknown): number {
  return Math.round(numeric(value));
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function withPositive<T extends object>(target: T, key: keyof T & string, value: unknown): T {
  const n = count(value);
  return n ? { ...target, [key]: n } : target;
}

function normalizeStage(raw: Record<string, unknown>): LoadStage {
  return { durationMs: count(raw.durationMs), target: count(raw.target) };
}

function normalizeExecutor(raw: unknown): LoadExecutor {
  const input = isRecord(raw) ? raw : {};
  let executor: LoadExecutor = { type: text(input.type) || 'constant-vus' };
  executor = withPositive(executor, 'vus', input.vus);
  executor = withPositive(executor, 'durationMs', input.durationMs);
  const stages = records(input.stages).map(normalizeStage);
  if (stages.length) executor = { ...executor, stages };
  executor = withPositive(executor, 'rate', input.rate);
  executor = withPositive(executor, 'timeUnitMs', input.timeUnitMs);
  executor = withPositive(executor, 'preAllocatedVUs', input.preAllocatedVUs);
  executor = withPositive(executor, 'maxVUs', input.maxVUs);
  return executor;
}

function normalizeExtract(raw: Record<string, unknown>): LoadExtract {
  return { var: text(raw.var), from: text(raw.from) || 'json', path: text(raw.path) };
}

function normalizeCheck(raw: Record<string, unknown>): LoadCheck {
  const check: LoadCheck = { type: text(raw.type) || 'status' };
  const path = text(raw.path);
  const value = text(raw.value);
  return { ...check, ...(path ? { path } : {}), ...(value ? { value } : {}) };
}

function normalizeStep(raw: Record<string, unknown>): LoadStep {
  let step: LoadStep = { id: text(raw.id), requestId: text(raw.requestId) };
  const name = text(raw.name);
  if (name) step = { ...step, name };
  if (raw.once === true) step = { ...step, once: true };
  const extract = records(raw.extract).map(normalizeExtract);
  if (extract.length) step = { ...step, extract };
  const checks = records(raw.checks).map(normalizeCheck);
  if (checks.length) step = { ...step, checks };
  step = withPositive(step, 'thinkTimeMs', raw.thinkTimeMs);
  step = withPositive(step, 'thinkJitterMs', raw.thinkJitterMs);
  return step;
}

function normalizeScenario(raw: Record<string, unknown>): LoadScenario {
  return {
    id: text(raw.id),
    name: text(raw.name),
    executor: normalizeExecutor(raw.executor),
    steps: records(raw.steps).map(normalizeStep),
  };
}

function normalizeThreshold(raw: Record<string, unknown>): LoadThreshold {
  const threshold: LoadThreshold = {
    metric: text(raw.metric),
    stat: text(raw.stat),
    op: text(raw.op) || '<',
    value: numeric(raw.value),
  };
  const step = text(raw.step);
  return { ...threshold, ...(step ? { step } : {}), ...(raw.abortOnFail === true ? { abortOnFail: true } : {}) };
}

function normalizeData(raw: unknown): LoadDataSource | undefined {
  if (!isRecord(raw)) return undefined;
  const path = text(raw.path);
  if (!path) return undefined;
  return { path, mode: text(raw.mode) || 'per-vu' };
}

function normalizeSettings(raw: unknown): LoadSettings {
  const input = isRecord(raw) ? raw : {};
  const environment = text(input.environment);
  let settings: LoadSettings = {};
  if (environment) settings = { ...settings, environment };
  if (input.insecure === true) settings = { ...settings, insecure: true };
  return withPositive(settings, 'timeoutMs', input.timeoutMs);
}

export function normalizeLoadTest(raw: Record<string, unknown>): LoadTest {
  const id = text(raw.id);
  const name = text(raw.name);
  const filesystemName = text(raw.filesystemName);
  const thresholds = records(raw.thresholds).map(normalizeThreshold);
  const data = normalizeData(raw.data);
  return {
    id,
    name,
    ...(filesystemName ? { filesystemName } : {}),
    scenarios: records(raw.scenarios).map(normalizeScenario),
    ...(thresholds.length ? { thresholds } : {}),
    ...(data ? { data } : {}),
    settings: normalizeSettings(raw.settings),
  };
}

export function normalizeLoadTests(raw: unknown): LoadTest[] | undefined {
  const seen = new Set<string>();
  const loadTests = records(raw).map(normalizeLoadTest).filter(loadTest => {
    if (!loadTest.id || seen.has(loadTest.id)) return false;
    seen.add(loadTest.id);
    return true;
  });
  return loadTests.length ? loadTests : undefined;
}
