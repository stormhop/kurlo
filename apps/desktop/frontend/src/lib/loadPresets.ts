import type { LoadExecutor, LoadStage } from './wire';

export type LoadPreset = 'smoke' | 'load' | 'stress' | 'spike' | 'soak';
export type LoadModel = 'vus' | 'rate';

export const LOAD_PRESETS: Array<{ id: LoadPreset; label: string; hint: string }> = [
  { id: 'smoke', label: 'Smoke', hint: '2 users · 1 min · does it work?' },
  { id: 'load', label: 'Load', hint: 'normal traffic · ramp, hold, down' },
  { id: 'stress', label: 'Stress', hint: 'steps up to 2× normal' },
  { id: 'spike', label: 'Spike', hint: 'sudden 10× burst' },
  { id: 'soak', label: 'Soak', hint: 'normal traffic for hours' },
];

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export const DEFAULT_LOAD_TARGET = 50;

function stagesFor(preset: Exclude<LoadPreset, 'smoke'>, target: number): LoadStage[] {
  const t = Math.max(1, Math.round(target));
  switch (preset) {
    case 'load':
      return [{ durationMs: 2 * MINUTE, target: t }, { durationMs: 10 * MINUTE, target: t }, { durationMs: MINUTE, target: 0 }];
    case 'stress':
      return [
        { durationMs: 3 * MINUTE, target: Math.max(1, Math.round(t / 2)) },
        { durationMs: 3 * MINUTE, target: t },
        { durationMs: 3 * MINUTE, target: Math.round(t * 1.5) },
        { durationMs: 3 * MINUTE, target: t * 2 },
        { durationMs: 2 * MINUTE, target: 0 },
      ];
    case 'spike':
      return [{ durationMs: 10 * SECOND, target: t * 10 }, { durationMs: MINUTE, target: t * 10 }, { durationMs: 10 * SECOND, target: 0 }];
    case 'soak':
      return [{ durationMs: 5 * MINUTE, target: t }, { durationMs: 2 * HOUR, target: t }, { durationMs: 5 * MINUTE, target: 0 }];
  }
}

export function presetExecutor(preset: LoadPreset, model: LoadModel, target = DEFAULT_LOAD_TARGET): LoadExecutor {
  if (preset === 'smoke') {
    return model === 'rate'
      ? { type: 'constant-arrival-rate', rate: 2, durationMs: MINUTE, preAllocatedVUs: 2, maxVUs: 10 }
      : { type: 'constant-vus', vus: 2, durationMs: MINUTE };
  }
  const stages = stagesFor(preset, target);
  if (model === 'vus') return { type: 'ramping-vus', stages };
  const peak = Math.max(...stages.map(stage => stage.target));
  return { type: 'ramping-arrival-rate', stages, preAllocatedVUs: Math.max(10, peak), maxVUs: Math.max(20, peak * 4) };
}

export function matchingLoadPreset(executor: LoadExecutor): LoadPreset | null {
  const peak = executorPeak(executor);
  const signature = (value: LoadExecutor) => JSON.stringify([
    value.type, value.vus ?? 0, value.rate ?? 0, value.durationMs ?? 0,
    value.timeUnitMs || SECOND, value.preAllocatedVUs ?? 0, value.maxVUs ?? 0,
    (value.stages ?? []).map(stage => [stage.durationMs, stage.target]),
  ]);
  for (const preset of LOAD_PRESETS) {
    const target = preset.id === 'stress' ? peak / 2 : preset.id === 'spike' ? peak / 10 : peak;
    if (signature(executor) === signature(presetExecutor(preset.id, executorModel(executor), target))) return preset.id;
  }
  return null;
}

export function executorModel(executor: LoadExecutor): LoadModel {
  return executor.type.endsWith('arrival-rate') ? 'rate' : 'vus';
}

export function executorTarget(executor: LoadExecutor): number {
  const peak = executorPeak(executor);
  if (executor.stages?.length) return peak > 0 ? peak : DEFAULT_LOAD_TARGET;
  return peak > 2 ? peak : DEFAULT_LOAD_TARGET;
}

export function switchExecutorModel(executor: LoadExecutor, model: LoadModel): LoadExecutor {
  if (executorModel(executor) === model) return executor;
  const ramping = executor.type.startsWith('ramping');
  if (model === 'rate') {
    const peak = executorPeak(executor) || DEFAULT_LOAD_TARGET;
    const pool = { preAllocatedVUs: Math.max(10, peak), maxVUs: Math.max(20, peak * 4) };
    return ramping
      ? { type: 'ramping-arrival-rate', stages: executor.stages ?? [], ...pool }
      : { type: 'constant-arrival-rate', rate: executor.vus || DEFAULT_LOAD_TARGET, durationMs: executor.durationMs || MINUTE, ...pool };
  }
  return ramping
    ? { type: 'ramping-vus', stages: executor.stages ?? [] }
    : { type: 'constant-vus', vus: executor.rate || DEFAULT_LOAD_TARGET, durationMs: executor.durationMs || MINUTE };
}

export function executorPeak(executor: LoadExecutor): number {
  if (executor.stages?.length) return Math.max(0, ...executor.stages.map(stage => stage.target));
  return executorModel(executor) === 'rate' ? executor.rate ?? 0 : executor.vus ?? 0;
}

export function executorDurationMs(executor: LoadExecutor): number {
  if (executor.stages?.length) return executor.stages.reduce((total, stage) => total + Math.max(0, stage.durationMs), 0);
  return executor.durationMs ?? 0;
}

export function executorPoints(executor: LoadExecutor): Array<{ ms: number; value: number }> {
  if (executor.stages?.length) {
    const points = [{ ms: 0, value: 0 }];
    let ms = 0;
    for (const stage of executor.stages) {
      ms += Math.max(0, stage.durationMs);
      points.push({ ms, value: Math.max(0, stage.target) });
    }
    return points;
  }
  const value = executorPeak(executor);
  const duration = executorDurationMs(executor);
  return [{ ms: 0, value }, { ms: duration, value }];
}

export function stagesToPolyline(executor: LoadExecutor, width: number, height: number): string {
  const points = executorPoints(executor);
  const duration = points[points.length - 1]?.ms ?? 0;
  const peak = Math.max(1, ...points.map(point => point.value));
  const x = (ms: number, index: number) => duration > 0 ? ms / duration * width : index / Math.max(1, points.length - 1) * width;
  return points
    .map((point, index) => `${round(x(point.ms, index))},${round(height - point.value / peak * height)}`)
    .join(' ');
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const parts: string[] = [];
  const rounded = Math.round(ms);
  let rest = Math.floor(rounded / SECOND);
  const milliseconds = rounded % SECOND;
  const hours = Math.floor(rest / 3600);
  rest -= hours * 3600;
  const minutes = Math.floor(rest / 60);
  const seconds = rest - minutes * 60;
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds) parts.push(`${seconds}s`);
  if (milliseconds) parts.push(`${milliseconds}ms`);
  if (!parts.length) return '0s';
  return parts.join('');
}

export function parseDuration(text: string): number | null {
  const clean = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!clean) return null;
  if (/^\d+(\.\d+)?$/.test(clean)) return Math.round(Number(clean) * SECOND);
  const pattern = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let consumed = 0;
  for (const match of clean.matchAll(pattern)) {
    if (match.index !== consumed) return null;
    consumed += match[0].length;
    const value = Number(match[1]);
    total += match[2] === 'h' ? value * HOUR : match[2] === 'm' ? value * MINUTE : match[2] === 's' ? value * SECOND : value;
  }
  if (consumed !== clean.length) return null;
  return Math.round(total);
}
