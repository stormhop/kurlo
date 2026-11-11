import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkRow } from '../lib/constants';
import { environmentFeature, mergeEnvironmentRowsWithValues } from '../lib/stores/features/environments';

afterEach(() => {
  vi.useRealTimers();
});

describe('mergeEnvironmentRowsWithValues', () => {
  it('updates active rows, removes unset active rows, keeps disabled rows, and appends script-created values', () => {
    const rows = [
      { ...mkRow(), key: 'token', value: 'old', enabled: true, secret: true },
      { ...mkRow(), key: 'removed', value: 'gone', enabled: true },
      { ...mkRow(), key: 'disabled', value: 'local', enabled: false },
      mkRow(),
    ];

    const merged = mergeEnvironmentRowsWithValues(rows, {
      token: 'new',
      created: 'from-script',
    });

    expect(merged.filter(row => row.key).map(row => [row.key, row.value, row.enabled, row.secret ?? false])).toEqual([
      ['token', 'new', true, true],
      ['disabled', 'local', false, false],
      ['created', 'from-script', true, false],
    ]);
    expect(merged.at(-1)?.key).toBe('');
  });

  it('preserves the existing trailing blank row when nothing changed', () => {
    const trailing = mkRow();
    const rows = [
      { ...mkRow(), key: 'token', value: 'same', enabled: true },
      trailing,
    ];

    const merged = mergeEnvironmentRowsWithValues(rows, { token: 'same' });

    expect(merged).toEqual(rows);
    expect(merged.at(-1)).toBe(trailing);
  });
});

describe('environment manual-save scheduling', () => {
  it('keeps a newer environment toast when an older timer expires', async () => {
    vi.useFakeTimers();
    const host = {
      environmentToast: '',
      environmentToastTimer: null,
      environments: [
        { id: 'env-one', name: 'One' },
        { id: 'env-two', name: 'Two' },
      ],
      selectEnvironment: vi.fn().mockResolvedValue(undefined),
    };

    await environmentFeature.useEnvironment.call(host as never, 'env-one');
    await vi.advanceTimersByTimeAsync(900);
    await environmentFeature.useEnvironment.call(host as never, 'env-two');
    await vi.advanceTimersByTimeAsync(1000);

    expect(host.environmentToast).toBe('Using Two');
    await vi.advanceTimersByTimeAsync(800);
    expect(host.environmentToast).toBe('');
  });

  it('marks environments dirty instead of autosaving when autosave is disabled', async () => {
    vi.useFakeTimers();
    const persistRequestStore = vi.fn().mockResolvedValue(true);
    const host = {
      autosave: false,
      environmentBaselines: new Map([['dev', { id: 'dev', workspaceId: 'ws', name: 'Dev', values: [] }]]),
      environmentPersistTimer: setTimeout(() => undefined, 1000),
      environmentSavedTimer: setTimeout(() => undefined, 1000),
      environmentSaveState: 'idle',
      guardWorkspaceWritable: vi.fn(() => true),
      persistRequestStore,
    };

    environmentFeature.scheduleEnvironmentPersist.call(host as never, 10);
    await vi.advanceTimersByTimeAsync(20);

    expect(host.guardWorkspaceWritable).toHaveBeenCalledWith('Environment changes');
    expect(host.environmentPersistTimer).toBeNull();
    expect(host.environmentSavedTimer).toBeNull();
    expect(host.environmentSaveState).toBe('dirty');
    expect(persistRequestStore).not.toHaveBeenCalled();
  });

  it('autosaves environment edits when autosave is enabled', async () => {
    vi.useFakeTimers();
    const persistRequestStore = vi.fn().mockResolvedValue(true);
    const host = {
      autosave: true,
      environmentPersistTimer: null,
      environmentSavedTimer: null,
      environmentSaveState: 'idle',
      guardWorkspaceWritable: vi.fn(() => true),
      persistRequestStore,
    };

    environmentFeature.scheduleEnvironmentPersist.call(host as never, 10);

    expect(host.environmentSaveState).toBe('saving');
    await vi.advanceTimersByTimeAsync(10);

    expect(persistRequestStore).toHaveBeenCalledTimes(1);
    expect(host.environmentSaveState).toBe('saved');
  });

  it('keeps autosave dirty when persistence fails', async () => {
    vi.useFakeTimers();
    const host = {
      autosave: true,
      environmentPersistTimer: null,
      environmentSavedTimer: null,
      environmentSaveState: 'idle',
      guardWorkspaceWritable: vi.fn(() => true),
      persistRequestStore: vi.fn().mockResolvedValue(false),
    };

    environmentFeature.scheduleEnvironmentPersist.call(host as never, 10);
    await vi.advanceTimersByTimeAsync(10);

    expect(host.environmentSaveState).toBe('dirty');
    expect(host.environmentSavedTimer).toBeNull();
  });
});

describe('nested variable resolution', () => {
  it('expands a variable whose value references other variables', () => {
    const host = {
      activeEnvironmentValues: () => ({
        scheme: 'https',
        host: 'api.example.com',
        origin: '{{scheme}}://{{host}}',
        baseUrl: '{{origin}}/v2',
      }),
    } as never;
    expect(environmentFeature.resolveTemplate.call(host, '{{baseUrl}}/users')).toBe('https://api.example.com/v2/users');
  });

  it('leaves a circular chain alone instead of hanging', () => {
    const host = {
      activeEnvironmentValues: () => ({ a: '{{b}}', b: '{{a}}' }),
    } as never;
    expect(environmentFeature.resolveTemplate.call(host, '{{a}}')).toContain('{{');
  });

  it('resolves names with non-Latin letters, spaces and colons like Postman', () => {
    const host = {
      activeEnvironmentValues: () => ({ 'токен': 'ru', 'my var': 'spaced', 'api:key': 'colon' }),
    } as never;
    expect(environmentFeature.resolveTemplate.call(host, '{{токен}}/{{ my var }}/{{api:key}}/{{}}')).toBe('ru/spaced/colon/{{}}');
  });

  it('still resolves dynamic variables reached through an environment value', () => {
    const host = {
      activeEnvironmentValues: () => ({ traceId: '{{$guid}}', header: 'trace={{traceId}}' }),
    } as never;
    const resolved = environmentFeature.resolveTemplate.call(host, '{{header}}') as string;
    expect(resolved).toMatch(/^trace=[0-9a-f-]{36}$/);
  });
});
