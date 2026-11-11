import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  clampTimePart,
  dayLabel,
  formatDateTimeLabel,
  formatDateTimeValue,
  monthGrid,
  monthLabel,
  parseDateTimeValue,
  presetValue,
  weekdayIndex,
  weekdayLabels,
} from '../lib/dateTime';
import { cookieFromForm, blankCookieForm } from '../lib/cookieJar';

describe('date and time picker logic', () => {
  it('reads and writes the same value format the cookie form stores', () => {
    const parts = parseDateTimeValue('2026-11-12T09:05');
    expect(parts).toEqual({ year: 2026, month: 10, day: 12, hour: 9, minute: 5 });
    expect(formatDateTimeValue(parts!)).toBe('2026-11-12T09:05');
    expect(parseDateTimeValue('')).toBeNull();
    expect(parseDateTimeValue('2026-02-30T10:00')).toBeNull();
    expect(parseDateTimeValue('2026-13-01T10:00')).toBeNull();
    expect(parseDateTimeValue('2026-11-12T24:00')).toBeNull();
  });

  it('lays out six Monday-first weeks around the month', () => {
    const days = monthGrid(2026, 10);
    expect(days).toHaveLength(42);
    expect(days[0]).toEqual({ year: 2026, month: 9, day: 26, inMonth: false });
    expect(days.find(day => day.inMonth)).toEqual({ year: 2026, month: 10, day: 1, inMonth: true });
    expect(days.filter(day => day.inMonth)).toHaveLength(30);
    expect(weekdayIndex(days[0])).toBe(0);
    expect(weekdayLabels()).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
  });

  it('starts the grid on the first when a month begins on Monday', () => {
    expect(monthGrid(2026, 5)[0]).toEqual({ year: 2026, month: 5, day: 1, inMonth: true });
  });

  it('moves across months, years and short months', () => {
    expect(addDays({ year: 2026, month: 11, day: 31 }, 1)).toEqual({ year: 2027, month: 0, day: 1 });
    expect(addDays({ year: 2026, month: 2, day: 1 }, -1)).toEqual({ year: 2026, month: 1, day: 28 });
    expect(addMonths({ year: 2026, month: 0, day: 31 }, 1)).toEqual({ year: 2026, month: 1, day: 28 });
    expect(addMonths({ year: 2028, month: 0, day: 31 }, 1)).toEqual({ year: 2028, month: 1, day: 29 });
    expect(addMonths({ year: 2026, month: 0, day: 15 }, -1)).toEqual({ year: 2025, month: 11, day: 15 });
  });

  it('labels days and values in English regardless of the system language', () => {
    expect(monthLabel(2026, 10)).toBe('November 2026');
    expect(dayLabel({ year: 2026, month: 10, day: 12 })).toBe('Thursday, November 12, 2026');
    expect(formatDateTimeLabel('2026-11-12T09:05')).toBe('Nov 12, 2026 · 09:05');
    expect(formatDateTimeLabel('')).toBe('');
  });

  it('builds presets from the current time and clamps typed time parts', () => {
    const now = new Date(2026, 10, 12, 9, 41, 30).getTime();
    expect(presetValue(now, 60)).toBe('2026-11-12T10:41');
    expect(presetValue(now, 1440)).toBe('2026-11-13T09:41');
    expect(clampTimePart('7', 23)).toBe(7);
    expect(clampTimePart('99', 59)).toBe(59);
    expect(clampTimePart('ab', 59)).toBeNull();
  });

  it('turns a picked value into the cookie expiry the jar stores', () => {
    const form = { ...blankCookieForm('api.kurlo.test', 'session'), value: 'abc', expires: '2026-11-12T09:05' };
    const cookie = cookieFromForm(form, 'api.kurlo.test');
    expect(cookie.expiresAt).toBe(new Date(2026, 10, 12, 9, 5).getTime());
    expect(cookie.session).toBe(false);
  });
});
