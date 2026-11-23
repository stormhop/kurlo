import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  vm: { topView: 'request' as string, activeWorkspaceId: 'ws', closeFloatingMenus: () => {} },
  lazy: { SecretProvidersWorkspaceComponent: null as unknown, resolve: null as null | (() => void), loadSecretProvidersWorkspace: null as unknown as () => Promise<void> },
  store: { addOpen: false, trustPromptId: '', selectedId: '' },
}));

vi.mock('../lib/stores/app.svelte', () => ({ vm: state.vm }));
vi.mock('../lib/stores/lazyComponents.svelte', () => ({ appLazyComponents: state.lazy }));
vi.mock('../lib/stores/secretProviders.svelte', () => ({
  secretProviders: state.store,
  selectSecretProvider: (id: string) => { state.store.selectedId = id; },
  loadSecretProviders: vi.fn(async () => {}),
}));

import { openAddSecretProvider, openSecretProviders } from '../lib/secretProvidersNav';

beforeEach(() => {
  state.vm.topView = 'environment';
  state.store.addOpen = false;
  state.lazy.SecretProvidersWorkspaceComponent = null;
  state.lazy.loadSecretProvidersWorkspace = vi.fn(() => new Promise<void>(resolve => {
    state.lazy.resolve = () => { state.lazy.SecretProvidersWorkspaceComponent = {}; resolve(); };
  }));
});

describe('secret providers navigation', () => {
  it('keeps the current view until the secret providers page has loaded', async () => {
    openAddSecretProvider();
    expect(state.vm.topView).toBe('environment');
    expect(state.store.addOpen).toBe(true);
    state.lazy.resolve?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.vm.topView).toBe('secrets');
  });

  it('switches at once when the page is already loaded', () => {
    state.lazy.SecretProvidersWorkspaceComponent = {};
    openSecretProviders();
    expect(state.vm.topView).toBe('secrets');
    expect(state.lazy.loadSecretProvidersWorkspace).not.toHaveBeenCalled();
  });

  it('does not take over when the user moved on while the page loaded', async () => {
    openSecretProviders();
    state.vm.topView = 'history';
    state.lazy.resolve?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.vm.topView).toBe('history');
  });
});
