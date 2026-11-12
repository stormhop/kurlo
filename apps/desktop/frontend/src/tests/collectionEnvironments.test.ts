import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultPinnedEnvironmentId,
  environmentForCollectionEntry,
  environmentMenuGroups,
  normalizeCollectionEnvironmentPins,
  withoutPinnedEnvironment,
} from '../lib/collectionEnvironments';
import { collectionSettingsFingerprint } from '../lib/collectionDefaults';
import { normalizeCollection } from '../lib/normalizers';
import { collectionFeature } from '../lib/stores/features/collections';
import { environmentFeature } from '../lib/stores/features/environments';
import type { Collection, Environment } from '../lib/types/models';

const env = (id: string, name = id): Environment => ({ id, workspaceId: 'ws', name, filesystemName: name, values: [] });

const environments = [env('pay-dev', 'Payment Dev'), env('pay-stage', 'Payment Staging'), env('auth-dev', 'Auth Dev')];

afterEach(() => {
  vi.useRealTimers();
});

describe('normalizeCollectionEnvironmentPins', () => {
  it('keeps unique string ids and drops a default that is not pinned', () => {
    expect(normalizeCollectionEnvironmentPins({ environmentIds: [' pay-dev ', 'pay-dev', 3, '', 'pay-stage'], defaultEnvironmentId: 'auth-dev' }))
      .toEqual({ environmentIds: ['pay-dev', 'pay-stage'] });
    expect(normalizeCollectionEnvironmentPins({ environmentIds: ['pay-dev'], defaultEnvironmentId: 'pay-dev' }))
      .toEqual({ environmentIds: ['pay-dev'], defaultEnvironmentId: 'pay-dev' });
  });

  it('omits both fields when nothing is pinned so collection YAML stays unchanged', () => {
    expect(normalizeCollectionEnvironmentPins({ environmentIds: [], defaultEnvironmentId: 'pay-dev' })).toEqual({});
    const collection = normalizeCollection({ id: 'c', name: 'Core' }, 'ws');
    expect('environmentIds' in collection).toBe(false);
    expect('defaultEnvironmentId' in collection).toBe(false);
  });

  it('survives collection normalization', () => {
    const collection = normalizeCollection({ id: 'c', name: 'Payment API', environmentIds: ['pay-dev', 'pay-stage'], defaultEnvironmentId: 'pay-stage' }, 'ws');
    expect(collection.environmentIds).toEqual(['pay-dev', 'pay-stage']);
    expect(collection.defaultEnvironmentId).toBe('pay-stage');
  });
});

describe('environmentMenuGroups', () => {
  it('lists every environment when the collection pins none', () => {
    expect(environmentMenuGroups({}, environments)).toEqual({ scoped: false, pinned: [], others: environments, defaultId: '' });
    expect(environmentMenuGroups(undefined, environments).scoped).toBe(false);
  });

  it('puts pinned environments first in pin order and the rest under others', () => {
    const groups = environmentMenuGroups({ environmentIds: ['pay-stage', 'pay-dev'] }, environments);
    expect(groups.scoped).toBe(true);
    expect(groups.pinned.map(environment => environment.id)).toEqual(['pay-stage', 'pay-dev']);
    expect(groups.others.map(environment => environment.id)).toEqual(['auth-dev']);
    expect(groups.defaultId).toBe('pay-stage');
  });

  it('ignores pins to environments that no longer exist', () => {
    expect(environmentMenuGroups({ environmentIds: ['gone'] }, environments).scoped).toBe(false);
    expect(defaultPinnedEnvironmentId({ environmentIds: ['gone', 'pay-dev'], defaultEnvironmentId: 'gone' }, environments)).toBe('pay-dev');
  });
});

describe('environmentForCollectionEntry', () => {
  const payment = { environmentIds: ['pay-dev', 'pay-stage'], defaultEnvironmentId: 'pay-stage' };

  it('switches to the default when the active environment belongs to another collection', () => {
    expect(environmentForCollectionEntry(payment, environments, 'auth-dev')).toBe('pay-stage');
    expect(environmentForCollectionEntry(payment, environments, '')).toBe('pay-stage');
  });

  it('keeps an active environment that is already pinned', () => {
    expect(environmentForCollectionEntry(payment, environments, 'pay-dev')).toBeNull();
  });

  it('leaves the selection alone for collections without pins', () => {
    expect(environmentForCollectionEntry({}, environments, 'auth-dev')).toBeNull();
  });
});

describe('withoutPinnedEnvironment', () => {
  it('drops a deleted environment and its default flag', () => {
    expect(withoutPinnedEnvironment({ environmentIds: ['pay-dev', 'pay-stage'], defaultEnvironmentId: 'pay-stage' }, 'pay-stage'))
      .toEqual({ environmentIds: ['pay-dev'] });
    expect(withoutPinnedEnvironment({ environmentIds: ['pay-dev'], defaultEnvironmentId: 'pay-dev' }, 'pay-dev')).toEqual({});
  });
});

describe('collection settings', () => {
  it('counts pins in the settings fingerprint so a pin change is a dirty form', () => {
    const base = normalizeCollection({ id: 'c', name: 'Payment API' }, 'ws');
    expect(collectionSettingsFingerprint({ ...base, environmentIds: ['pay-dev'] })).not.toBe(collectionSettingsFingerprint(base));
    expect(collectionSettingsFingerprint({ ...base, environmentIds: ['pay-dev'], defaultEnvironmentId: 'pay-dev' }))
      .not.toBe(collectionSettingsFingerprint({ ...base, environmentIds: ['pay-dev'] }));
  });

  it('saves pinned environments and clears them when the patch unpins everything', async () => {
    const collection: Collection = normalizeCollection({ id: 'c', workspaceId: 'ws', name: 'Payment API' }, 'ws');
    const host = {
      collections: [collection],
      collectionSettingsSavedTimer: null,
      collectionSettingsSaveState: 'idle',
      guardWorkspaceWritable: () => true,
      openAlertDialog: vi.fn(),
      persistRequestStore: vi.fn().mockResolvedValue(true),
    };
    await collectionFeature.saveCollectionSettings.call(host as never, 'c', {
      name: 'Payment API', description: '', defaults: collection.defaults,
      environmentIds: ['pay-dev', 'pay-stage'], defaultEnvironmentId: 'pay-stage',
    });
    expect(host.collections[0].environmentIds).toEqual(['pay-dev', 'pay-stage']);
    expect(host.collections[0].defaultEnvironmentId).toBe('pay-stage');

    await collectionFeature.saveCollectionSettings.call(host as never, 'c', {
      name: 'Payment API', description: '', defaults: collection.defaults,
      environmentIds: [], defaultEnvironmentId: '',
    });
    expect('environmentIds' in host.collections[0]).toBe(false);
    expect('defaultEnvironmentId' in host.collections[0]).toBe(false);
  });
});

describe('enterEnvironmentScope', () => {
  const payment: Collection = normalizeCollection({ id: 'payment', workspaceId: 'ws', name: 'Payment API', environmentIds: ['pay-dev', 'pay-stage'], defaultEnvironmentId: 'pay-stage' }, 'ws');
  const auth: Collection = normalizeCollection({ id: 'auth', workspaceId: 'ws', name: 'User Auth' }, 'ws');

  function makeHost(activeEnvironmentId: string) {
    const workspaceEnvironments = [...environments, env('notif-dev', 'Notification Dev')];
    const host = {
      activeEnvironmentId,
      environmentScopeKey: '',
      environmentScopePinnedIds: [] as string[],
      environmentOutsideScopeId: null as string | null,
      workspaceBlocked: false,
      environments: workspaceEnvironments,
      activeWorkspaceEnvironments: workspaceEnvironments,
      environmentToast: '',
      environmentToastTimer: null as ReturnType<typeof setTimeout> | null,
      selectEnvironment: vi.fn(async (id: string) => { host.activeEnvironmentId = id; }),
      showEnvironmentScopeToast(message: string) { environmentFeature.showEnvironmentScopeToast.call(host as never, message); },
    };
    return host;
  }

  it('selects the default pinned environment when you open a collection and says so', async () => {
    vi.useFakeTimers();
    const host = makeHost('auth-dev');
    await environmentFeature.enterEnvironmentScope.call(host as never, payment);
    expect(host.selectEnvironment).toHaveBeenCalledWith('pay-stage');
    expect(host.activeEnvironmentId).toBe('pay-stage');
    expect(host.environmentToast).toBe('Using Payment Staging for Payment API');
  });

  it('does not override a pick made inside the same collection', async () => {
    const host = makeHost('auth-dev');
    await environmentFeature.enterEnvironmentScope.call(host as never, payment);
    host.activeEnvironmentId = 'auth-dev';
    await environmentFeature.enterEnvironmentScope.call(host as never, payment);
    expect(host.selectEnvironment).toHaveBeenCalledTimes(1);
    expect(host.activeEnvironmentId).toBe('auth-dev');
  });

  it('re-checks after the pins change and leaves unpinned collections alone', async () => {
    const host = makeHost('auth-dev');
    await environmentFeature.enterEnvironmentScope.call(host as never, auth);
    expect(host.selectEnvironment).not.toHaveBeenCalled();
    await environmentFeature.enterEnvironmentScope.call(host as never, { ...auth, environmentIds: ['pay-dev'] });
    expect(host.selectEnvironment).toHaveBeenCalledWith('pay-dev');
  });

  it('restores the environment you had before when you leave for a collection without pins', async () => {
    vi.useFakeTimers();
    const host = makeHost('notif-dev');
    await environmentFeature.enterEnvironmentScope.call(host as never, payment);
    expect(host.activeEnvironmentId).toBe('pay-stage');
    await environmentFeature.enterEnvironmentScope.call(host as never, auth);
    expect(host.activeEnvironmentId).toBe('notif-dev');
    expect(host.environmentToast).toBe('Using Notification Dev again');
  });

  it('restores on leaving for a draft request too', async () => {
    const host = makeHost('notif-dev');
    await environmentFeature.enterEnvironmentScope.call(host as never, payment);
    await environmentFeature.enterEnvironmentScope.call(host as never, null);
    expect(host.activeEnvironmentId).toBe('notif-dev');
  });

  it('keeps the earliest outside environment across several pinned collections', async () => {
    const host = makeHost('notif-dev');
    const authPinned = { ...auth, environmentIds: ['auth-dev'] };
    await environmentFeature.enterEnvironmentScope.call(host as never, payment);
    await environmentFeature.enterEnvironmentScope.call(host as never, authPinned);
    expect(host.activeEnvironmentId).toBe('auth-dev');
    await environmentFeature.enterEnvironmentScope.call(host as never, { ...auth, id: 'scratch', name: 'Scratch' });
    expect(host.activeEnvironmentId).toBe('notif-dev');
  });

  it('keeps an environment you picked from other environments inside the collection', async () => {
    const host = makeHost('notif-dev');
    await environmentFeature.enterEnvironmentScope.call(host as never, payment);
    host.activeEnvironmentId = 'auth-dev';
    await environmentFeature.enterEnvironmentScope.call(host as never, auth);
    expect(host.activeEnvironmentId).toBe('auth-dev');
  });

  it('falls back to no environment when the remembered one was deleted', async () => {
    const host = makeHost('gone');
    await environmentFeature.enterEnvironmentScope.call(host as never, payment);
    await environmentFeature.enterEnvironmentScope.call(host as never, auth);
    expect(host.activeEnvironmentId).toBe('');
  });

  it('ignores views that are not a request or collection', async () => {
    const host = makeHost('notif-dev');
    await environmentFeature.enterEnvironmentScope.call(host as never, payment);
    await environmentFeature.enterEnvironmentScope.call(host as never, undefined);
    expect(host.activeEnvironmentId).toBe('pay-stage');
  });

  it('does nothing while the workspace is blocked', async () => {
    const host = { ...makeHost('auth-dev'), workspaceBlocked: true };
    await environmentFeature.enterEnvironmentScope.call(host as never, payment);
    expect(host.selectEnvironment).not.toHaveBeenCalled();
  });
});

describe('deleteEnvironment', () => {
  it('unpins the deleted environment from every collection', async () => {
    const host = {
      environments: [...environments],
      collections: [
        normalizeCollection({ id: 'payment', workspaceId: 'ws', name: 'Payment API', environmentIds: ['pay-dev', 'pay-stage'], defaultEnvironmentId: 'pay-stage' }, 'ws'),
        normalizeCollection({ id: 'auth', workspaceId: 'ws', name: 'User Auth', environmentIds: ['auth-dev'] }, 'ws'),
      ],
      activeEnvironmentId: 'pay-stage',
      topView: 'request',
      guardWorkspaceWritable: () => true,
      openConfirmDialog: vi.fn().mockResolvedValue(true),
      persistRequestStore: vi.fn().mockResolvedValue(true),
      trashEnvironment: vi.fn(),
      environmentBaselines: new Map(),
      changeEnvironmentsEverywhere(change: (environment: (typeof environments)[number]) => (typeof environments)[number]) {
        environmentFeature.changeEnvironmentsEverywhere.call(host as never, change);
      },
    };
    await environmentFeature.deleteEnvironment.call(host as never, 'pay-stage');
    expect(host.collections[0].environmentIds).toEqual(['pay-dev']);
    expect(host.collections[0].defaultEnvironmentId).toBeUndefined();
    expect(host.collections[1].environmentIds).toEqual(['auth-dev']);
    expect(host.activeEnvironmentId).toBe('');
  });
});
