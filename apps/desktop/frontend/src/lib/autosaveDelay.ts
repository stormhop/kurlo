export const DEFAULT_AUTOSAVE_DELAY_MS = 1200;
export const MIN_AUTOSAVE_DELAY_MS = 100;
export const MAX_AUTOSAVE_DELAY_MS = 30000;
export const AUTOSAVE_DELAY_STORAGE_KEY = 'kurlo.autosaveDelay.v1';

export function normalizeAutosaveDelay(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_AUTOSAVE_DELAY_MS;
  return Math.min(MAX_AUTOSAVE_DELAY_MS, Math.max(MIN_AUTOSAVE_DELAY_MS, Math.round(parsed)));
}

export function loadAutosaveDelay(): number {
  try {
    return normalizeAutosaveDelay(localStorage.getItem(AUTOSAVE_DELAY_STORAGE_KEY));
  } catch {
    return DEFAULT_AUTOSAVE_DELAY_MS;
  }
}

export function saveAutosaveDelay(value: number) {
  try {
    localStorage.setItem(AUTOSAVE_DELAY_STORAGE_KEY, String(normalizeAutosaveDelay(value)));
  } catch {}
}
