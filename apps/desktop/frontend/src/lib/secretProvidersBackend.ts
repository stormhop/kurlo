import type {
  SecretImportInput, SecretImportKeys, SecretImportKeysResult,
  SecretActionResult, SecretBrowseResult, SecretEnvExportResult, SecretProviderStatus, SecretProvidersResult, SecretRefInput, SecretRefTestResult, SecretRevealResult,
} from './wire';

const unavailable = 'Secret providers are available in the desktop app.';

function app() {
  return typeof window === 'undefined' ? undefined : window.go?.api?.App;
}

export async function listSecretProviders(workspaceId: string): Promise<SecretProvidersResult> {
  const bridge = app();
  if (!bridge?.ListSecretProviders) return { providers: [], cachedValues: 0 };
  return bridge.ListSecretProviders(workspaceId);
}

export async function saveSecretProvider(workspaceId: string, provider: Record<string, unknown>): Promise<SecretActionResult> {
  const bridge = app();
  if (!bridge?.SaveSecretProvider) return { ok: false, error: unavailable };
  return bridge.SaveSecretProvider(workspaceId, provider);
}

export async function deleteSecretProvider(workspaceId: string, providerId: string): Promise<SecretActionResult> {
  const bridge = app();
  if (!bridge?.DeleteSecretProvider) return { ok: false, error: unavailable };
  return bridge.DeleteSecretProvider(workspaceId, providerId);
}

export async function testSecretProvider(workspaceId: string, providerId: string): Promise<SecretProviderStatus> {
  const bridge = app();
  if (!bridge?.TestSecretProvider) return { providerId, ok: false, kind: 'unavailable', message: unavailable, durationMs: 0 };
  return bridge.TestSecretProvider(workspaceId, providerId);
}

export async function testSecretRef(workspaceId: string, ref: SecretRefInput): Promise<SecretRefTestResult> {
  const bridge = app();
  if (!bridge?.TestSecretRef) return { ok: false, kind: 'unavailable', message: unavailable, length: 0, fields: [], durationMs: 0 };
  return bridge.TestSecretRef(workspaceId, ref);
}

export async function revealSecretRef(workspaceId: string, ref: SecretRefInput): Promise<SecretRevealResult> {
  const bridge = app();
  if (!bridge?.RevealSecretRef) return { value: '', kind: 'unavailable', message: unavailable };
  return bridge.RevealSecretRef(workspaceId, ref);
}

export async function trustSecretProvider(workspaceId: string, providerId: string): Promise<SecretActionResult> {
  const bridge = app();
  if (!bridge?.TrustSecretProvider) return { ok: false, error: unavailable };
  return bridge.TrustSecretProvider(workspaceId, providerId);
}

export async function revokeSecretProviderTrust(workspaceId: string, providerId: string): Promise<SecretActionResult> {
  const bridge = app();
  if (!bridge?.RevokeSecretProviderTrust) return { ok: false, error: unavailable };
  return bridge.RevokeSecretProviderTrust(workspaceId, providerId);
}

export async function setSecretProviderCredential(workspaceId: string, providerId: string, name: string, value: string): Promise<SecretActionResult> {
  const bridge = app();
  if (!bridge?.SetSecretProviderCredential) return { ok: false, error: unavailable };
  return bridge.SetSecretProviderCredential(workspaceId, providerId, name, value);
}

export async function forgetSecretProviderCredentials(workspaceId: string, providerId: string): Promise<SecretActionResult> {
  const bridge = app();
  if (!bridge?.ForgetSecretProviderCredentials) return { ok: false, error: unavailable };
  return bridge.ForgetSecretProviderCredentials(workspaceId, providerId);
}

export async function clearSecretCache(): Promise<number> {
  const bridge = app();
  if (!bridge?.ClearSecretCache) return 0;
  return bridge.ClearSecretCache();
}

export async function listSecretImportKeys(workspaceId: string): Promise<SecretImportKeys[]> {
  const bridge = app();
  if (!bridge?.ListSecretImportKeys) return [];
  return bridge.ListSecretImportKeys(workspaceId);
}

export async function loadSecretImportKeys(workspaceId: string, input: SecretImportInput): Promise<SecretImportKeysResult> {
  const bridge = app();
  if (!bridge?.LoadSecretImportKeys) return { ok: false, kind: 'unavailable', message: unavailable, keys: [], loadedAt: 0, durationMs: 0 };
  return bridge.LoadSecretImportKeys(workspaceId, input);
}

export async function browseSecretProvider(workspaceId: string, providerId: string, prefix: string): Promise<SecretBrowseResult> {
  const bridge = app();
  if (!bridge?.BrowseSecretProvider) return { ok: false, kind: 'unavailable', message: unavailable, prefix, entries: [], durationMs: 0 };
  return bridge.BrowseSecretProvider(workspaceId, providerId, prefix);
}

export async function previewSecretProviderEnv(workspaceId: string, providerId: string): Promise<SecretEnvExportResult> {
  const bridge = app();
  if (!bridge?.PreviewSecretProviderEnv) return { ok: false, error: unavailable, variables: [] };
  return bridge.PreviewSecretProviderEnv(workspaceId, providerId);
}

export async function exportSecretProviderEnv(workspaceId: string, providerId: string): Promise<SecretEnvExportResult> {
  const bridge = app();
  if (!bridge?.ExportSecretProviderEnv) return { ok: false, error: unavailable, variables: [] };
  return bridge.ExportSecretProviderEnv(workspaceId, providerId);
}
