import type { KVRow, OpenApiSource } from './types/models';
import { cloneRowsForStore } from './utils';

export const OPENAPI_SYNC_INTERVALS = [0, 5, 15, 60, 360, 1440] as const;
export const DEFAULT_OPENAPI_SYNC_INTERVAL = 15;

export function normalizeOpenApiSource(raw: unknown): OpenApiSource | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const source = typeof input.source === 'string' ? input.source.trim() : '';
  if (!source) return undefined;
  const headers = Array.isArray(input.headers) ? cloneRowsForStore(input.headers as KVRow[]).filter(row => row.key.trim() || row.value.trim()) : [];
  const interval = typeof input.intervalMinutes === 'number' && Number.isFinite(input.intervalMinutes)
    ? Math.max(0, Math.round(input.intervalMinutes))
    : DEFAULT_OPENAPI_SYNC_INTERVAL;
  const ignored = Array.isArray(input.ignored)
    ? [...new Set(input.ignored.filter((key): key is string => typeof key === 'string' && Boolean(key.trim())).map(key => key.trim()))]
    : [];
  return {
    source,
    ...(headers.length ? { headers } : {}),
    intervalMinutes: interval,
    ...(input.skipTlsVerification === true ? { skipTlsVerification: true } : {}),
    ...(ignored.length ? { ignored } : {}),
  };
}

export function openApiSourceIsUrl(source: string): boolean {
  return /^https?:\/\//i.test(source.trim()) || /^\{\{[^}]+\}\}/.test(source.trim());
}

export function openApiIntervalLabel(minutes: number): string {
  if (!minutes) return 'Off';
  if (minutes < 60) return `Every ${minutes} min`;
  if (minutes < 1440) return `Every ${minutes / 60} h`.replace('Every 1 h', 'Every hour');
  return 'Every day';
}
