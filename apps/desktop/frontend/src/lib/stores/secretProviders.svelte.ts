import {
  clearSecretCache, deleteSecretProvider, forgetSecretProviderCredentials, listSecretProviders, revokeSecretProviderTrust,
  saveSecretProvider, setSecretProviderCredential, testSecretProvider, trustSecretProvider,
} from '../secretProvidersBackend';
import type { SecretProviderStatus, SecretProviderView } from '../wire';
import { secretProviderState, type SecretProviderType } from '../secretProviderTypes';

export type SecretProviderDraft = { type: SecretProviderType; isNew: boolean };

export const secretProviders = $state({
  workspaceId: '',
  providers: [] as SecretProviderView[],
  cachedValues: 0,
  loading: false,
  loaded: false,
  error: '',
  statuses: {} as Record<string, SecretProviderStatus | 'checking'>,
  selectedId: '',
  draft: null as SecretProviderDraft | null,
  addOpen: false,
  trustPromptId: '',
  notice: '',
});

let loadSeq = 0;
let checkedWorkspace = '';
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

export function showSecretNotice(text: string) {
  secretProviders.notice = text;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { secretProviders.notice = ''; }, 4000);
}

export async function loadSecretProviders(workspaceId: string, options: { check?: boolean } = {}) {
  if (!workspaceId) return;
  const seq = ++loadSeq;
  if (secretProviders.workspaceId !== workspaceId) {
    secretProviders.workspaceId = workspaceId;
    secretProviders.providers = [];
    secretProviders.statuses = {};
    secretProviders.selectedId = '';
    secretProviders.draft = null;
    secretProviders.loaded = false;
  }
  secretProviders.loading = true;
  try {
    const result = await listSecretProviders(workspaceId);
    if (seq !== loadSeq) return;
    secretProviders.providers = result.providers ?? [];
    secretProviders.cachedValues = result.cachedValues ?? 0;
    secretProviders.error = result.error ?? '';
    secretProviders.loaded = true;
    const ids = secretProviders.providers.map(provider => provider.id);
    secretProviders.statuses = Object.fromEntries(Object.entries(secretProviders.statuses).filter(([id]) => ids.includes(id)));
    if (secretProviders.selectedId && !ids.includes(secretProviders.selectedId) && !secretProviders.draft) secretProviders.selectedId = '';
  } finally {
    if (seq === loadSeq) secretProviders.loading = false;
  }
  if (options.check) await checkAllSecretProviders();
}

export async function checkSecretProvider(providerId: string) {
  const workspaceId = secretProviders.workspaceId;
  const provider = secretProviders.providers.find(item => item.id === providerId);
  if (!workspaceId || !provider?.valid || !provider.trusted) return;
  secretProviders.statuses = { ...secretProviders.statuses, [providerId]: 'checking' };
  const status = await testSecretProvider(workspaceId, providerId);
  if (secretProviders.workspaceId !== workspaceId) return;
  secretProviders.statuses = { ...secretProviders.statuses, [providerId]: status };
}

export async function ensureSecretProvidersChecked(workspaceId: string) {
  if (!workspaceId) return;
  if (secretProviders.workspaceId !== workspaceId || !secretProviders.loaded) await loadSecretProviders(workspaceId);
  if (checkedWorkspace === workspaceId) return;
  checkedWorkspace = workspaceId;
  await checkAllSecretProviders();
}

export async function checkAllSecretProviders() {
  await Promise.all(secretProviders.providers.filter(provider => provider.valid && provider.trusted).map(provider => checkSecretProvider(provider.id)));
}

export function secretProviderAttention() {
  let signin = 0;
  let untrusted = 0;
  for (const provider of secretProviders.providers) {
    const state = secretProviderState(provider, secretProviders.statuses[provider.id]);
    if (state === 'signin') signin += 1;
    if (state === 'untrusted' && providerInUse(provider)) untrusted += 1;
  }
  return { signin, untrusted };
}

export function providerInUse(provider: SecretProviderView) {
  return (provider.usedBy ?? []).length > 0;
}

export function selectSecretProvider(providerId: string) {
  secretProviders.draft = null;
  secretProviders.selectedId = providerId;
}

export function startSecretProviderDraft(type: SecretProviderType) {
  secretProviders.addOpen = false;
  secretProviders.selectedId = '';
  secretProviders.draft = { type, isNew: true };
}

export function cancelSecretProviderDraft() {
  secretProviders.draft = null;
}

async function afterAction(result: { ok: boolean; error?: string }, success: string) {
  if (!result.ok) return result.error || 'Something went wrong';
  if (success) showSecretNotice(success);
  await loadSecretProviders(secretProviders.workspaceId);
  return '';
}

export async function saveSecretProviderConfig(config: Record<string, unknown>) {
  const workspaceId = secretProviders.workspaceId;
  const result = await saveSecretProvider(workspaceId, config);
  const error = await afterAction(result, 'Provider saved');
  if (!error) {
    secretProviders.draft = null;
    secretProviders.selectedId = String(config.id ?? '');
    await checkSecretProvider(secretProviders.selectedId);
  }
  return error;
}

export async function removeSecretProvider(providerId: string) {
  const error = await afterAction(await deleteSecretProvider(secretProviders.workspaceId, providerId), 'Provider deleted');
  if (!error && secretProviders.selectedId === providerId) secretProviders.selectedId = '';
  return error;
}

export async function trustProvider(providerId: string) {
  const error = await afterAction(await trustSecretProvider(secretProviders.workspaceId, providerId), '');
  if (!error) {
    secretProviders.trustPromptId = '';
    await checkSecretProvider(providerId);
  }
  return error;
}

export async function revokeProviderTrust(providerId: string) {
  const error = await afterAction(await revokeSecretProviderTrust(secretProviders.workspaceId, providerId), 'Trust revoked on this device');
  const { [providerId]: _removed, ...rest } = secretProviders.statuses;
  secretProviders.statuses = rest;
  return error;
}

export async function saveProviderCredential(providerId: string, name: string, value: string) {
  const error = await afterAction(await setSecretProviderCredential(secretProviders.workspaceId, providerId, name, value), name === 'mfaCode' ? 'MFA code sent · used once for a one-hour session' : value ? 'Saved on this device' : 'Removed from this device');
  if (!error) await checkSecretProvider(providerId);
  return error;
}

export async function forgetProviderCredentials(providerId: string) {
  const error = await afterAction(await forgetSecretProviderCredentials(secretProviders.workspaceId, providerId), 'Credentials removed from this device');
  if (!error) await checkSecretProvider(providerId);
  return error;
}

export async function clearSecretValues() {
  const count = await clearSecretCache();
  secretProviders.cachedValues = 0;
  showSecretNotice(count === 1 ? 'Secret cache cleared · 1 value' : `Secret cache cleared · ${count} values`);
  return count;
}
