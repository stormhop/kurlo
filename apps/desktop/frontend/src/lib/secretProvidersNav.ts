import { vm } from './stores/app.svelte';
import { appLazyComponents } from './stores/lazyComponents.svelte';
import { loadSecretProviders, secretProviders, selectSecretProvider } from './stores/secretProviders.svelte';

let openToken = 0;

function showSecretProviders() {
  vm.topView = 'secrets';
  void loadSecretProviders(vm.activeWorkspaceId, { check: true });
}

export function openSecretProviders(providerId = '') {
  vm.closeFloatingMenus();
  selectSecretProvider(providerId);
  const token = ++openToken;
  const fromView = vm.topView;
  if (appLazyComponents.SecretProvidersWorkspaceComponent) {
    showSecretProviders();
    return;
  }
  void appLazyComponents.loadSecretProvidersWorkspace().then(() => {
    if (token === openToken && vm.topView === fromView) showSecretProviders();
  });
}

export function openSecretProviderTrust(providerId: string) {
  openSecretProviders(providerId);
  secretProviders.trustPromptId = providerId;
}

export function openAddSecretProvider() {
  openSecretProviders();
  secretProviders.addOpen = true;
}
