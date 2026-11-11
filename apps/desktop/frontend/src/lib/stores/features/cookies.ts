import { listCookies, upsertCookie, deleteCookie, clearCookies } from '../../backend';
import type { CookieJarEntry } from '../../backend';
import { parseCookieHeader } from '../../cookieJar';
import type { SidebarView } from '../../types/models';
import type { TopView } from '../ui';
import { cookieView, type CookieSection } from '../cookieView.svelte';

type CookieHost = {
  activeWorkspaceId: string;
  cookies: CookieJarEntry[];
  workspaceCookies: Record<string, CookieJarEntry[]>;
  sidebarView: SidebarView;
  sidebarHidden: boolean;
  topView: TopView;
  cookieJarLoading: boolean;
  cookieJarSaving: boolean;
  cookieJarError: string;
  url: string;
  resolveTemplate: (value: string, values?: Record<string, string>) => string;
  normalizeRequestUrlForSend: (rawUrl: string) => string;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  closeFloatingMenus: () => void;
  scheduleRequestStorePersist: (delay?: number) => void;
  normalizeCookieEntry: (input: unknown) => CookieJarEntry | null;
  rememberActiveWorkspaceCookies: (workspaceId?: string) => void;
  cookiesForWorkspace: (workspaceId: string) => CookieJarEntry[];
  restoreCookieJar: (cookies: CookieJarEntry[], workspaceId?: string) => Promise<void>;
  refreshCookieJar: (silent?: boolean, persistAfterRefresh?: boolean, workspaceId?: string) => Promise<void>;
  pointCookieSyncAtActiveWorkspace: () => Promise<void>;
};

function cloneCookies(cookies: CookieJarEntry[]) {
  return cookies.map(cookie => ({ ...cookie }));
}

function applyWorkspaceCookies(host: CookieHost, workspaceId: string, cookies: CookieJarEntry[]) {
  host.workspaceCookies = { ...host.workspaceCookies, [workspaceId]: cloneCookies(cookies) };
  if (host.activeWorkspaceId === workspaceId) host.cookies = cloneCookies(cookies);
}

export const cookieFeature = {
  activeRequestCookieDomain(this: CookieHost): string {
    const resolvedUrl = this.normalizeRequestUrlForSend(this.resolveTemplate(this.url.trim()));
    try { return new URL(resolvedUrl).hostname; } catch { return ''; }
  },
  normalizeCookieEntry(this: CookieHost, input: unknown): CookieJarEntry | null {
    if (!this.isRecord(input)) return null;
    const name = String(input.name ?? '').trim();
    const domain = String(input.domain ?? '').trim();
    const path = String(input.path ?? '/').trim() || '/';
    const expiresAt = Number(input.expiresAt ?? 0) || 0;
    const session = typeof input.session === 'boolean' ? input.session : !expiresAt;
    if (!name || !domain) return null;
    if (!session && expiresAt > 0 && expiresAt < Date.now()) return null;
    const sameSite = String(input.sameSite ?? '').toLowerCase();
    return {
      name,
      value: String(input.value ?? ''),
      domain,
      path: path.startsWith('/') ? path : `/${path}`,
      expiresAt,
      session,
      secure: Boolean(input.secure),
      httpOnly: Boolean(input.httpOnly),
      sameSite: sameSite === 'lax' || sameSite === 'strict' || sameSite === 'none' ? sameSite : '',
      hostOnly: Boolean(input.hostOnly),
      createdAt: Number(input.createdAt ?? Date.now()) || Date.now(),
      updatedAt: Number(input.updatedAt ?? Date.now()) || Date.now(),
    };
  },
  normalizeWorkspaceCookieStore(this: CookieHost, input: unknown) {
    const next: Record<string, CookieJarEntry[]> = {};
    if (this.isRecord(input)) {
      for (const [workspaceId, rawCookies] of Object.entries(input)) {
        if (!workspaceId || !Array.isArray(rawCookies)) continue;
        const cookies = rawCookies
          .map(cookie => this.normalizeCookieEntry(cookie))
          .filter((cookie): cookie is CookieJarEntry => Boolean(cookie));
        if (cookies.length) next[workspaceId] = cloneCookies(cookies);
      }
    }
    return next;
  },
  rememberActiveWorkspaceCookies(this: CookieHost, workspaceId = this.activeWorkspaceId) {
    if (!workspaceId) return;
    this.workspaceCookies = {
      ...this.workspaceCookies,
      [workspaceId]: cloneCookies(this.cookies),
    };
  },
  cookiesForWorkspace(this: CookieHost, workspaceId: string) {
    return cloneCookies(this.workspaceCookies[workspaceId] ?? []);
  },
  async captureActiveWorkspaceCookies(this: CookieHost, workspaceId = this.activeWorkspaceId) {
    if (!workspaceId) return;
    try {
      const cookies = await listCookies(workspaceId);
      if (cookies) applyWorkspaceCookies(this, workspaceId, cookies);
    } catch {}
  },
  async restoreWorkspaceCookieJar(this: CookieHost, workspaceId = this.activeWorkspaceId) {
    await this.restoreCookieJar(this.cookiesForWorkspace(workspaceId), workspaceId);
    if (this.activeWorkspaceId === workspaceId) await this.pointCookieSyncAtActiveWorkspace();
  },
  async restoreCookieJar(this: CookieHost, cookies: CookieJarEntry[], workspaceId = this.activeWorkspaceId) {
    try {
      await clearCookies(workspaceId);
    } catch {}
    let nextCookies = cloneCookies(cookies);
    for (const cookie of cookies) {
      const result = await upsertCookie(workspaceId, cookie);
      if (!result.error) nextCookies = result.cookies ?? nextCookies;
    }
    applyWorkspaceCookies(this, workspaceId, nextCookies);
  },
  async refreshCookieJar(this: CookieHost, silent = false, persistAfterRefresh = false, workspaceId = this.activeWorkspaceId) {
    if (!silent) this.cookieJarLoading = true;
    this.cookieJarError = '';
    try {
      const cookies = (await listCookies(workspaceId)) ?? [];
      applyWorkspaceCookies(this, workspaceId, cookies);
      if (persistAfterRefresh) this.scheduleRequestStorePersist();
    } catch (error) {
      if (this.activeWorkspaceId === workspaceId) this.cookieJarError = error instanceof Error ? error.message : String(error);
    } finally {
      if (!silent) this.cookieJarLoading = false;
    }
  },
  async openCookieJar(this: CookieHost, section?: CookieSection) {
    this.closeFloatingMenus();
    if (section) cookieView.section = section;
    this.sidebarView = 'cookies';
    this.sidebarHidden = false;
    this.topView = 'cookies';
    await this.refreshCookieJar();
  },

  async importCookieHeaderForUrl(this: CookieHost, requestUrl: string, cookieHeader: string) {
    const workspaceId = this.activeWorkspaceId;
    let hostname: string;
    try {
      hostname = new URL(this.normalizeRequestUrlForSend(this.resolveTemplate(requestUrl.trim()))).hostname;
    } catch {
      return;
    }
    const cookies = parseCookieHeader(cookieHeader, hostname);
    if (!cookies.length) return;
    this.cookieJarSaving = true;
    this.cookieJarError = '';
    try {
      let nextCookies = this.cookies;
      for (const cookie of cookies) {
        const result = await upsertCookie(workspaceId, cookie);
        nextCookies = result.cookies ?? nextCookies;
        if (result.error) this.cookieJarError = result.error;
      }
      applyWorkspaceCookies(this, workspaceId, nextCookies);
      if (!this.cookieJarError) {
        this.scheduleRequestStorePersist();
      }
    } catch (error) {
      this.cookieJarError = error instanceof Error ? error.message : String(error);
    } finally {
      this.cookieJarSaving = false;
    }
  },
  async saveCookie(this: CookieHost, cookie: CookieJarEntry) {
    const workspaceId = this.activeWorkspaceId;
    this.cookieJarSaving = true;
    this.cookieJarError = '';
    try {
      const result = await upsertCookie(workspaceId, cookie);
      applyWorkspaceCookies(this, workspaceId, result.cookies ?? []);
      if (result.error) this.cookieJarError = result.error;
      else {
        this.scheduleRequestStorePersist();
      }
    } catch (error) {
      this.cookieJarError = error instanceof Error ? error.message : String(error);
    } finally {
      this.cookieJarSaving = false;
    }
  },
  async removeCookie(this: CookieHost, cookie: CookieJarEntry) {
    const workspaceId = this.activeWorkspaceId;
    this.cookieJarSaving = true;
    this.cookieJarError = '';
    try {
      const result = await deleteCookie(workspaceId, cookie);
      applyWorkspaceCookies(this, workspaceId, result.cookies ?? []);
      if (result.error) this.cookieJarError = result.error;
      else {
        this.scheduleRequestStorePersist();
      }
    } catch (error) {
      this.cookieJarError = error instanceof Error ? error.message : String(error);
    } finally {
      this.cookieJarSaving = false;
    }
  },
  async clearCookieJar(this: CookieHost) {
    const workspaceId = this.activeWorkspaceId;
    this.cookieJarSaving = true;
    this.cookieJarError = '';
    try {
      const cookies = (await clearCookies(workspaceId)) ?? [];
      applyWorkspaceCookies(this, workspaceId, cookies);
      this.scheduleRequestStorePersist();
    } catch (error) {
      this.cookieJarError = error instanceof Error ? error.message : String(error);
    } finally {
      this.cookieJarSaving = false;
    }
  },
};
