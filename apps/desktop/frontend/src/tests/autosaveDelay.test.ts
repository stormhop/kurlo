import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/backend', () => ({
  cancelQuit: vi.fn(),
  confirmQuit: vi.fn(),
  loadRequestStore: vi.fn(),
  saveRequestStore: vi.fn(),
  saveRequestStoreDelta: vi.fn(async () => ({ ok: false, error: '', needFull: true })),
}));

import {
  AUTOSAVE_DELAY_STORAGE_KEY,
  DEFAULT_AUTOSAVE_DELAY_MS,
  loadAutosaveDelay,
  normalizeAutosaveDelay,
  saveAutosaveDelay,
} from '../lib/autosaveDelay';
import { requestPersistenceFeature } from '../lib/stores/features/requestPersistence';
import { preferencesFeature } from '../lib/stores/features/preferences';
import { environmentFeature } from '../lib/stores/features/environments';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('autosave delay setting', () => {
  it('clamps and rounds what the user types', () => {
    expect(normalizeAutosaveDelay(undefined)).toBe(DEFAULT_AUTOSAVE_DELAY_MS);
    expect(normalizeAutosaveDelay('abc')).toBe(DEFAULT_AUTOSAVE_DELAY_MS);
    expect(normalizeAutosaveDelay('')).toBe(DEFAULT_AUTOSAVE_DELAY_MS);
    expect(normalizeAutosaveDelay(10)).toBe(100);
    expect(normalizeAutosaveDelay(999999)).toBe(30000);
    expect(normalizeAutosaveDelay('2500.4')).toBe(2500);
  });

  it('survives a restart through localStorage', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    expect(loadAutosaveDelay()).toBe(DEFAULT_AUTOSAVE_DELAY_MS);
    saveAutosaveDelay(3000);
    expect(localStorage.getItem(AUTOSAVE_DELAY_STORAGE_KEY)).toBe('3000');

    const host = { autosave: false, autosaveDelayMs: DEFAULT_AUTOSAVE_DELAY_MS };
    preferencesFeature.loadAutosaveSettings.call(host as never);
    expect(host.autosaveDelayMs).toBe(3000);

    preferencesFeature.setAutosaveDelay.call(host as never, 50);
    expect(host.autosaveDelayMs).toBe(100);
    expect(localStorage.getItem(AUTOSAVE_DELAY_STORAGE_KEY)).toBe('100');
  });

  it('writes an edited request only after the configured delay', () => {
    vi.useFakeTimers();
    const persistActiveRequestNow = vi.fn();
    const host = {
      workspaceBlocked: false,
      requestStoreLoaded: true,
      applyingSavedRequest: false,
      activeRequestId: 'request-1',
      autosave: true,
      autosaveDelayMs: 3000,
      persistTimer: null,
      persistActiveRequestNow,
    };

    requestPersistenceFeature.scheduleActiveRequestPersist.call(host as never);
    vi.advanceTimersByTime(2999);
    expect(persistActiveRequestNow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(persistActiveRequestNow).toHaveBeenCalledTimes(1);

    host.autosaveDelayMs = 200;
    requestPersistenceFeature.scheduleActiveRequestPersist.call(host as never);
    vi.advanceTimersByTime(200);
    expect(persistActiveRequestNow).toHaveBeenCalledTimes(2);
  });

  it('uses the same delay for environment autosave', () => {
    vi.useFakeTimers();
    const persistRequestStore = vi.fn().mockResolvedValue(true);
    const host = {
      autosave: true,
      autosaveDelayMs: 2000,
      environmentPersistTimer: null,
      environmentSavedTimer: null,
      environmentBaselines: new Map(),
      guardWorkspaceWritable: () => true,
      persistRequestStore,
    };

    environmentFeature.scheduleEnvironmentPersist.call(host as never);
    vi.advanceTimersByTime(1999);
    expect(persistRequestStore).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(persistRequestStore).toHaveBeenCalled();
  });
});
