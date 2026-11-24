import type { Page } from '@playwright/test';

export type MockSecretProvider = {
  id: string;
  type: string;
  name?: string;
  config?: Record<string, unknown>;
  trusted?: boolean;
  savedCredentials?: string[];
};

export type MockSecretState = {
  providers: MockSecretProvider[];
  secrets: Record<string, Record<string, string>>;
  calls: string[];
};

declare global {
  interface Window {
    __kurloSecrets: MockSecretState;
  }
}

export async function installSecretProviderBridge(page: Page, initial: { providers?: MockSecretProvider[]; secrets?: Record<string, Record<string, string>> } = {}) {
  await page.addInitScript(({ providers, secrets }) => {
    const state: MockSecretState = { providers, secrets, calls: [] };
    window.__kurloSecrets = state;
    const key = (provider: string, path: string) => `${provider}:${path}`;
    const find = (id: string) => state.providers.find(provider => provider.id === id);
    const usedBy = (id: string) => {
      const store = window.__kurloE2E?.store as { environments?: Array<{ id: string; name: string; values?: Array<{ key: string; secretRef?: { provider: string; path: string; field?: string } }> }> } | undefined;
      return (store?.environments ?? []).flatMap(environment => (environment.values ?? [])
        .filter(row => row.secretRef?.provider === id)
        .map(row => ({ environmentId: environment.id, environmentName: environment.name, key: row.key, path: row.secretRef!.path, field: row.secretRef!.field })));
    };
    const view = (provider: MockSecretProvider) => ({
      id: provider.id,
      type: provider.type,
      name: provider.name ?? '',
      config: { id: provider.id, type: provider.type, ...(provider.name ? { name: provider.name } : {}), ...(provider.config ?? {}) },
      valid: true,
      trusted: provider.trusted ?? false,
      trustChanged: false,
      savedCredentials: provider.savedCredentials ?? [],
      usedBy: usedBy(provider.id),
    });
    const lookup = (provider: string, path: string, field?: string) => {
      const target = find(provider);
      if (!target) return { kind: 'invalid_ref', message: `no secret provider "${provider}"` };
      if (!target.trusted) return { kind: 'untrusted', message: `${provider} is not trusted on this device` };
      const secret = state.secrets[key(provider, path)];
      if (!secret) return { kind: 'not_found', message: `${path} was not found` };
      if (field && !(field in secret)) return { kind: 'field_missing', message: `${path} has no field ${field}` };
      return { secret, value: field ? secret[field] : Object.values(secret)[0] ?? '' };
    };
    const install = () => {
      const app = window.go?.api?.App as Record<string, unknown> | undefined;
      if (!app) return false;
      Object.assign(app, {
        ListSecretProviders: async () => ({ providers: state.providers.map(view), cachedValues: 0 }),
        SaveSecretProvider: async (_workspaceId: string, config: Record<string, unknown>) => {
          state.calls.push(`save:${JSON.stringify(config)}`);
          const { id, type, name, ...rest } = config as { id: string; type: string; name?: string };
          const existing = find(id);
          const next = { id, type, name, config: rest, trusted: true, savedCredentials: existing?.savedCredentials ?? [] };
          state.providers = existing ? state.providers.map(item => (item.id === id ? next : item)) : [...state.providers, next];
          return { ok: true };
        },
        DeleteSecretProvider: async (_workspaceId: string, id: string) => {
          state.calls.push(`delete:${id}`);
          state.providers = state.providers.filter(item => item.id !== id);
          return { ok: true };
        },
        TestSecretProvider: async (_workspaceId: string, id: string) => {
          state.calls.push(`test:${id}`);
          const provider = find(id);
          if (!provider?.trusted) return { providerId: id, ok: false, kind: 'untrusted', message: 'Not trusted on this device', durationMs: 3 };
          const detail = provider.type === 'vault' ? 'token valid' : provider.type.startsWith('aws') ? `Credentials from profile ${String(provider.config?.profile ?? 'default')}` : provider.type === '1password' ? 'Signed in with the op CLI' : 'Credentials found';
          return { providerId: id, ok: true, detail, ...(provider.type === 'vault' ? { policies: ['default', 'payments-read'], expiresInSeconds: 7200 } : {}), durationMs: 12 };
        },
        TestSecretRef: async (_workspaceId: string, ref: { provider: string; path: string; field?: string }) => {
          state.calls.push(`testRef:${ref.provider}:${ref.path}#${ref.field ?? ''}`);
          const found = lookup(ref.provider, ref.path, ref.field);
          if ('kind' in found) return { ok: false, kind: found.kind, message: found.message, length: 0, fields: [], durationMs: 4 };
          return { ok: true, length: found.value.length, fields: Object.keys(found.secret), durationMs: 9 };
        },
        RevealSecretRef: async (_workspaceId: string, ref: { provider: string; path: string; field?: string }) => {
          const found = lookup(ref.provider, ref.path, ref.field);
          return 'kind' in found ? { value: '', kind: found.kind, message: found.message } : { value: found.value };
        },
        TrustSecretProvider: async (_workspaceId: string, id: string) => {
          state.calls.push(`trust:${id}`);
          const provider = find(id);
          if (provider) provider.trusted = true;
          return { ok: true };
        },
        RevokeSecretProviderTrust: async (_workspaceId: string, id: string) => {
          state.calls.push(`revoke:${id}`);
          const provider = find(id);
          if (provider) provider.trusted = false;
          return { ok: true };
        },
        SetSecretProviderCredential: async (_workspaceId: string, id: string, name: string, value: string) => {
          state.calls.push(`credential:${id}:${name}:${value.length}`);
          const provider = find(id);
          if (provider && value && name !== 'mfaCode') provider.savedCredentials = [...new Set([...(provider.savedCredentials ?? []), name])];
          return { ok: true };
        },
        ForgetSecretProviderCredentials: async (_workspaceId: string, id: string) => {
          state.calls.push(`forget:${id}`);
          const provider = find(id);
          if (provider) provider.savedCredentials = [];
          return { ok: true };
        },
        ClearSecretCache: async () => {
          state.calls.push('clearCache');
          return 3;
        },
        BrowseSecretProvider: async (_workspaceId: string, id: string, prefix: string) => {
          state.calls.push(`browse:${id}:${prefix}`);
          const paths = Object.keys(state.secrets).filter(item => item.startsWith(`${id}:${prefix}`)).map(item => item.slice(id.length + 1));
          const entries = new Map<string, { name: string; path?: string; browse?: string }>();
          for (const path of paths) {
            const rest = path.slice(prefix.length);
            const slash = rest.indexOf('/');
            if (slash >= 0) entries.set(rest.slice(0, slash + 1), { name: rest.slice(0, slash + 1), browse: prefix + rest.slice(0, slash + 1) });
            else entries.set(rest, { name: rest, path });
          }
          return { ok: true, prefix, entries: [...entries.values()], durationMs: 7 };
        },
        PreviewSecretProviderEnv: async (_workspaceId: string, id: string) => {
          const provider = find(id);
          if (!provider || provider.type === 'env') return { ok: false, error: `${id} needs no credentials in CI`, variables: [] };
          const names = provider.type === 'vault' ? [{ name: 'VAULT_TOKEN', credential: 'token' }] : [{ name: 'AWS_ACCESS_KEY_ID', credential: 'accessKeyId' }, { name: 'AWS_SECRET_ACCESS_KEY', credential: 'secretAccessKey' }, { name: 'AWS_SESSION_TOKEN', credential: 'sessionToken' }];
          return { ok: true, variables: names.map(item => ({ ...item, saved: (provider.savedCredentials ?? []).includes(item.credential) })) };
        },
        ExportSecretProviderEnv: async (_workspaceId: string, id: string) => {
          state.calls.push(`exportEnv:${id}`);
          return { ok: true, path: `/Users/e2e/${id}.ci.env`, variables: [] };
        },
        ListSecretImportKeys: async () => [],
        LoadSecretImportKeys: async (_workspaceId: string, input: { provider: string; path: string; version?: string }) => {
          state.calls.push(`loadKeys:${input.provider}:${input.path}`);
          const found = lookup(input.provider, input.path);
          if ('kind' in found) return { ok: false, kind: found.kind, message: found.message, keys: [], loadedAt: 0, durationMs: 5 };
          return { ok: true, keys: Object.keys(found.secret), loadedAt: Date.now(), durationMs: 8 };
        },
      });
      return true;
    };
    if (!install()) {
      const timer = setInterval(() => { if (install()) clearInterval(timer); }, 0);
    }
  }, { providers: initial.providers ?? [], secrets: initial.secrets ?? {} });
}
