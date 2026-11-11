import {
  cookieSyncStatus as fetchCookieSyncStatus, startCookieSync, stopCookieSync,
  setCookieSyncDomains, setCookieSyncWorkspace, revokeCookieSyncPairing,
  approveCookieSyncPairing, denyCookieSyncPairing,
} from '../../backend';
import type { CookieSyncStatus } from '../../backend';
import { EMPTY_COOKIE_SYNC_STATUS } from '../../wire';
import { clipboardCopy } from '../../utils';
import { listenRuntime } from '../../runtimeEvents';

export const DEFAULT_COOKIE_SYNC_PORT = 3199;
export const COOKIE_SYNC_REFRESH_DEBOUNCE_MS = 250;

type CookieSyncHost = {
  activeWorkspaceId: string;
  cookieSync: CookieSyncStatus;
  cookieSyncBusy: boolean;
  cookieSyncError: string;
  cookieSyncDomainInput: string;
  cookieSyncPort: number;
  cookieSyncCodeCopied: boolean;
  cookieSyncRefreshTimer: ReturnType<typeof setTimeout> | null;
  activeRequestCookieDomain: () => string;
  refreshCookieJar: (silent?: boolean, persistAfterRefresh?: boolean, workspaceId?: string) => Promise<void>;
  cookieSyncDomains: () => string[];
  startCookieSyncBridge: () => Promise<void>;
  stopCookieSyncBridge: () => Promise<void>;
  addCookieSyncDomain: (raw?: string) => Promise<void>;
  scheduleCookieSyncJarRefresh: () => void;
};

export function normalizeSyncDomainInput(input: string): string {
  let value = input.trim().toLowerCase();
  if (!value) return '';
  if (value.includes('://')) {
    try {
      value = new URL(value).hostname;
    } catch {
      value = value.slice(value.indexOf('://') + 3);
    }
  }
  value = value.split('/')[0].split('?')[0].split('#')[0];
  value = value.replace(/^\*\./, '').replace(/^\.+|\.+$/g, '');
  const portMatch = value.match(/^(.*):(\d+)$/);
  if (portMatch) value = portMatch[1];
  if (!value || /[\s"'\\]/.test(value)) return '';
  if (value !== 'localhost' && !value.includes('.')) return '';
  return value;
}

async function applyStatus(host: CookieSyncHost, next: CookieSyncStatus) {
  host.cookieSync = next;
  host.cookieSyncError = next.error ?? '';
  if (next.port > 0) host.cookieSyncPort = next.port;
}

export const cookieSyncFeature = {
  cookieSyncDomains(this: CookieSyncHost): string[] {
    return this.cookieSync.domains ?? [];
  },
  cookieSyncAwaitingApproval(this: CookieSyncHost): boolean {
    return Boolean(this.cookieSync.pending?.id);
  },
  cookieSyncUnreadableDomains(this: CookieSyncHost): string[] {
    if (!this.cookieSync.connected) return [];
    return this.cookieSync.unreadable ?? [];
  },
  cookieSyncActiveDomainIsListed(this: CookieSyncHost): boolean {
    const domain = normalizeSyncDomainInput(this.activeRequestCookieDomain());
    if (!domain) return true;
    return this.cookieSyncDomains().some(listed => domain === listed || domain.endsWith(`.${listed}`));
  },

  async loadCookieSyncStatus(this: CookieSyncHost) {
    try {
      const status = await fetchCookieSyncStatus();
      await applyStatus(this, status);
      if (status.enabled && !status.running) {
        await this.startCookieSyncBridge();
      } else if (status.running) {
        await setCookieSyncWorkspace(this.activeWorkspaceId);
      }
    } catch (error) {
      this.cookieSyncError = error instanceof Error ? error.message : String(error);
    }
  },

  async startCookieSyncBridge(this: CookieSyncHost) {
    this.cookieSyncBusy = true;
    this.cookieSyncError = '';
    try {
      const port = Number(this.cookieSyncPort) > 0 ? Number(this.cookieSyncPort) : DEFAULT_COOKIE_SYNC_PORT;
      const status = await startCookieSync({
        enabled: true,
        port,
        domains: this.cookieSync.domains ?? [],
      }, this.activeWorkspaceId);
      await applyStatus(this, status);
    } catch (error) {
      this.cookieSyncError = error instanceof Error ? error.message : String(error);
    } finally {
      this.cookieSyncBusy = false;
    }
  },

  async stopCookieSyncBridge(this: CookieSyncHost) {
    this.cookieSyncBusy = true;
    try {
      await applyStatus(this, await stopCookieSync());
    } catch (error) {
      this.cookieSyncError = error instanceof Error ? error.message : String(error);
    } finally {
      this.cookieSyncBusy = false;
    }
  },

  async toggleCookieSync(this: CookieSyncHost) {
    if (this.cookieSync.running) {
      await this.stopCookieSyncBridge();
      return;
    }
    await this.startCookieSyncBridge();
  },

  async addCookieSyncDomain(this: CookieSyncHost, raw = this.cookieSyncDomainInput) {
    const domain = normalizeSyncDomainInput(raw);
    if (!domain) {
      this.cookieSyncError = 'That does not look like a domain — try example.com.';
      return;
    }
    const current = this.cookieSync.domains ?? [];
    if (current.includes(domain)) {
      this.cookieSyncDomainInput = '';
      return;
    }
    this.cookieSyncBusy = true;
    this.cookieSyncError = '';
    try {
      await applyStatus(this, await setCookieSyncDomains([...current, domain]));
      this.cookieSyncDomainInput = '';
    } catch (error) {
      this.cookieSyncError = error instanceof Error ? error.message : String(error);
    } finally {
      this.cookieSyncBusy = false;
    }
  },

  async addActiveRequestDomainToCookieSync(this: CookieSyncHost) {
    const domain = this.activeRequestCookieDomain();
    if (!domain) return;
    await this.addCookieSyncDomain(domain);
  },

  async removeCookieSyncDomain(this: CookieSyncHost, domain: string) {
    const current = this.cookieSync.domains ?? [];
    this.cookieSyncBusy = true;
    this.cookieSyncError = '';
    try {
      await applyStatus(this, await setCookieSyncDomains(current.filter(entry => entry !== domain)));
    } catch (error) {
      this.cookieSyncError = error instanceof Error ? error.message : String(error);
    } finally {
      this.cookieSyncBusy = false;
    }
  },

  async revokeCookieSyncBrowser(this: CookieSyncHost) {
    this.cookieSyncBusy = true;
    this.cookieSyncError = '';
    try {
      await applyStatus(this, await revokeCookieSyncPairing());
      this.cookieSyncCodeCopied = false;
    } catch (error) {
      this.cookieSyncError = error instanceof Error ? error.message : String(error);
    } finally {
      this.cookieSyncBusy = false;
    }
  },

  async approveCookieSyncBrowser(this: CookieSyncHost) {
    const requestId = this.cookieSync.pending?.id ?? '';
    if (!requestId) return;
    this.cookieSyncBusy = true;
    this.cookieSyncError = '';
    try {
      await applyStatus(this, await approveCookieSyncPairing(requestId));
    } catch (error) {
      this.cookieSyncError = error instanceof Error ? error.message : String(error);
    } finally {
      this.cookieSyncBusy = false;
    }
  },

  async denyCookieSyncBrowser(this: CookieSyncHost) {
    const requestId = this.cookieSync.pending?.id ?? '';
    if (!requestId) return;
    this.cookieSyncBusy = true;
    this.cookieSyncError = '';
    try {
      await applyStatus(this, await denyCookieSyncPairing(requestId));
    } catch (error) {
      this.cookieSyncError = error instanceof Error ? error.message : String(error);
    } finally {
      this.cookieSyncBusy = false;
    }
  },

  async copyCookieSyncPairingCode(this: CookieSyncHost) {
    const code = this.cookieSync.pairingCode;
    if (!code) return;
    try {
      await clipboardCopy(code);
      this.cookieSyncCodeCopied = true;
      setTimeout(() => { this.cookieSyncCodeCopied = false; }, 2400);
    } catch (error) {
      this.cookieSyncError = error instanceof Error ? error.message : String(error);
    }
  },

  async pointCookieSyncAtActiveWorkspace(this: CookieSyncHost) {
    if (!this.cookieSync.running) return;
    try {
      await applyStatus(this, await setCookieSyncWorkspace(this.activeWorkspaceId));
    } catch {}
  },

  scheduleCookieSyncJarRefresh(this: CookieSyncHost) {
    if (this.cookieSyncRefreshTimer) clearTimeout(this.cookieSyncRefreshTimer);
    this.cookieSyncRefreshTimer = setTimeout(() => {
      this.cookieSyncRefreshTimer = null;
      void this.refreshCookieJar(true, true);
    }, COOKIE_SYNC_REFRESH_DEBOUNCE_MS);
  },

  initCookieSyncListeners(this: CookieSyncHost) {
    if (!window.runtime?.EventsOn) return;
    listenRuntime<string>('cookies:jar-changed', workspaceId => {
      if (workspaceId) void this.refreshCookieJar(true, true, workspaceId);
    });
    listenRuntime<CookieSyncStatus>('cookies:synced', status => {
      this.cookieSync = status ?? EMPTY_COOKIE_SYNC_STATUS;
      this.cookieSyncError = status?.error ?? '';
      this.scheduleCookieSyncJarRefresh();
    });
  },
};
