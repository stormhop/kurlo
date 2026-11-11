import { describe, expect, it } from 'vitest';
import {
  blankCookieForm,
  buildCookieDomainGroups,
  cookieExpiryLabel,
  cookieForEditing,
  cookieFormFromCookie,
  cookieFromForm,
  cookieHeaderForUrl,
  cookieValueIsMissingSecret,
  keepMissingSecret,
  parseCookieHeader,
  parseRawCookie,
  serializeCookie,
} from '../lib/cookieJar';
import type { CookieJarEntry } from '../lib/backend';

const now = Date.UTC(2026, 0, 1, 0, 0, 0);

function cookie(overrides: Partial<CookieJarEntry>): CookieJarEntry {
  return {
    name: 'sessionId',
    value: 'abc',
    domain: 'api.example.test',
    path: '/',
    expiresAt: 0,
    session: true,
    secure: false,
    httpOnly: false,
    sameSite: '',
    hostOnly: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('cookie jar helpers', () => {
  it('parses and serializes Postman-style raw Set-Cookie text', () => {
    const parsed = parseRawCookie(
      'sessionId=abc; Path=/admin; Domain=.example.test; Expires=Mon, 03 May 2027 20:07:19 GMT; Secure; HttpOnly; SameSite=Lax;',
      'api.example.test',
      now,
    );

    expect(parsed).toMatchObject({
      name: 'sessionId',
      value: 'abc',
      domain: 'example.test',
      path: '/admin',
      session: false,
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      hostOnly: false,
    });
    expect(serializeCookie(parsed)).toContain('sessionId=abc');
    expect(serializeCookie(parsed)).toContain('Path=/admin');
    expect(serializeCookie(parsed)).toContain('Domain=example.test');
    expect(serializeCookie(parsed)).toContain('HttpOnly');
  });

  it('parses Cookie headers into host-only jar entries', () => {
    const parsed = parseCookieHeader(
      '__ddg10_=1774623151; __ddg1_=kr413tNEMRYMIRZHGNUG; __ddg8_=p9DbfJGnLAXgtc4r; __ddg9_=136.169.214.33',
      'api.hornybox.ru',
      now,
    );

    expect(parsed.map(item => [item.name, item.value, item.domain, item.path, item.hostOnly])).toEqual([
      ['__ddg10_', '1774623151', 'api.hornybox.ru', '/', true],
      ['__ddg1_', 'kr413tNEMRYMIRZHGNUG', 'api.hornybox.ru', '/', true],
      ['__ddg8_', 'p9DbfJGnLAXgtc4r', 'api.hornybox.ru', '/', true],
      ['__ddg9_', '136.169.214.33', 'api.hornybox.ru', '/', true],
    ]);
  });

  it('matches host-only and domain cookies for the auto Cookie header', () => {
    const header = cookieHeaderForUrl([
      cookie({ name: 'hostOnly', value: '1', domain: 'api.example.test', hostOnly: true }),
      cookie({ name: 'parentDomain', value: '2', domain: 'example.test', hostOnly: false }),
      cookie({ name: 'wrongHost', value: '3', domain: 'other.example.test', hostOnly: true }),
      cookie({ name: 'wrongPath', value: '4', path: '/admin' }),
    ], 'https://api.example.test/users', now);

    expect(header).toBe('hostOnly=1; parentDomain=2');
  });

  it('matches WebSocket URLs using their HTTP cookie scheme equivalents', () => {
    const cookies = [
      cookie({ name: 'session', value: '1', domain: 'api.example.test', hostOnly: true }),
      cookie({ name: 'secureSession', value: '2', domain: 'api.example.test', hostOnly: true, secure: true }),
    ];

    expect(cookieHeaderForUrl(cookies, 'wss://api.example.test/socket', now)).toBe('secureSession=2; session=1');
    expect(cookieHeaderForUrl(cookies, 'ws://api.example.test/socket', now)).toBe('session=1');
  });

  it('groups manual domains together with saved cookies', () => {
    const groups = buildCookieDomainGroups([
      cookie({ name: 'csrfToken', domain: 'api.example.test' }),
      cookie({ name: 'sessionId', domain: 'api.example.test' }),
    ], ['new-api.example.test'], '');

    expect(groups.map(group => [group.domain, group.cookies.map(item => item.name)])).toEqual([
      ['api.example.test', ['csrfToken', 'sessionId']],
      ['new-api.example.test', []],
    ]);
  });

  it('leaves out cookies whose value is a secret this computer does not have', () => {
    const base = { domain: 'httpbin.org', path: '/', hostOnly: true, secure: false, httpOnly: false, session: true, expiresAt: 0, sameSite: '' };
    const header = cookieHeaderForUrl([
      { ...base, name: 'name', value: '{{kurloSecret:workspace.ws.cookies.name.2ff83fa72e.value}}' },
      { ...base, name: 'theme', value: 'dark' },
    ], 'https://httpbin.org/get');
    expect(header).toBe('theme=dark');
    expect(cookieValueIsMissingSecret('{{kurloSecret:a.b}}')).toBe(true);
    expect(cookieValueIsMissingSecret('x{{kurloSecret:a.b}}')).toBe(false);
  });

  it('never shows a missing secret reference while editing and keeps it when no value is typed', () => {
    const missing = cookie({ name: 'value', value: '{{kurloSecret:workspace.ws.cookies.value.5a2aa6e9.value}}' });
    expect(serializeCookie(cookieForEditing(missing))).toBe('value=; Path=/;');
    expect(cookieFormFromCookie(cookieForEditing(missing)).value).toBe('');
    expect(cookieFormFromCookie(cookieForEditing(parseRawCookie(serializeCookie(missing), 'api.example.test', now))).value).toBe('');
    expect(cookieForEditing(cookie({ value: 'abc' })).value).toBe('abc');

    expect(keepMissingSecret(parseRawCookie('value=; Path=/', 'api.example.test', now), missing).value).toBe(missing.value);
    expect(keepMissingSecret(cookie({ value: '{{kurloSecret:other}}' }), missing).value).toBe(missing.value);
    expect(keepMissingSecret(cookie({ value: 'typed' }), missing).value).toBe('typed');
    expect(keepMissingSecret(cookie({ value: '' }), cookie({ value: 'abc' })).value).toBe('');
    expect(keepMissingSecret(cookie({ value: '' }), undefined).value).toBe('');
  });
});

describe('cookie form', () => {
  it('round-trips a jar cookie through the form fields', () => {
    const expiresAt = now + 3 * 86400000 + 17250;
    const source = cookie({ name: 'sid', value: 'v1', path: '/auth', expiresAt, session: false, secure: true, httpOnly: true, sameSite: 'strict', hostOnly: false });
    const form = cookieFormFromCookie(source);

    expect(form).toMatchObject({ name: 'sid', value: 'v1', path: '/auth', sameSite: 'strict', secure: true, httpOnly: true, subdomains: true });
    expect(form.expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const back = cookieFromForm(form, 'api.example.test', now);
    expect(back).toMatchObject({ name: 'sid', value: 'v1', domain: 'api.example.test', path: '/auth', session: false, secure: true, httpOnly: true, sameSite: 'strict', hostOnly: false });
    expect(back.expiresAt).toBe(expiresAt);
    const moved = cookieFromForm({ ...form, expires: '2030-05-01T10:30' }, 'api.example.test', now);
    expect(moved.expiresAt).toBe(new Date(2030, 4, 1, 10, 30).getTime());
  });

  it('turns an empty Expires into a session cookie scoped to the host', () => {
    const form = { ...blankCookieForm('API.Example.test'), name: 'theme', value: 'dark' };
    expect(cookieFromForm(form, '', now)).toMatchObject({ name: 'theme', value: 'dark', domain: 'api.example.test', session: true, expiresAt: 0, hostOnly: true, path: '/' });
  });

  it('applies the same rules as raw Set-Cookie text', () => {
    const base = blankCookieForm('api.example.test', 'sid');
    expect(() => cookieFromForm({ ...base, name: '' }, '', now)).toThrow('Cookie name is required.');
    expect(() => cookieFromForm({ ...base, name: 'a b' }, '', now)).toThrow(/cannot contain/);
    expect(() => cookieFromForm({ ...base, value: 'a;b' }, '', now)).toThrow('Cookie value cannot contain ";".');
    expect(() => cookieFromForm({ ...base, sameSite: 'none' }, '', now)).toThrow('SameSite=None cookies must also be marked Secure.');
    expect(() => cookieFromForm({ ...base, expires: 'soon' }, '', now)).toThrow('Expires is not a valid date.');
    expect(cookieFromForm({ ...base, path: 'admin' }, '', now).path).toBe('/admin');
  });

  it('labels when a cookie expires', () => {
    expect(cookieExpiryLabel(cookie({}), now)).toBe('Session');
    expect(cookieExpiryLabel(cookie({ session: false, expiresAt: now - 1000 }), now)).toBe('Expired');
    expect(cookieExpiryLabel(cookie({ session: false, expiresAt: now + 5 * 60000 }), now)).toBe('in 5 min');
    expect(cookieExpiryLabel(cookie({ session: false, expiresAt: now + 3 * 3600000 }), now)).toBe('in 3 h');
    expect(cookieExpiryLabel(cookie({ session: false, expiresAt: now + 86400000 }), now)).toBe('in 1 day');
    expect(cookieExpiryLabel(cookie({ session: false, expiresAt: now + 90 * 86400000 }), now)).toBe('in 3 months');
  });
});
