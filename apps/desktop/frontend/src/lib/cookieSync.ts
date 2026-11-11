import type { CookieJarEntry, CookieSyncStatus } from './backend';
import { normalizeCookieDomain } from './cookieJar';

export type CookieDomainGroup = { domain: string; cookies: CookieJarEntry[] };

export type CookieSyncState = 'off' | 'waiting' | 'pending' | 'live' | 'offline';

export function cookieSyncState(status: CookieSyncStatus): CookieSyncState {
  if (!status.running) return 'off';
  if (status.pending?.id) return 'pending';
  if (status.connected) return 'live';
  if (status.paired) return 'offline';
  return 'waiting';
}

export function cookieSyncHeadline(status: CookieSyncStatus): string {
  const browser = status.browser || 'A browser';
  switch (cookieSyncState(status)) {
    case 'off': return 'Cookie sync is off';
    case 'pending': return `${status.pending?.browser || 'A browser'} wants to connect`;
    case 'live': return `${browser} is connected`;
    case 'offline': return `${browser} is paired but offline`;
    default: return 'Waiting for a browser';
  }
}

export function cookieSyncShortLabel(status: CookieSyncStatus): string {
  switch (cookieSyncState(status)) {
    case 'off': return 'Off';
    case 'pending': return `${status.pending?.browser || 'A browser'} wants to connect`;
    case 'live': return `${status.browser || 'Browser'} connected`;
    case 'offline': return `${status.browser || 'Browser'} offline`;
    default: return 'Waiting for a browser';
  }
}

export function resolveCookieDomainGroup(groups: CookieDomainGroup[], selected: string, openRequestDomain: string): CookieDomainGroup | undefined {
  const wanted = normalizeCookieDomain(selected);
  const fallback = normalizeCookieDomain(openRequestDomain);
  return groups.find(group => group.domain === wanted)
    ?? groups.find(group => group.domain === fallback)
    ?? groups[0];
}

export function cookieCountLabel(count: number): string {
  return `${count} cookie${count === 1 ? '' : 's'}`;
}
