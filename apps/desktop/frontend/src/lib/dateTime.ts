export type DateParts = { year: number; month: number; day: number };
export type DateTimeParts = DateParts & { hour: number; minute: number };
export type CalendarDay = DateParts & { inMonth: boolean };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function weekdayLabels(): string[] {
  return WEEKDAYS.map(day => day.slice(0, 2));
}

export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month]} ${year}`;
}

export function parseDateTimeValue(value: string): DateTimeParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month - 1) || hour > 23 || minute > 59) return null;
  return { year, month: month - 1, day, hour, minute };
}

export function formatDateTimeValue(parts: DateTimeParts): string {
  return `${parts.year}-${pad(parts.month + 1)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function partsFromTimestamp(timestamp: number): DateTimeParts {
  const date = new Date(timestamp);
  return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate(), hour: date.getHours(), minute: date.getMinutes() };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export function sameDay(a: DateParts | null, b: DateParts | null): boolean {
  return Boolean(a && b && a.year === b.year && a.month === b.month && a.day === b.day);
}

export function addDays(parts: DateParts, days: number): DateParts {
  const date = new Date(parts.year, parts.month, parts.day + days);
  return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
}

export function addMonths(parts: DateParts, months: number): DateParts {
  const target = new Date(parts.year, parts.month + months, 1);
  const day = Math.min(parts.day, daysInMonth(target.getFullYear(), target.getMonth()));
  return { year: target.getFullYear(), month: target.getMonth(), day };
}

export function weekdayIndex(parts: DateParts): number {
  return (new Date(parts.year, parts.month, parts.day).getDay() + 6) % 7;
}

export function monthGrid(year: number, month: number): CalendarDay[] {
  const first = { year, month, day: 1 };
  const start = addDays(first, -weekdayIndex(first));
  return Array.from({ length: 42 }, (_, index) => {
    const day = addDays(start, index);
    return { ...day, inMonth: day.month === month && day.year === year };
  });
}

export function dayLabel(parts: DateParts): string {
  return `${WEEKDAYS[weekdayIndex(parts)]}, ${MONTHS[parts.month]} ${parts.day}, ${parts.year}`;
}

export function formatDateTimeLabel(value: string): string {
  const parts = parseDateTimeValue(value);
  if (!parts) return '';
  return `${MONTHS[parts.month].slice(0, 3)} ${parts.day}, ${parts.year} · ${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function presetValue(now: number, minutes: number): string {
  const date = new Date(now + minutes * 60_000);
  date.setSeconds(0, 0);
  return formatDateTimeValue(partsFromTimestamp(date.getTime()));
}

export function clampTimePart(raw: string, max: number): number | null {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  return Math.min(max, Math.max(0, Number(digits)));
}

export function defaultTime(now: number): { hour: number; minute: number } {
  const date = new Date(now);
  return { hour: (date.getHours() + 1) % 24, minute: 0 };
}

export { pad as padTimePart };
