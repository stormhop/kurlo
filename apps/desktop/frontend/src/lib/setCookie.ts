export type ResponseCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: string;
  maxAge: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  partitioned: boolean;
};

export function parseSetCookie(header: string): ResponseCookie | null {
  const parts = header.split(';');
  const pair = parts.shift() ?? '';
  const eq = pair.indexOf('=');
  const name = (eq === -1 ? '' : pair.slice(0, eq)).trim();
  const value = (eq === -1 ? pair : pair.slice(eq + 1)).trim();
  if (!name && !value) return null;
  const cookie: ResponseCookie = {
    name,
    value: value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value,
    domain: '',
    path: '',
    expires: '',
    maxAge: '',
    secure: false,
    httpOnly: false,
    sameSite: '',
    partitioned: false,
  };
  for (const part of parts) {
    const at = part.indexOf('=');
    const key = (at === -1 ? part : part.slice(0, at)).trim().toLowerCase();
    const attr = at === -1 ? '' : part.slice(at + 1).trim();
    if (key === 'domain') cookie.domain = attr.replace(/^\./, '');
    else if (key === 'path') cookie.path = attr;
    else if (key === 'expires') cookie.expires = attr;
    else if (key === 'max-age') cookie.maxAge = attr;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') cookie.sameSite = attr;
    else if (key === 'partitioned') cookie.partitioned = true;
  }
  return cookie;
}

export function responseCookies(headers: Array<{ key: string; value: string }> | null | undefined): ResponseCookie[] {
  return (headers ?? [])
    .filter(header => header.key.toLowerCase() === 'set-cookie')
    .map(header => parseSetCookie(header.value))
    .filter((cookie): cookie is ResponseCookie => cookie !== null);
}

export function cookieExpiry(cookie: ResponseCookie, now = Date.now()): string {
  if (cookie.maxAge) {
    const seconds = Number(cookie.maxAge);
    if (Number.isFinite(seconds)) return seconds <= 0 ? 'Expired' : new Date(now + seconds * 1000).toUTCString();
  }
  if (cookie.expires) {
    const time = Date.parse(cookie.expires);
    if (Number.isFinite(time)) return time <= now ? 'Expired' : new Date(time).toUTCString();
    return cookie.expires;
  }
  return 'Session';
}
