export type UpdateMode = 'manual' | 'notify' | 'install';

export const UPDATE_MODE_KEY = 'kurlo:update-mode';

export function loadUpdateMode(): UpdateMode {
  try {
    const mode = localStorage.getItem(UPDATE_MODE_KEY);
    if (mode === 'manual' || mode === 'notify' || mode === 'install') return mode;
    return localStorage.getItem('kurlo:auto-update-install') === 'true' ? 'install' : 'notify';
  } catch {
    return 'notify';
  }
}
