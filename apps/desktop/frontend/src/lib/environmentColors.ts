import type { EnvironmentColor } from './types/models';

export const ENVIRONMENT_COLORS: { value: EnvironmentColor; label: string; cssVar: string }[] = [
  { value: 'red', label: 'Red', cssVar: 'var(--danger)' },
  { value: 'amber', label: 'Amber', cssVar: 'var(--warning)' },
  { value: 'green', label: 'Green', cssVar: 'var(--success)' },
  { value: 'blue', label: 'Blue', cssVar: 'var(--info)' },
  { value: 'gray', label: 'Gray', cssVar: 'var(--text-3)' },
];

const BY_VALUE = new Map(ENVIRONMENT_COLORS.map(color => [color.value, color]));

export function normalizeEnvironmentColor(value: unknown): EnvironmentColor | undefined {
  if (typeof value !== 'string') return undefined;
  const color = value.trim().toLowerCase() as EnvironmentColor;
  return BY_VALUE.has(color) ? color : undefined;
}

export function environmentColorVar(environment: { color?: EnvironmentColor } | null | undefined): string | undefined {
  return environment?.color ? BY_VALUE.get(environment.color)?.cssVar : undefined;
}

export function environmentColorLabel(color: EnvironmentColor | undefined): string {
  return color ? BY_VALUE.get(color)?.label ?? '' : '';
}
