import { describe, expect, it } from 'vitest';
import {
  LOAD_PRESETS,
  executorDurationMs,
  executorModel,
  executorPeak,
  executorTarget,
  formatDuration,
  parseDuration,
  presetExecutor,
  stagesToPolyline,
  switchExecutorModel,
} from '../lib/loadPresets';

describe('presetExecutor', () => {
  it('runs a short smoke test with two users', () => {
    expect(presetExecutor('smoke', 'vus')).toEqual({ type: 'constant-vus', vus: 2, durationMs: 60000 });
    expect(presetExecutor('smoke', 'rate')).toMatchObject({ type: 'constant-arrival-rate', rate: 2, durationMs: 60000 });
  });

  it('ramps up, holds and ramps down for a load test', () => {
    const executor = presetExecutor('load', 'vus', 100);
    expect(executor).toEqual({
      type: 'ramping-vus',
      stages: [{ durationMs: 120000, target: 100 }, { durationMs: 600000, target: 100 }, { durationMs: 60000, target: 0 }],
    });
    expect(executorPeak(executor)).toBe(100);
    expect(executorDurationMs(executor)).toBe(13 * 60000);
  });

  it('climbs to twice the target in a stress test and bursts tenfold in a spike', () => {
    expect(executorPeak(presetExecutor('stress', 'vus', 40))).toBe(80);
    expect(executorPeak(presetExecutor('spike', 'vus', 40))).toBe(400);
  });

  it('holds for hours in a soak test', () => {
    expect(executorDurationMs(presetExecutor('soak', 'vus', 10))).toBeGreaterThan(2 * 60 * 60000);
  });

  it('gives the rate model enough prepared users for its peak', () => {
    const executor = presetExecutor('load', 'rate', 200);
    expect(executor.type).toBe('ramping-arrival-rate');
    expect(executor.preAllocatedVUs).toBeGreaterThanOrEqual(200);
    expect(executor.maxVUs ?? 0).toBeGreaterThanOrEqual(executor.preAllocatedVUs ?? 0);
  });

  it('offers every preset in the picker', () => {
    expect(LOAD_PRESETS.map(preset => preset.id)).toEqual(['smoke', 'load', 'stress', 'spike', 'soak']);
  });
});

describe('executorTarget', () => {
  it('suggests a normal load instead of the two smoke users', () => {
    expect(executorTarget(presetExecutor('smoke', 'vus'))).toBe(50);
    expect(executorTarget({ type: 'constant-vus', vus: 30, durationMs: 60000 })).toBe(30);
    expect(executorTarget(presetExecutor('load', 'vus', 120))).toBe(120);
  });
});

describe('switchExecutorModel', () => {
  it('keeps the stages when moving between users and rate', () => {
    const vus = presetExecutor('load', 'vus', 30);
    const rate = switchExecutorModel(vus, 'rate');
    expect(executorModel(rate)).toBe('rate');
    expect(rate.stages).toEqual(vus.stages);
    expect(switchExecutorModel(rate, 'vus')).toEqual(vus);
  });

  it('carries a constant load across', () => {
    const rate = switchExecutorModel({ type: 'constant-vus', vus: 7, durationMs: 30000 }, 'rate');
    expect(rate).toMatchObject({ type: 'constant-arrival-rate', rate: 7, durationMs: 30000 });
  });

  it('does nothing when the model already matches', () => {
    const vus = presetExecutor('smoke', 'vus');
    expect(switchExecutorModel(vus, 'vus')).toBe(vus);
  });
});

describe('stagesToPolyline', () => {
  it('draws the stages across the given box', () => {
    expect(stagesToPolyline({ type: 'ramping-vus', stages: [{ durationMs: 1000, target: 10 }, { durationMs: 1000, target: 0 }] }, 100, 50))
      .toBe('0,50 50,0 100,50');
  });

  it('draws a flat line for a constant load', () => {
    expect(stagesToPolyline({ type: 'constant-vus', vus: 5, durationMs: 1000 }, 100, 50)).toBe('0,0 100,0');
  });

  it('copes with an empty executor', () => {
    expect(stagesToPolyline({ type: 'ramping-vus', stages: [] }, 100, 50)).toBe('0,50 100,50');
  });
});

describe('durations', () => {
  it('formats milliseconds the way people type them', () => {
    expect(formatDuration(60000)).toBe('1m');
    expect(formatDuration(90000)).toBe('1m30s');
    expect(formatDuration(2 * 60 * 60000 + 5 * 60000)).toBe('2h5m');
    expect(formatDuration(10000)).toBe('10s');
    expect(formatDuration(0)).toBe('0s');
  });

  it('parses what formatDuration writes and plain seconds', () => {
    for (const ms of [1000, 60000, 90000, 7500000]) expect(parseDuration(formatDuration(ms))).toBe(ms);
    expect(parseDuration('45')).toBe(45000);
    expect(parseDuration(' 1m 30s ')).toBe(90000);
    expect(parseDuration('250ms')).toBe(250);
  });

  it('refuses text that is not a duration', () => {
    for (const text of ['', 'soon', '1x', 'm5', '5m later']) expect(parseDuration(text)).toBeNull();
  });
});
