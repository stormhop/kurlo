import { describe, expect, it } from 'vitest';
import { httpStatusInfo } from '../lib/httpStatus';
import { cookieExpiry, parseSetCookie, responseCookies } from '../lib/setCookie';
import { placeFixedPopover } from '../lib/fixedPopover';

describe('http status info', () => {
  it('explains known codes and falls back to the class', () => {
    expect(httpStatusInfo(404)?.title).toBe('Not Found');
    expect(httpStatusInfo(429)?.description).toContain('Retry-After');
    expect(httpStatusInfo(299)).toEqual({ title: 'Success', description: 'The request succeeded.' });
    expect(httpStatusInfo(599)?.title).toBe('Server error');
    expect(httpStatusInfo(0)).toBeNull();
  });
});

describe('set-cookie parsing', () => {
  it('reads the pair and every attribute', () => {
    expect(parseSetCookie('session="abc=1"; Domain=.kurlo.test; Path=/api; Max-Age=60; Secure; HttpOnly; SameSite=Strict; Partitioned')).toEqual({
      name: 'session',
      value: 'abc=1',
      domain: 'kurlo.test',
      path: '/api',
      expires: '',
      maxAge: '60',
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
      partitioned: true,
    });
  });

  it('keeps only Set-Cookie headers and skips empty ones', () => {
    const cookies = responseCookies([
      { key: 'Content-Type', value: 'text/plain' },
      { key: 'set-cookie', value: 'a=1' },
      { key: 'Set-Cookie', value: '' },
      { key: 'Set-Cookie', value: 'b=2; path=/' },
    ]);
    expect(cookies.map(cookie => `${cookie.name}=${cookie.value}`)).toEqual(['a=1', 'b=2']);
  });

  it('describes when a cookie expires', () => {
    const now = Date.UTC(2026, 10, 23, 12, 0, 0);
    const base = parseSetCookie('a=1')!;
    expect(cookieExpiry(base, now)).toBe('Session');
    expect(cookieExpiry({ ...base, maxAge: '3600' }, now)).toBe('Mon, 23 Nov 2026 13:00:00 GMT');
    expect(cookieExpiry({ ...base, maxAge: '0', expires: 'Wed, 01 Jan 2031 00:00:00 GMT' }, now)).toBe('Expired');
    expect(cookieExpiry({ ...base, expires: 'Wed, 01 Jan 2020 00:00:00 GMT' }, now)).toBe('Expired');
    expect(cookieExpiry({ ...base, expires: 'someday' }, now)).toBe('someday');
  });
});

describe('fixed popover placement', () => {
  const viewport = { width: 1000, height: 700 };
  const anchor = (left: number, top: number) => ({ left, top, bottom: top + 20 });

  it('opens below the anchor and stays inside the window', () => {
    expect(placeFixedPopover(anchor(100, 100), { width: 200, height: 100 }, viewport)).toEqual({ left: 100, top: 130 });
    expect(placeFixedPopover(anchor(900, 100), { width: 200, height: 100 }, viewport)).toEqual({ left: 792, top: 130 });
    expect(placeFixedPopover(anchor(2, 100), { width: 200, height: 100 }, viewport)).toEqual({ left: 8, top: 130 });
  });

  it('opens above when there is no room below', () => {
    expect(placeFixedPopover(anchor(100, 640), { width: 200, height: 100 }, viewport)).toEqual({ left: 100, top: 530 });
  });
});
