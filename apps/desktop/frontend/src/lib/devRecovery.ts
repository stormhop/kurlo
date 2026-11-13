export const DEV_RELOAD_LIMIT = 5;
export const DEV_RELOAD_WINDOW_MS = 60_000;
export const DEV_BLANK_GRACE_MS = 1500;
export const DEV_HMR_ERROR_WINDOW_MS = 5000;
const STORAGE_KEY = 'kurlo.devRecovery.reloads';
const POLL_MS = 500;

const UNINITIALIZED = [
  'Cannot access uninitialized variable',
  'before initialization',
];

const HMR_BREAKAGE = [
  ...UNINITIALIZED,
  'is not defined',
  'is not a function',
  'Cannot read properties of undefined',
  'undefined is not an object',
];

export function isHmrBreakage(message: string): boolean {
  return HMR_BREAKAGE.some(marker => message.includes(marker));
}

export function shouldReloadAfterError(message: string, lastHmrUpdate: number, now: number): boolean {
  if (!lastHmrUpdate) return false;
  if (UNINITIALIZED.some(marker => message.includes(marker))) return true;
  return now - lastHmrUpdate <= DEV_HMR_ERROR_WINDOW_MS && isHmrBreakage(message);
}

export function allowReload(history: readonly number[], now: number): { allowed: boolean; history: number[] } {
  const recent = history.filter(ts => now - ts < DEV_RELOAD_WINDOW_MS);
  if (recent.length >= DEV_RELOAD_LIMIT) return { allowed: false, history: recent };
  return { allowed: true, history: [...recent, now] };
}

function readHistory(): number[] {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(value => typeof value === 'number') : [];
  } catch {
    return [];
  }
}

function writeHistory(history: number[]) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history)); } catch {  }
}

async function serverReady(): Promise<boolean> {
  try {
    const response = await fetch('/', { cache: 'no-store' });
    return response.ok;
  } catch {
    return false;
  }
}

export function installDevRecovery(target: HTMLElement) {
  let reloading = false;
  let blankSince = 0;
  let lastHmrUpdate = 0;
  let gaveUp = false;

  const reload = async (reason: string) => {
    if (reloading || gaveUp) return;
    reloading = true;
    while (!(await serverReady())) await new Promise(resolve => setTimeout(resolve, 1000));
    const { allowed, history } = allowReload(readHistory(), Date.now());
    writeHistory(history);
    if (!allowed) {
      gaveUp = true;
      reloading = false;
      console.warn(`[kurlo dev] ${reason}; auto-reload paused after ${DEV_RELOAD_LIMIT} reloads in a minute. Reload manually once the code settles.`);
      setTimeout(() => { gaveUp = false; }, DEV_RELOAD_WINDOW_MS);
      return;
    }
    console.warn(`[kurlo dev] ${reason}; reloading`);
    window.location.reload();
  };

  import.meta.hot?.on('vite:beforeUpdate', () => { lastHmrUpdate = Date.now(); });
  import.meta.hot?.on('vite:afterUpdate', () => { lastHmrUpdate = Date.now(); });

  const onError = (message: string) => {
    if (shouldReloadAfterError(message, lastHmrUpdate, Date.now())) void reload(`hot update broke the app: ${message.split('\n')[0]}`);
  };
  window.addEventListener('error', event => {
    const err = (event as ErrorEvent).error;
    onError(String((err && (err.stack || err.message)) || (event as ErrorEvent).message || ''));
  });
  window.addEventListener('unhandledrejection', event => {
    const reason = (event as PromiseRejectionEvent).reason;
    onError(String((reason && (reason.stack || reason.message)) || reason || ''));
  });

  setInterval(() => {
    if (target.childElementCount > 0) { blankSince = 0; return; }
    if (!blankSince) { blankSince = Date.now(); return; }
    if (Date.now() - blankSince >= DEV_BLANK_GRACE_MS) void reload('app root is empty');
  }, POLL_MS);
}
