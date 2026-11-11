
const FATAL_MARKERS = [
  'effect_update_depth_exceeded',
  'Maximum update depth exceeded',
  'svelte.dev/e/effect_',
];

const IGNORED_MARKERS = [
  'ResizeObserver loop',
  '[vite]',
  'Failed to fetch dynamically imported module',
];

export const ERROR_STORM_THRESHOLD = 15;
export const ERROR_STORM_WINDOW_MS = 1000;

let overlayShown = false;
let recentErrors: number[] = [];

function getRuntime(): Record<string, undefined | (() => void)> | undefined {
  return (window as unknown as { runtime?: Record<string, undefined | (() => void)> }).runtime;
}

function reloadApp() {
  const rt = getRuntime();
  try {
    if (typeof rt?.WindowReload === 'function') { rt.WindowReload(); return; }
  } catch {  }
  window.location.reload();
}

function quitApp() {
  const rt = getRuntime();
  try {
    if (typeof rt?.Quit === 'function') { rt.Quit(); return; }
  } catch {  }
  try { window.close(); } catch {  }
}

function showFatalOverlay(detail: string) {
  if (overlayShown) return;
  overlayShown = true;

  const root = document.createElement('div');
  root.id = 'kurlo-fatal-overlay';
  root.setAttribute('role', 'alertdialog');
  root.setAttribute('aria-modal', 'true');
  Object.assign(root.style, {
    position: 'fixed', inset: '0', zIndex: '2147483647',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(15, 16, 22, 0.72)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    padding: '1.5rem',
  } as CSSStyleDeclaration);

  const card = document.createElement('div');
  Object.assign(card.style, {
    maxWidth: '27.5rem', width: '100%', boxSizing: 'border-box',
    background: '#1c1d24', color: '#e9eaf0',
    border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.75rem',
    padding: '1.5rem 1.5rem 1.25rem', boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
  } as CSSStyleDeclaration);

  const title = document.createElement('div');
  title.textContent = 'Kurlo stopped responding';
  Object.assign(title.style, { fontSize: '1.125rem', fontWeight: '600', marginBottom: '0.5rem' } as CSSStyleDeclaration);

  const body = document.createElement('div');
  body.textContent = 'A rendering error left the app in a broken state. Reload to recover your workspace, or quit the app.';
  Object.assign(body.style, { fontSize: '0.8125rem', lineHeight: '1.5', color: '#a9abbb', marginBottom: '1.125rem' } as CSSStyleDeclaration);

  const actions = document.createElement('div');
  Object.assign(actions.style, { display: 'flex', gap: '0.625rem', justifyContent: 'flex-end' } as CSSStyleDeclaration);

  const quitBtn = document.createElement('button');
  quitBtn.type = 'button';
  quitBtn.textContent = 'Quit';
  Object.assign(quitBtn.style, {
    appearance: 'none', cursor: 'pointer', fontSize: '0.8125rem', fontWeight: '500',
    padding: '0.5625rem 1rem', borderRadius: '0.5rem', color: '#e9eaf0',
    background: 'transparent', border: '1px solid rgba(255,255,255,0.16)',
  } as CSSStyleDeclaration);
  quitBtn.onclick = quitApp;

  const reloadBtn = document.createElement('button');
  reloadBtn.type = 'button';
  reloadBtn.textContent = 'Reload';
  Object.assign(reloadBtn.style, {
    appearance: 'none', cursor: 'pointer', fontSize: '0.8125rem', fontWeight: '500',
    padding: '0.5625rem 1.125rem', borderRadius: '0.5rem', color: '#fff',
    background: '#5865f2', border: '1px solid #5865f2',
  } as CSSStyleDeclaration);
  reloadBtn.onclick = reloadApp;

  const details = document.createElement('details');
  Object.assign(details.style, { marginTop: '1rem' } as CSSStyleDeclaration);
  const summary = document.createElement('summary');
  summary.textContent = 'Technical details';
  Object.assign(summary.style, { fontSize: '0.75rem', color: '#7f8194', cursor: 'pointer', userSelect: 'none' } as CSSStyleDeclaration);
  const pre = document.createElement('pre');
  pre.textContent = detail;
  Object.assign(pre.style, {
    marginTop: '0.625rem', maxHeight: '10rem', overflow: 'auto',
    fontSize: '0.6875rem', lineHeight: '1.5', color: '#9092a4',
    background: 'rgba(0,0,0,0.28)', borderRadius: '0.5rem', padding: '0.625rem',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  } as CSSStyleDeclaration);
  details.append(summary, pre);

  actions.append(quitBtn, reloadBtn);
  card.append(title, body, actions, details);
  root.append(card);

  const mount = () => {
    if (!document.body) return;
    document.body.appendChild(root);
    reloadBtn.focus();
  };
  if (document.body) mount();
  else window.addEventListener('DOMContentLoaded', mount, { once: true });
}

function shouldIgnore(message: string): boolean {
  return IGNORED_MARKERS.some(marker => message.includes(marker));
}

function isFatal(message: string): boolean {
  return FATAL_MARKERS.some(marker => message.includes(marker));
}

export type FatalVerdict = 'ignore' | 'fatal' | 'storm' | 'watch';

export function classifyFatalError(
  message: string,
  recent: readonly number[],
  now: number,
): { verdict: FatalVerdict; recent: number[] } {
  if (!message || shouldIgnore(message)) return { verdict: 'ignore', recent: [...recent] };
  if (isFatal(message)) return { verdict: 'fatal', recent: [...recent] };
  const within = [...recent, now].filter(ts => now - ts < ERROR_STORM_WINDOW_MS);
  return { verdict: within.length >= ERROR_STORM_THRESHOLD ? 'storm' : 'watch', recent: within };
}

export function stormOverlayMessage(message: string): string {
  return 'The application became unresponsive after repeated errors.\n\nLast error:\n' + message;
}

function handle(message: string) {
  const { verdict, recent } = classifyFatalError(message, recentErrors, Date.now());
  recentErrors = recent;
  if (verdict === 'fatal') showFatalOverlay(message);
  else if (verdict === 'storm') showFatalOverlay(stormOverlayMessage(message));
}

export function installFatalErrorGuard() {
  window.addEventListener('error', event => {
    const err = (event as ErrorEvent).error;
    const message = (err && (err.stack || err.message)) || (event as ErrorEvent).message || '';
    handle(String(message));
  });
  window.addEventListener('unhandledrejection', event => {
    const reason = (event as PromiseRejectionEvent).reason;
    const message = (reason && (reason.stack || reason.message)) || String(reason ?? '');
    handle(String(message));
  });
}
