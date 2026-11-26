import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPaletteCommands, filterPaletteCommands, type PaletteContext } from '../lib/commandPalette';
import {
  SECRET_PROVIDER_TYPES, joinCommand, secretKindAction, secretProviderState, secretProviderSummary, splitCommand,
} from '../lib/secretProviderTypes';
import { secretProviderLogo } from '../lib/secretProviderLogos';
import { browseSecretProvider } from '../lib/secretProvidersBackend';
import { variableDisplayValue } from '../lib/variables';
import type { SecretProviderView } from '../lib/wire';
import {
  checkAllSecretProviders, connectProvider, loadSecretProviders, saveSecretProviderConfig, secretProviderAttention, secretProviders,
} from '../lib/stores/secretProviders.svelte';

function provider(overrides: Partial<SecretProviderView> = {}): SecretProviderView {
  return {
    id: 'vault-prod', type: 'vault', name: 'Vault (prod)', valid: true, trusted: true, trustChanged: false,
    config: { id: 'vault-prod', type: 'vault', address: 'https://vault.example.com', namespace: 'team-a', auth: { method: 'approle', roleId: 'r' } },
    savedCredentials: [], usedBy: [], ...overrides,
  };
}

const host = globalThis as { window?: { go?: unknown } };
host.window ??= {};

afterEach(() => {
  delete host.window!.go;
});

describe('secret provider states', () => {
  it('maps provider and check results to one state', () => {
    expect(secretProviderState(provider({ valid: false }), undefined)).toBe('invalid');
    expect(secretProviderState(provider({ trusted: false }), { providerId: 'vault-prod', ok: true, durationMs: 1 })).toBe('untrusted');
    expect(secretProviderState(provider(), 'checking')).toBe('checking');
    expect(secretProviderState(provider(), undefined)).toBe('unknown');
    expect(secretProviderState(provider(), { providerId: 'vault-prod', ok: true, durationMs: 1 })).toBe('ok');
    expect(secretProviderState(provider({ type: 'env' }), { providerId: 'ci', ok: true, durationMs: 1 })).toBe('ready');
    expect(secretProviderState(provider(), { providerId: 'vault-prod', ok: false, kind: 'not_authenticated', durationMs: 1 })).toBe('signin');
    expect(secretProviderState(provider(), { providerId: 'vault-prod', ok: false, kind: 'tool_missing', durationMs: 1 })).toBe('nocli');
    expect(secretProviderState(provider(), { providerId: 'vault-prod', ok: false, kind: 'timeout', durationMs: 1 })).toBe('error');
  });

  it('offers the action that fixes each failure', () => {
    expect(secretKindAction('not_authenticated')).toBe('signin');
    expect(secretKindAction('untrusted')).toBe('trust');
    expect(secretKindAction('tool_missing')).toBe('install');
    expect(secretKindAction('forbidden')).toBe('open');
    expect(secretKindAction('not_found')).toBe('edit');
    expect(secretKindAction('invalid_ref')).toBe('edit');
    expect(secretKindAction('timeout')).toBe('retry');
  });

  it('summarises a provider without credentials', () => {
    expect(secretProviderSummary(provider())).toBe('HashiCorp Vault · vault.example.com · namespace team-a · AppRole');
    expect(secretProviderSummary(provider({ type: 'aws-ssm', config: { region: 'eu-central-1', profile: 'dev' } }))).toBe('AWS Parameter Store · eu-central-1 · profile dev');
    expect(secretProviderSummary(provider({ type: '1password', config: {} }))).toBe('1Password · default account · op CLI');
  });

  it('summarises the providers added in stage five', () => {
    expect(secretProviderSummary(provider({ type: 'gcp-secret-manager', config: { project: 'shop-prod' } }))).toBe('Google Secret Manager · shop-prod · default credentials');
    expect(secretProviderSummary(provider({ type: 'azure-key-vault', config: { address: 'https://team.vault.azure.net/', auth: { method: 'client-secret' } } }))).toBe('Azure Key Vault · team.vault.azure.net · client secret');
    expect(secretProviderSummary(provider({ type: 'bitwarden', config: {} }))).toBe('Bitwarden Secrets Manager · bitwarden.com · bws CLI');
    expect(secretProviderSummary(provider({ type: 'doppler', config: {} }))).toBe('Doppler · api.doppler.com');
    expect(secretProviderSummary(provider({ type: 'infisical', config: { project: 'p1', auth: { method: 'universal' } } }))).toBe('Infisical · app.infisical.com · project p1 · machine identity');
    expect(secretProviderSummary(provider({ type: 'command', config: { command: ['pass', 'show', '{path}'] } }))).toBe('Runs pass show {path}');
    expect(secretProviderSummary(provider({ config: { address: 'https://vault.example.com', auth: { method: 'oidc' } } }))).toBe('HashiCorp Vault · vault.example.com · OIDC');
    expect(secretProviderState(provider({ type: 'command' }), { providerId: 'pass', ok: true, durationMs: 1 })).toBe('ready');
  });

  it('has a logo or a monogram for every provider type', () => {
    expect(SECRET_PROVIDER_TYPES.map(item => item.type)).toEqual(['vault', '1password', 'aws-secrets-manager', 'aws-ssm', 'gcp-secret-manager', 'azure-key-vault', 'bitwarden', 'doppler', 'infisical', 'keepassxc', 'command', 'env']);
    for (const item of SECRET_PROVIDER_TYPES) {
      expect(Boolean(secretProviderLogo(item.type)) || item.monogram.length > 0).toBe(true);
    }
    expect(secretProviderLogo('bitwarden')?.mono).toBe(true);
    expect(secretProviderLogo('gcp-secret-manager')?.mono).toBe(false);
  });

  it('splits and joins a command without a shell', () => {
    expect(splitCommand('pass show {path}')).toEqual(['pass', 'show', '{path}']);
    expect(splitCommand(`"/Applications/My Tool/helper" get --name '{path}' ""`)).toEqual(['/Applications/My Tool/helper', 'get', '--name', '{path}', '']);
    expect(splitCommand('  ')).toEqual([]);
    const args = ['/opt/my tool', "it's", '', '{path}'];
    expect(splitCommand(joinCommand(args))).toEqual(args);
  });

  it('browses a provider through the bridge', async () => {
    const BrowseSecretProvider = vi.fn(async (_workspace: string, _id: string, prefix: string) => ({ ok: true, prefix, entries: [{ name: 'app', path: 'secret/data/app' }], durationMs: 3 }));
    host.window!.go = { api: { App: { BrowseSecretProvider } } };
    expect((await browseSecretProvider('ws-1', 'vault', 'secret/')).entries[0].path).toBe('secret/data/app');
    expect(BrowseSecretProvider).toHaveBeenCalledWith('ws-1', 'vault', 'secret/');
    delete host.window!.go;
    expect(await browseSecretProvider('ws-1', 'vault', '')).toMatchObject({ ok: false, kind: 'unavailable', entries: [] });
  });

  it('shows where a linked variable comes from instead of a mask', () => {
    expect(variableDisplayValue({ key: 'dbPassword', value: '', secret: true, linked: { provider: 'vault-prod', path: 'secret/data/app', field: 'password' } })).toBe('vault-prod · secret/data/app#password');
    expect(variableDisplayValue({ key: 'token', value: 'abc', secret: true })).toBe('••••••');
  });
});

describe('secret provider store', () => {
  it('loads providers, checks the trusted ones and counts what needs the user', async () => {
    const TestSecretProvider = vi.fn(async (_workspace: string, id: string) => (
      id === 'op' ? { providerId: id, ok: false, kind: 'not_authenticated', message: 'not signed in', durationMs: 3 } : { providerId: id, ok: true, durationMs: 2 }
    ));
    host.window!.go = { api: { App: {
      ListSecretProviders: vi.fn(async () => ({ cachedValues: 4, providers: [
        provider(),
        provider({ id: 'op', type: '1password', name: '1Password', config: {} }),
        provider({ id: 'aws', type: 'aws-secrets-manager', name: 'AWS', trusted: false, usedBy: [{ environmentId: 'e', environmentName: 'Prod', key: 'k', path: 'p' }] }),
      ] })),
      TestSecretProvider,
      SaveSecretProvider: vi.fn(async () => ({ ok: false, error: 'provider "x": region is required' })),
    } } };
    await loadSecretProviders('ws-1');
    await checkAllSecretProviders();
    expect(secretProviders.providers.map(item => item.id)).toEqual(['vault-prod', 'op', 'aws']);
    expect(secretProviders.cachedValues).toBe(4);
    expect(TestSecretProvider).toHaveBeenCalledTimes(2);
    expect(secretProviderAttention()).toEqual({ signin: 1, untrusted: 1 });
    expect(await saveSecretProviderConfig({ id: 'x', type: 'aws-ssm' })).toBe('provider "x": region is required');
  });
});

describe('KeePassXC provider', () => {
  it('is offered with an entry selector instead of a version', () => {
    const info = SECRET_PROVIDER_TYPES.find(item => item.type === 'keepassxc');
    expect(info).toMatchObject({ name: 'KeePassXC', versionLabel: 'Entry', browse: false });
    expect(info?.versionHint).not.toBe('');
    expect(secretProviderSummary(provider({ id: 'kp', type: 'keepassxc', config: { id: 'kp', type: 'keepassxc' } }))).toBe('KeePassXC · keepassxc-proxy');
  });

  it('connects through the app and checks the provider again', async () => {
    const ConnectSecretProvider = vi.fn(async (_workspace: string, id: string) => ({ providerId: id, ok: true, detail: 'Connected to KeePassXC as kurlo laptop', durationMs: 5 }));
    const TestSecretProvider = vi.fn(async (_workspace: string, id: string) => ({ providerId: id, ok: true, durationMs: 1 }));
    host.window!.go = { api: { App: {
      ListSecretProviders: vi.fn(async () => ({ cachedValues: 0, providers: [provider({ id: 'kp', type: 'keepassxc', config: { id: 'kp', type: 'keepassxc' }, savedCredentials: ['associationId', 'associationKey'] })] })),
      ConnectSecretProvider,
      TestSecretProvider,
    } } };
    await loadSecretProviders('ws-kp');
    expect(await connectProvider('kp')).toBe('');
    expect(ConnectSecretProvider).toHaveBeenCalledWith('ws-kp', 'kp');
    expect(TestSecretProvider).toHaveBeenCalledWith('ws-kp', 'kp');

    ConnectSecretProvider.mockResolvedValueOnce({ providerId: 'kp', ok: false, kind: 'forbidden', message: 'kp: the connection was not approved in KeePassXC', durationMs: 5 } as never);
    expect(await connectProvider('kp')).toBe('kp: the connection was not approved in KeePassXC');
  });
});

describe('palette', () => {
  it('lists secret commands only when the app provides them', () => {
    const base = { hasActiveRequest: true, canCopyCurl: true, autosave: false, codePanelAvailable: true, codePanelOpen: false, sidebarHidden: false, responseLayout: 'right', themeMode: 'system', whatsNewAvailable: false } as const;
    const fns = { showSidebarView: vi.fn(), openGlobals: vi.fn(), openCollectionRunner: vi.fn(), openMockServer: vi.fn(), openGit: vi.fn(), openCookies: vi.fn(), openSettings: vi.fn(), runShortcut: vi.fn(), createRequest: vi.fn(), createCollection: vi.fn(), createEnvironment: vi.fn(), importCollection: vi.fn(), copyCurl: vi.fn(), setResponseLayout: vi.fn(), setThemeMode: vi.fn(), showWhatsNew: vi.fn() };
    const without = buildPaletteCommands({ ...base, ...fns } as PaletteContext);
    expect(without.some(command => command.id.startsWith('secrets-'))).toBe(false);
    const refresh = vi.fn();
    const withSecrets = buildPaletteCommands({ ...base, ...fns, openSecretProviders: vi.fn(), addSecretProvider: vi.fn(), refreshSecrets: refresh, clearSecretCache: vi.fn() } as PaletteContext);
    const found = filterPaletteCommands(withSecrets, 'vault');
    expect(found.map(command => command.id)).toEqual(expect.arrayContaining(['go-secret-providers', 'secrets-refresh', 'secrets-clear-cache', 'create-secret-provider']));
    expect(withSecrets.filter(command => command.id.startsWith('secrets-')).map(command => command.group)).toEqual(['Secrets', 'Secrets']);
    withSecrets.find(command => command.id === 'secrets-refresh')?.run();
    expect(refresh).toHaveBeenCalled();
  });
});
