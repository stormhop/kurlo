import { vm } from './stores/app.svelte';
import { loadSecretProviders, secretProviders, selectSecretProvider } from './stores/secretProviders.svelte';

export function openSecretProviders(providerId = '') {
  vm.closeFloatingMenus();
  selectSecretProvider(providerId);
  vm.topView = 'secrets';
  void loadSecretProviders(vm.activeWorkspaceId, { check: true });
}

export function openSecretProviderTrust(providerId: string) {
  openSecretProviders(providerId);
  secretProviders.trustPromptId = providerId;
}

export function openAddSecretProvider() {
  openSecretProviders();
  secretProviders.addOpen = true;
}
