import type { CookieJarEntry } from './backend';

type DomainGroup = { domain: string; cookies: CookieJarEntry[] };

export function normalizeCookieDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\.+|\.+$/g, '');
}

export function cookieKey(cookie: CookieJarEntry): string {
  return [cookie.domain.toLowerCase(), cookie.path, cookie.name, cookie.hostOnly ? '1' : '0'].join('\u001f');
}

function blankCookie(domain = '', timestamp = Date.now()): CookieJarEntry {
  return {
    name: '',
    value: '',
    domain,
    path: '/',
    expiresAt: 0,
    session: true,
    secure: false,
    httpOnly: false,
    sameSite: '',
    hostOnly: Boolean(domain),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function serializeCookie(cookie: CookieJarEntry): string {
  const parts = [`${cookie.name}=${cookie.value}`, `Path=${cookie.path || '/'}`];
  if (!cookie.hostOnly && cookie.domain) parts.push(`Domain=${cookie.domain}`);
  if (!cookie.session && cookie.expiresAt) parts.push(`Expires=${new Date(cookie.expiresAt).toUTCString()}`);
  if (cookie.secure) parts.push('Secure');
  if (cookie.httpOnly) parts.push('HttpOnly');
  if (cookie.sameSite) parts.push(`SameSite=${cookie.sameSite[0].toUpperCase()}${cookie.sameSite.slice(1)}`);
  return `${parts.join('; ')};`;
}

export function parseRawCookie(source: string, fallbackDomain: string, timestamp = Date.now()): CookieJarEntry {
  const parts = source.split(';').map(part => part.trim()).filter(Boolean);
  const [nameValue, ...attrs] = parts;
  const eq = nameValue?.indexOf('=') ?? -1;
  if (!nameValue || eq <= 0) throw new Error('Cookie must start with name=value.');
  const cookie = blankCookie(normalizeCookieDomain(fallbackDomain), timestamp);
  cookie.name = nameValue.slice(0, eq).trim();
  cookie.value = nameValue.slice(eq + 1).trim();
  cookie.hostOnly = true;
  for (const attr of attrs) {
    const attrEq = attr.indexOf('=');
    const key = (attrEq >= 0 ? attr.slice(0, attrEq) : attr).trim().toLowerCase();
    const value = attrEq >= 0 ? attr.slice(attrEq + 1).trim() : '';
    if (key === 'path') cookie.path = value || '/';
    else if (key === 'domain') {
      cookie.domain = normalizeCookieDomain(value);
      cookie.hostOnly = false;
    } else if (key === 'expires') {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) {
        cookie.expiresAt = parsed;
        cookie.session = false;
      }
    } else if (key === 'max-age') {
      const trimmed = value.trim();
      if (trimmed !== '') {
        const seconds = Number(trimmed);
        if (Number.isFinite(seconds)) {
          cookie.expiresAt = seconds > 0 ? timestamp + seconds * 1000 : timestamp - 1000;
          cookie.session = false;
        }
      }
    } else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') {
      const sameSite = value.toLowerCase();
      cookie.sameSite = sameSite === 'lax' || sameSite === 'strict' || sameSite === 'none' ? sameSite : '';
    }
  }
  if (!cookie.name) throw new Error('Cookie name is required.');
  if (!cookie.domain) throw new Error('Cookie domain is required.');
  if (!cookie.path.startsWith('/')) cookie.path = `/${cookie.path}`;
  if (cookie.sameSite === 'none' && !cookie.secure) {
    throw new Error('SameSite=None cookies must also be marked Secure.');
  }
  if (cookie.path.includes('..')) {
    throw new Error('Cookie Path must not contain "..".');
  }
  return cookie;
}

export function parseCookieHeader(source: string, fallbackDomain: string, timestamp = Date.now()): CookieJarEntry[] {
  const domain = normalizeCookieDomain(fallbackDomain);
  if (!domain) return [];
  return source
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const eq = part.indexOf('=');
      if (eq <= 0) return null;
      const cookie = blankCookie(domain, timestamp);
      cookie.name = part.slice(0, eq).trim();
      cookie.value = part.slice(eq + 1).trim();
      return cookie.name ? cookie : null;
    })
    .filter((cookie): cookie is CookieJarEntry => Boolean(cookie));
}

export function buildCookieDomainGroups(cookies: CookieJarEntry[], manualDomains: string[], query = ''): DomainGroup[] {
  const q = normalizeCookieDomain(query);
  const domains = new Map<string, CookieJarEntry[]>();
  for (const cookie of cookies) {
    const domain = normalizeCookieDomain(cookie.domain);
    if (!domain) continue;
    if (!domains.has(domain)) domains.set(domain, []);
    domains.get(domain)?.push(cookie);
  }
  for (const domain of manualDomains.map(normalizeCookieDomain).filter(Boolean)) {
    if (!domains.has(domain)) domains.set(domain, []);
  }
  return [...domains.entries()]
    .filter(([domain]) => !q || domain.includes(q))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, groupCookies]) => ({
      domain,
      cookies: groupCookies.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
    }));
}

function cookieMatchesUrl(cookie: CookieJarEntry, requestUrl: string, now = Date.now()): boolean {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return false;
  }
  const protocol = parsed.protocol === 'ws:' ? 'http:' : parsed.protocol === 'wss:' ? 'https:' : parsed.protocol;
  if (!['http:', 'https:'].includes(protocol)) return false;
  if (cookie.secure && protocol !== 'https:') return false;
  if (!cookie.session && cookie.expiresAt > 0 && cookie.expiresAt <= now) return false;
  const host = parsed.hostname.toLowerCase();
  const domain = normalizeCookieDomain(cookie.domain);
  const domainMatches = cookie.hostOnly ? host === domain : host === domain || host.endsWith(`.${domain}`);
  if (!domainMatches) return false;
  const requestPath = parsed.pathname || '/';
  const cookiePath = cookie.path || '/';
  return requestPath === cookiePath || requestPath.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);
}

export function cookieValueIsMissingSecret(value: string): boolean {
  return /^\{\{kurloSecret:[^{}]+\}\}$/.test(value);
}

export function cookieHeaderForUrl(cookies: CookieJarEntry[], requestUrl: string, now = Date.now()): string {
  return cookies
    .filter(cookie => cookieMatchesUrl(cookie, requestUrl, now) && !cookieValueIsMissingSecret(cookie.value))
    .sort((a, b) => (b.path || '/').length - (a.path || '/').length || a.name.localeCompare(b.name))
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

export type CookieSameSite = '' | 'lax' | 'strict' | 'none';

export type CookieForm = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: string;
  expiresAt: number;
  sameSite: CookieSameSite;
  secure: boolean;
  httpOnly: boolean;
  subdomains: boolean;
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function toLocalDateTimeInput(timestamp: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function blankCookieForm(domain: string, name = ''): CookieForm {
  return {
    name,
    value: '',
    domain: normalizeCookieDomain(domain),
    path: '/',
    expires: '',
    expiresAt: 0,
    sameSite: '',
    secure: false,
    httpOnly: false,
    subdomains: false,
  };
}

export function cookieFormFromCookie(cookie: CookieJarEntry): CookieForm {
  const sameSite = cookie.sameSite.toLowerCase();
  return {
    name: cookie.name,
    value: cookie.value,
    domain: normalizeCookieDomain(cookie.domain),
    path: cookie.path || '/',
    expires: cookie.session ? '' : toLocalDateTimeInput(cookie.expiresAt),
    expiresAt: cookie.session ? 0 : cookie.expiresAt,
    sameSite: sameSite === 'lax' || sameSite === 'strict' || sameSite === 'none' ? sameSite : '',
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    subdomains: !cookie.hostOnly,
  };
}

export function cookieFromForm(form: CookieForm, fallbackDomain: string, timestamp = Date.now()): CookieJarEntry {
  const name = form.name.trim();
  if (!name) throw new Error('Cookie name is required.');
  if (/[=;\s]/.test(name)) throw new Error('Cookie name cannot contain "=", ";" or spaces.');
  if (form.value.includes(';')) throw new Error('Cookie value cannot contain ";".');
  const domain = normalizeCookieDomain(form.domain || fallbackDomain);
  let expiresAt = 0;
  if (form.expiresAt && form.expires === toLocalDateTimeInput(form.expiresAt)) {
    expiresAt = form.expiresAt;
  } else if (form.expires.trim()) {
    expiresAt = new Date(form.expires).getTime();
    if (Number.isNaN(expiresAt)) throw new Error('Expires is not a valid date.');
  }
  const draft: CookieJarEntry = {
    name,
    value: form.value.trim(),
    domain,
    path: form.path.trim() || '/',
    expiresAt,
    session: !expiresAt,
    secure: form.secure,
    httpOnly: form.httpOnly,
    sameSite: form.sameSite,
    hostOnly: !form.subdomains,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const parsed = parseRawCookie(serializeCookie(draft), domain, timestamp);
  return { ...parsed, expiresAt, session: !expiresAt };
}

export function cookieIsExpired(cookie: CookieJarEntry, now = Date.now()): boolean {
  return !cookie.session && cookie.expiresAt > 0 && cookie.expiresAt <= now;
}

export function cookieExpiryLabel(cookie: CookieJarEntry, now = Date.now()): string {
  if (cookie.session || !cookie.expiresAt) return 'Session';
  if (cookieIsExpired(cookie, now)) return 'Expired';
  const minutes = Math.round((cookie.expiresAt - now) / 60000);
  if (minutes < 1) return 'in under a minute';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 60) return `in ${days} day${days === 1 ? '' : 's'}`;
  const months = Math.round(days / 30);
  if (months < 24) return `in ${months} months`;
  return `in ${Math.round(days / 365)} years`;
}
