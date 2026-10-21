import { listCookies, upsertCookie, deleteCookie, clearCookies } from '../../backend';
import type { CookieJarEntry } from '../../backend';
import { parseCookieHeader } from '../../cookieJar';

type CookieHost = {
  activeWorkspaceId: string;
  cookies: CookieJarEntry[];
  workspaceCookies: Record<string, CookieJarEntry[]>;
  cookieJarOpen: boolean;
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
  restoreCookieJar: (cookies: CookieJarEntry[]) => Promise<void>;
  refreshCookieJar: (silent?: boolean, persistAfterRefresh?: boolean) => Promise<void>;
  pointCookieSyncAtActiveWorkspace: () => Promise<void>;
};

function cloneCookies(cookies: CookieJarEntry[]) {
  return cookies.map(cookie => ({ ...cookie }));
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
      this.cookies = (await listCookies(this.activeWorkspaceId)) ?? this.cookies;
    } catch {}
    this.rememberActiveWorkspaceCookies(workspaceId);
  },
  async restoreWorkspaceCookieJar(this: CookieHost, workspaceId = this.activeWorkspaceId) {
    await this.restoreCookieJar(this.cookiesForWorkspace(workspaceId));
    await this.pointCookieSyncAtActiveWorkspace();
  },
  async restoreCookieJar(this: CookieHost, cookies: CookieJarEntry[]) {
    try {
      this.cookies = (await clearCookies(this.activeWorkspaceId)) ?? [];
    } catch {
      this.cookies = [];
    }
    this.cookies = cookies;
    for (const cookie of cookies) {
      const result = await upsertCookie(this.activeWorkspaceId, cookie);
      if (!result.error) this.cookies = result.cookies ?? this.cookies;
    }
    this.rememberActiveWorkspaceCookies();
  },
  async refreshCookieJar(this: CookieHost, silent = false, persistAfterRefresh = false) {
    if (!silent) this.cookieJarLoading = true;
    this.cookieJarError = '';
    try {
      this.cookies = (await listCookies(this.activeWorkspaceId)) ?? [];
      this.rememberActiveWorkspaceCookies();
      if (persistAfterRefresh) this.scheduleRequestStorePersist();
    } catch (error) {
      this.cookieJarError = error instanceof Error ? error.message : String(error);
    } finally {
      if (!silent) this.cookieJarLoading = false;
    }
  },
  async openCookieJar(this: CookieHost) {
    this.closeFloatingMenus();
    this.cookieJarOpen = true;
    await this.refreshCookieJar();
  },
  closeCookieJar(this: CookieHost) {
    this.cookieJarOpen = false;
    this.cookieJarError = '';
  },
  async importCookieHeaderForUrl(this: CookieHost, requestUrl: string, cookieHeader: string) {
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
        const result = await upsertCookie(this.activeWorkspaceId, cookie);
        nextCookies = result.cookies ?? nextCookies;
        if (result.error) this.cookieJarError = result.error;
      }
      this.cookies = nextCookies;
      if (!this.cookieJarError) {
        this.rememberActiveWorkspaceCookies();
        this.scheduleRequestStorePersist();
      }
    } catch (error) {
      this.cookieJarError = error instanceof Error ? error.message : String(error);
    } finally {
      this.cookieJarSaving = false;
    }
  },
  async saveCookie(this: CookieHost, cookie: CookieJarEntry) {
    this.cookieJarSaving = true;
    this.cookieJarError = '';
    try {
      const result = await upsertCookie(this.activeWorkspaceId, cookie);
      this.cookies = result.cookies ?? [];
      if (result.error) this.cookieJarError = result.error;
      else {
        this.rememberActiveWorkspaceCookies();
        this.scheduleRequestStorePersist();
      }
    } catch (error) {
      this.cookieJarError = error instanceof Error ? error.message : String(error);
    } finally {
      this.cookieJarSaving = false;
    }
  },
  async removeCookie(this: CookieHost, cookie: CookieJarEntry) {
    this.cookieJarSaving = true;
    this.cookieJarError = '';
    try {
      const result = await deleteCookie(this.activeWorkspaceId, cookie);
      this.cookies = result.cookies ?? [];
      if (result.error) this.cookieJarError = result.error;
      else {
        this.rememberActiveWorkspaceCookies();
        this.scheduleRequestStorePersist();
      }
    } catch (error) {
      this.cookieJarError = error instanceof Error ? error.message : String(error);
    } finally {
      this.cookieJarSaving = false;
    }
  },
  async clearCookieJar(this: CookieHost) {
    this.cookieJarSaving = true;
    this.cookieJarError = '';
    try {
      this.cookies = (await clearCookies(this.activeWorkspaceId)) ?? [];
      this.rememberActiveWorkspaceCookies();
      this.scheduleRequestStorePersist();
    } catch (error) {
      this.cookieJarError = error instanceof Error ? error.message : String(error);
    } finally {
      this.cookieJarSaving = false;
    }
  },
};
