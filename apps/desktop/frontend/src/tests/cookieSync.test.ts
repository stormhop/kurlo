import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cookieSyncFeature, normalizeSyncDomainInput, DEFAULT_COOKIE_SYNC_PORT, COOKIE_SYNC_REFRESH_DEBOUNCE_MS } from '../lib/stores/features/cookieSync';
import { EMPTY_COOKIE_SYNC_STATUS } from '../lib/wire';
import type { CookieSyncStatus } from '../lib/backend';

const backend = vi.hoisted(() => ({
  cookieSyncStatus: vi.fn(),
  startCookieSync: vi.fn(),
  stopCookieSync: vi.fn(),
  setCookieSyncDomains: vi.fn(),
  setCookieSyncWorkspace: vi.fn(),
  revokeCookieSyncPairing: vi.fn(),
  approveCookieSyncPairing: vi.fn(),
  denyCookieSyncPairing: vi.fn(),
}));

vi.mock('../lib/backend', () => backend);

function status(overrides: Partial<CookieSyncStatus> = {}): CookieSyncStatus {
  return { ...EMPTY_COOKIE_SYNC_STATUS, ...overrides };
}

function host(overrides: Record<string, unknown> = {}) {
  return {
    activeWorkspaceId: 'workspace-1',
    cookieSync: status(),
    cookieSyncBusy: false,
    cookieSyncError: '',
    cookieSyncDomainInput: '',
    cookieSyncPort: DEFAULT_COOKIE_SYNC_PORT,
    cookieSyncCodeCopied: false,
    cookieSyncRefreshTimer: null,
    activeRequestCookieDomain: () => 'api.example.com',
    refreshCookieJar: vi.fn(),
    ...cookieSyncFeature,
    ...overrides,
  } as any;
}

beforeEach(() => {
  for (const fn of Object.values(backend)) fn.mockReset();
  backend.setCookieSyncWorkspace.mockResolvedValue(status({ running: true }));
});

describe('cookie sync domain input', () => {
  it('reduces whatever the user pasted to a bare host', () => {
    expect(normalizeSyncDomainInput('https://API.Example.com/v1/orders?page=2')).toBe('api.example.com');
    expect(normalizeSyncDomainInput('.example.com')).toBe('example.com');
    expect(normalizeSyncDomainInput('*.staging.example.com')).toBe('staging.example.com');
    expect(normalizeSyncDomainInput('localhost:5173')).toBe('localhost');
  });

  it('rejects anything that is not a host', () => {
    expect(normalizeSyncDomainInput('   ')).toBe('');
    expect(normalizeSyncDomainInput('not a domain')).toBe('');
    expect(normalizeSyncDomainInput('intranet')).toBe('');
  });
});

describe('cookie sync bridge', () => {
  it('starts the bridge for the workspace that is open', async () => {
    const vm = host({ cookieSync: status({ domains: ['example.com'] }) });
    backend.startCookieSync.mockResolvedValue(status({ running: true, enabled: true, port: 3199, pairingCode: 'kurlo-3199-token' }));

    await vm.startCookieSyncBridge();

    expect(backend.startCookieSync).toHaveBeenCalledWith(
      { enabled: true, port: DEFAULT_COOKIE_SYNC_PORT, domains: ['example.com'] },
      'workspace-1',
    );
    expect(vm.cookieSync.pairingCode).toBe('kurlo-3199-token');
    expect(vm.cookieSyncBusy).toBe(false);
  });

  it('restarts a bridge that was left enabled last run', async () => {
    const vm = host({ cookieSync: status() });
    backend.cookieSyncStatus.mockResolvedValue(status({ enabled: true, running: false, port: 3199 }));
    backend.startCookieSync.mockResolvedValue(status({ enabled: true, running: true, port: 3199 }));

    await vm.loadCookieSyncStatus();

    expect(backend.startCookieSync).toHaveBeenCalled();
    expect(vm.cookieSync.running).toBe(true);
  });

  it('leaves a disabled bridge closed on startup', async () => {
    const vm = host();
    backend.cookieSyncStatus.mockResolvedValue(status({ enabled: false, running: false, domains: ['example.com'] }));

    await vm.loadCookieSyncStatus();

    expect(backend.startCookieSync).not.toHaveBeenCalled();
    expect(vm.cookieSyncDomains()).toEqual(['example.com']);
  });

  it('surfaces a port already in use instead of pretending it started', async () => {
    const vm = host();
    backend.startCookieSync.mockResolvedValue(status({ enabled: true, running: false, port: 3199, error: 'port 3199 is already in use — pick another one' }));

    await vm.startCookieSyncBridge();

    expect(vm.cookieSync.running).toBe(false);
    expect(vm.cookieSyncError).toContain('already in use');
  });

  it('adds a normalized domain and clears the input', async () => {
    const vm = host({ cookieSync: status({ domains: ['example.com'] }), cookieSyncDomainInput: 'https://Api.Example.com/orders' });
    backend.setCookieSyncDomains.mockResolvedValue(status({ domains: ['api.example.com', 'example.com'] }));

    await vm.addCookieSyncDomain();

    expect(backend.setCookieSyncDomains).toHaveBeenCalledWith(['example.com', 'api.example.com']);
    expect(vm.cookieSyncDomainInput).toBe('');
  });

  it('refuses junk instead of sending it to the allowlist', async () => {
    const vm = host({ cookieSyncDomainInput: 'nope' });

    await vm.addCookieSyncDomain();

    expect(backend.setCookieSyncDomains).not.toHaveBeenCalled();
    expect(vm.cookieSyncError).toContain('does not look like a domain');
  });

  it('removes a domain from the allowlist', async () => {
    const vm = host({ cookieSync: status({ domains: ['example.com', 'other.test'] }) });
    backend.setCookieSyncDomains.mockResolvedValue(status({ domains: ['other.test'] }));

    await vm.removeCookieSyncDomain('example.com');

    expect(backend.setCookieSyncDomains).toHaveBeenCalledWith(['other.test']);
    expect(vm.cookieSyncDomains()).toEqual(['other.test']);
  });

  it('knows whether the open request domain is covered by a listed parent', () => {
    const covered = host({ cookieSync: status({ domains: ['example.com'] }) });
    expect(covered.cookieSyncActiveDomainIsListed()).toBe(true);

    const uncovered = host({ cookieSync: status({ domains: ['other.test'] }) });
    expect(uncovered.cookieSyncActiveDomainIsListed()).toBe(false);
  });

  it('approves the browser Kurlo is asking about', async () => {
    const pending = { id: 'pair-1', browser: 'Chrome', extensionId: 'abc123', code: '482913', requestedAt: 1, expiresAt: 2 };
    const vm = host({ cookieSync: status({ running: true, pending }) });
    backend.approveCookieSyncPairing.mockResolvedValue(status({ running: true, paired: true, browser: 'Chrome' }));

    expect(vm.cookieSyncAwaitingApproval()).toBe(true);
    await vm.approveCookieSyncBrowser();

    expect(backend.approveCookieSyncPairing).toHaveBeenCalledWith('pair-1');
    expect(vm.cookieSync.paired).toBe(true);
    expect(vm.cookieSyncAwaitingApproval()).toBe(false);
  });

  it('denies the browser Kurlo is asking about', async () => {
    const pending = { id: 'pair-2', browser: 'Firefox', extensionId: 'zzz', code: '112233', requestedAt: 1, expiresAt: 2 };
    const vm = host({ cookieSync: status({ running: true, pending }) });
    backend.denyCookieSyncPairing.mockResolvedValue(status({ running: true }));

    await vm.denyCookieSyncBrowser();

    expect(backend.denyCookieSyncPairing).toHaveBeenCalledWith('pair-2');
    expect(vm.cookieSync.paired).toBe(false);
  });

  it('does nothing when there is no request to answer', async () => {
    const vm = host({ cookieSync: status({ running: true }) });

    await vm.approveCookieSyncBrowser();
    await vm.denyCookieSyncBrowser();

    expect(backend.approveCookieSyncPairing).not.toHaveBeenCalled();
    expect(backend.denyCookieSyncPairing).not.toHaveBeenCalled();
  });

  it('revokes a paired browser', async () => {
    const vm = host({ cookieSync: status({ running: true, paired: true, browser: 'Chrome', pairingCode: 'kurlo-3199-old' }) });
    backend.revokeCookieSyncPairing.mockResolvedValue(status({ running: true, paired: false, pairingCode: 'kurlo-3199-new' }));

    await vm.revokeCookieSyncBrowser();

    expect(backend.revokeCookieSyncPairing).toHaveBeenCalled();
    expect(vm.cookieSync.paired).toBe(false);
    expect(vm.cookieSync.pairingCode).toBe('kurlo-3199-new');
  });

  it('pulls the jar back into the UI when the browser pushes cookies', async () => {
    const handlers: Record<string, (payload: unknown) => void> = {};
    (globalThis as unknown as { window?: unknown }).window = {
      runtime: {
        EventsOn: (event: string, callback: (payload: unknown) => void) => {
          handlers[event] = callback;
          return () => {};
        },
      },
    };
    const vm = host();
    vm.initCookieSyncListeners();

    handlers['cookies:synced'](status({ running: true, paired: true, connected: true, browser: 'Chrome', lastSyncCount: 3 }));

    expect(vm.cookieSync.browser).toBe('Chrome');
    await new Promise(resolve => setTimeout(resolve, COOKIE_SYNC_REFRESH_DEBOUNCE_MS + 20));
    expect(vm.refreshCookieJar).toHaveBeenCalledWith(true, true);
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('refreshes and persists the workspace jar cleared by the agent', () => {
    const handlers: Record<string, (payload: unknown) => void> = {};
    vi.stubGlobal('window', { runtime: {
      EventsOn: (event: string, callback: (payload: unknown) => void) => {
        handlers[event] = callback;
      },
    } });
    try {
      const vm = host();
      vm.initCookieSyncListeners();
      handlers['cookies:jar-changed']('workspace-from-chat');
      expect(vm.refreshCookieJar).toHaveBeenCalledWith(true, true, 'workspace-from-chat');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads the jar once for a burst of pushes', async () => {
    vi.useFakeTimers();
    const handlers: Record<string, (payload: unknown) => void> = {};
    (globalThis as unknown as { window?: unknown }).window = {
      runtime: {
        EventsOn: (event: string, callback: (payload: unknown) => void) => {
          handlers[event] = callback;
          return () => {};
        },
      },
    };
    const vm = host();
    vm.initCookieSyncListeners();

    for (let index = 0; index < 12; index += 1) {
      handlers['cookies:synced'](status({ running: true, connected: true, browser: 'Chrome', lastSyncCount: index }));
    }
    expect(vm.refreshCookieJar).not.toHaveBeenCalled();

    vi.advanceTimersByTime(COOKIE_SYNC_REFRESH_DEBOUNCE_MS);
    expect(vm.refreshCookieJar).toHaveBeenCalledTimes(1);
    expect(vm.cookieSync.lastSyncCount).toBe(11);

    delete (globalThis as unknown as { window?: unknown }).window;
    vi.useRealTimers();
  });

  it('only warns about unreadable domains while a browser is connected', () => {
    const offline = host({ cookieSync: status({ running: true, paired: true, unreadable: ['shop.example.com'] }) });
    expect(offline.cookieSyncUnreadableDomains()).toEqual([]);

    const live = host({ cookieSync: status({ running: true, connected: true, unreadable: ['shop.example.com'] }) });
    expect(live.cookieSyncUnreadableDomains()).toEqual(['shop.example.com']);
  });

  it('points the bridge at the workspace the user switched to', async () => {
    const vm = host({ cookieSync: status({ running: true }), activeWorkspaceId: 'workspace-2' });

    await vm.pointCookieSyncAtActiveWorkspace();

    expect(backend.setCookieSyncWorkspace).toHaveBeenCalledWith('workspace-2');
  });

  it('does not touch a stopped bridge on a workspace switch', async () => {
    const vm = host({ cookieSync: status({ running: false }) });

    await vm.pointCookieSyncAtActiveWorkspace();

    expect(backend.setCookieSyncWorkspace).not.toHaveBeenCalled();
  });
});
