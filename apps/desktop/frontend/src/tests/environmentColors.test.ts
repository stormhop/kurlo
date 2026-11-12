import { describe, expect, it } from 'vitest';
import { normalizeEnvironment } from '../lib/normalizers';
import { ENVIRONMENT_COLORS, environmentColorLabel, environmentColorVar, normalizeEnvironmentColor } from '../lib/environmentColors';

describe('environment colors', () => {
  it('keeps a known color and drops anything else when loading', () => {
    expect(normalizeEnvironment({ id: 'e1', name: 'Prod', color: 'red' }, 'w1').color).toBe('red');
    expect(normalizeEnvironment({ id: 'e1', name: 'Prod', color: ' Amber ' as never }, 'w1').color).toBe('amber');
    expect(normalizeEnvironment({ id: 'e1', name: 'Prod', color: '#ff0000' as never }, 'w1')).not.toHaveProperty('color');
    expect(normalizeEnvironment({ id: 'e1', name: 'Prod' }, 'w1')).not.toHaveProperty('color');
  });

  it('maps every color to a theme role that the contrast tests already cover', () => {
    const allowed = new Set(['var(--danger)', 'var(--warning)', 'var(--success)', 'var(--info)', 'var(--text-3)']);
    expect(ENVIRONMENT_COLORS.every(color => allowed.has(color.cssVar))).toBe(true);
    expect(new Set(ENVIRONMENT_COLORS.map(color => color.cssVar)).size).toBe(ENVIRONMENT_COLORS.length);
    expect(environmentColorVar({ color: 'green' })).toBe('var(--success)');
    expect(environmentColorVar({})).toBeUndefined();
    expect(environmentColorVar(undefined)).toBeUndefined();
    expect(environmentColorLabel('blue')).toBe('Blue');
    expect(normalizeEnvironmentColor(42)).toBeUndefined();
  });

  it('matches the colors the workspace YAML schema accepts', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const schema = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', '..', 'schemas', 'kurlo-workspace-yaml-v1.schema.json'), 'utf8'));
    const text = JSON.stringify(schema);
    expect(text).toContain(JSON.stringify(ENVIRONMENT_COLORS.map(color => color.value)));
  });
});
