<script lang="ts">
  import MenuIcon from './MenuIcon.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import SecretStatusPill from './SecretStatusPill.svelte';
  import SecretProviderDeleteModal from './SecretProviderDeleteModal.svelte';
  import SecretProviderEnvExportModal from './SecretProviderEnvExportModal.svelte';
  import { openExternalURL } from '../externalLinks';
  import {
    SECRET_TOOL_INSTALL_URLS, commandList, joinCommand, secretProviderState, secretProviderTypeInfo, splitCommand, type SecretProviderType,
  } from '../secretProviderTypes';
  import {
    cancelSecretProviderDraft, checkSecretProvider, connectProvider, forgetProviderCredentials, removeSecretProvider, revokeProviderTrust,
    saveProviderCredential, saveSecretProviderConfig, secretProviders,
  } from '../stores/secretProviders.svelte';
  import { secretCredentialProblem, validateSecretProviderDraft, type SecretProviderDraft, type SecretProviderDraftErrors } from '../secretProviderValidation';
  import type { SecretProviderView } from '../wire';

  let {
    provider,
    type,
    onOpenEnvironment,
  }: {
    provider?: SecretProviderView;
    type: SecretProviderType;
    onOpenEnvironment: (environmentId: string) => void;
  } = $props();

  type Draft = SecretProviderDraft;

  const AUTH_METHODS: Partial<Record<SecretProviderType, { value: string; label: string; desc: string }[]>> = {
    vault: [
      { value: 'token', label: 'Token', desc: 'Kurlo uses a token saved on this device, then VAULT_TOKEN, then ~/.vault-token.' },
      { value: 'approle', label: 'AppRole', desc: 'Kurlo logs in with the role ID below and a secret_id from this device or VAULT_SECRET_ID.' },
      { value: 'kubernetes', label: 'Kubernetes', desc: 'Kurlo logs in with the service account token of the pod it runs in. For the CLI in a cluster.' },
      { value: 'oidc', label: 'OIDC', desc: 'Kurlo opens your browser to sign in with your identity provider. The token stays in memory until Kurlo quits.' },
      { value: 'ldap', label: 'LDAP', desc: 'Kurlo logs in with your directory user name and a password from this device or VAULT_PASSWORD.' },
      { value: 'userpass', label: 'Userpass', desc: 'Kurlo logs in with a Vault user name and a password from this device or VAULT_PASSWORD.' },
    ],
    'azure-key-vault': [
      { value: 'cli', label: 'Azure CLI', desc: 'Kurlo asks az for a token. Run az login once on this computer.' },
      { value: 'client-secret', label: 'Client secret', desc: 'Kurlo signs in as an app registration with a secret from this device or AZURE_CLIENT_SECRET.' },
    ],
    infisical: [
      { value: 'token', label: 'Token', desc: 'Kurlo uses a token saved on this device, then INFISICAL_TOKEN.' },
      { value: 'universal', label: 'Machine identity', desc: 'Kurlo logs in with the client ID below and a client secret from this device or INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET.' },
    ],
  };

  const CACHE_OPTIONS = [{ value: '1m', label: '1 min' }, { value: '5m', label: '5 min' }, { value: '15m', label: '15 min' }, { value: 'session', label: 'Session' }, { value: 'custom', label: 'Custom' }];
  const CACHE_PRESETS = new Set(['1m', '5m', '15m', 'session']);

  function text(config: Record<string, unknown>, key: string) {
    const value = config[key];
    return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  }

  function draftFrom(source: SecretProviderView | undefined, providerType: SecretProviderType): Draft {
    const config = (source?.config ?? {}) as Record<string, unknown>;
    const auth = (config.auth ?? {}) as Record<string, unknown>;
    const info = secretProviderTypeInfo(providerType);
    const taken = new Set(secretProviders.providers.map(item => item.id));
    let id = info?.idSuggestion ?? 'secrets';
    for (let n = 2; !source && taken.has(id); n += 1) id = `${info?.idSuggestion ?? 'secrets'}-${n}`;
    return {
      id: source?.id ?? id,
      name: text(config, 'name'),
      address: text(config, 'address'),
      namespace: text(config, 'namespace'),
      authMethod: typeof auth.method === 'string' && auth.method ? auth.method : (AUTH_METHODS[providerType]?.[0]?.value ?? ''),
      roleId: typeof auth.roleId === 'string' ? auth.roleId : '',
      role: typeof auth.role === 'string' ? auth.role : '',
      mount: typeof auth.mount === 'string' ? auth.mount : '',
      tokenPath: typeof auth.tokenPath === 'string' ? auth.tokenPath : '',
      redirectUri: typeof auth.redirectUri === 'string' ? auth.redirectUri : '',
      tenantId: typeof auth.tenantId === 'string' ? auth.tenantId : '',
      clientId: typeof auth.clientId === 'string' ? auth.clientId : '',
      username: typeof auth.username === 'string' ? auth.username : '',
      roleArn: text(config, 'roleArn'),
      externalId: text(config, 'externalId'),
      mfaSerial: text(config, 'mfaSerial'),
      project: text(config, 'project'),
      command: joinCommand(commandList(config.command)),
      caCert: text(config, 'caCert'),
      verifyTls: config.skipTlsVerify !== true,
      account: text(config, 'account'),
      region: text(config, 'region'),
      profile: text(config, 'profile'),
      endpoint: text(config, 'endpoint'),
      cacheTtl: text(config, 'cacheTtl') || '5m',
      timeout: text(config, 'timeout'),
    };
  }

  let error = $state('');
  let saving = $state(false);
  let confirmDelete = $state(false);
  let deleting = $state(false);
  let moreMenuOpen = $state(false);
  let exportingEnv = $state(false);
  let connecting = $state(false);
  let connectError = $state('');
  let credentialDraft = $state<Record<string, string>>({});
  let draft = $state<Draft>(draftFrom(undefined, 'env'));
  let baseline = $state('');
  let touched = $state(new Set<keyof Draft>());
  let submitted = $state(false);
  let draftKey = '';
  $effect(() => {
    const key = `${provider?.id ?? 'new'}:${type}:${JSON.stringify(provider?.config ?? {})}`;
    if (key === draftKey) return;
    draftKey = key;
    draft = draftFrom(provider, type);
    baseline = JSON.stringify(draft);
    error = '';
    confirmDelete = false;
    touched = new Set();
    submitted = false;
  });


  const info = $derived(secretProviderTypeInfo(type));
  const isNew = $derived(!provider);
  const dirty = $derived(isNew || JSON.stringify(draft) !== baseline);
  const status = $derived(provider ? secretProviders.statuses[provider.id] : undefined);
  const providerState = $derived(provider ? secretProviderState(provider, status) : 'unknown');
  const statusResult = $derived(status && status !== 'checking' ? status : undefined);
  const fieldErrors: SecretProviderDraftErrors = $derived(validateSecretProviderDraft(draft, type, {
    isNew,
    takenIds: secretProviders.providers.map(item => item.id),
  }));
  const invalid = $derived(Object.keys(fieldErrors).length > 0);
  const customCache = $derived(!CACHE_PRESETS.has(draft.cacheTtl));

  function shown(key: keyof Draft) {
    return submitted || touched.has(key) ? (fieldErrors[key] ?? '') : '';
  }

  function touch(key: keyof Draft) {
    if (!touched.has(key)) touched = new Set([...touched, key]);
  }

  function credentialProblem(name: string) {
    return secretCredentialProblem(name, credentialDraft[name] ?? '');
  }

  const credentialFields = $derived.by(() => {
    switch (type) {
      case 'vault':
        if (draft.authMethod === 'approle') return [{ name: 'secretId', label: 'AppRole secret_id', hint: 'Used when VAULT_SECRET_ID is not set.' }];
        if (draft.authMethod === 'token') return [{ name: 'token', label: 'Token', hint: 'Used before VAULT_TOKEN and ~/.vault-token.' }];
        if (draft.authMethod === 'ldap' || draft.authMethod === 'userpass') {
          return [
            ...(draft.username.trim() ? [] : [{ name: 'username', label: 'User name', hint: 'Your own user name. Used before VAULT_USERNAME.' }]),
            { name: 'password', label: 'Password', hint: 'Used before VAULT_PASSWORD.' },
          ];
        }
        return [];
      case 'gcp-secret-manager':
        return [{ name: 'serviceAccountKey', label: 'Service account key', hint: 'Optional. Paste the JSON key. Without it, Kurlo uses GOOGLE_APPLICATION_CREDENTIALS, application default credentials, then gcloud.' }];
      case 'azure-key-vault':
        return draft.authMethod === 'client-secret' ? [{ name: 'clientSecret', label: 'Client secret', hint: 'Used before AZURE_CLIENT_SECRET.' }] : [];
      case 'bitwarden':
        return [{ name: 'token', label: 'Machine account access token', hint: 'Used before BWS_ACCESS_TOKEN.' }];
      case 'doppler':
        return [{ name: 'token', label: 'Token', hint: 'A service or personal token. Used before DOPPLER_TOKEN and the doppler CLI sign-in.' }];
      case 'infisical':
        return draft.authMethod === 'universal'
          ? [{ name: 'clientSecret', label: 'Client secret', hint: 'Used before INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET.' }]
          : [{ name: 'token', label: 'Token', hint: 'Used before INFISICAL_TOKEN.' }];
      case '1password':
        return [{ name: 'token', label: 'Service account token', hint: 'Optional. Without it, op uses the 1Password app on this computer.' }];
      case 'aws-secrets-manager':
      case 'aws-ssm':
        return [
          { name: 'accessKeyId', label: 'Access key ID', hint: 'Optional. Without keys, Kurlo uses the profile or AWS_* variables.' },
          { name: 'secretAccessKey', label: 'Secret access key', hint: '' },
          { name: 'sessionToken', label: 'Session token', hint: 'Only for temporary keys.' },
          ...(draft.mfaSerial.trim() ? [{ name: 'mfaCode', label: 'MFA code', hint: 'Six digits from your MFA device. Used once to start a one-hour role session and never saved.' }] : []),
        ];
      default:
        return [];
    }
  });

  function configFromDraft(): Record<string, unknown> {
    const config: Record<string, unknown> = { id: draft.id.trim(), type };
    const set = (key: string, value: string) => { if (value.trim()) config[key] = value.trim(); };
    set('name', draft.name);
    if (type === 'vault') {
      set('address', draft.address);
      set('namespace', draft.namespace);
      set('caCert', draft.caCert);
      if (!draft.verifyTls) config.skipTlsVerify = true;
      const auth: Record<string, string> = { method: draft.authMethod };
      const put = (key: string, value: string) => { if (value.trim()) auth[key] = value.trim(); };
      if (draft.authMethod === 'approle') put('roleId', draft.roleId);
      if (draft.authMethod === 'kubernetes' || draft.authMethod === 'oidc') put('role', draft.role);
      if (draft.authMethod !== 'token') put('mount', draft.mount);
      if (draft.authMethod === 'kubernetes') put('tokenPath', draft.tokenPath);
      if (draft.authMethod === 'oidc') put('redirectUri', draft.redirectUri);
      if (draft.authMethod === 'ldap' || draft.authMethod === 'userpass') put('username', draft.username);
      config.auth = auth;
    }
    if (type === 'gcp-secret-manager') {
      set('project', draft.project);
      set('endpoint', draft.endpoint);
    }
    if (type === 'azure-key-vault') {
      set('address', draft.address);
      const auth: Record<string, string> = { method: draft.authMethod };
      if (draft.tenantId.trim()) auth.tenantId = draft.tenantId.trim();
      if (draft.authMethod === 'client-secret' && draft.clientId.trim()) auth.clientId = draft.clientId.trim();
      config.auth = auth;
    }
    if (type === 'bitwarden' || type === 'doppler') set('address', draft.address);
    if (type === 'infisical') {
      set('address', draft.address);
      set('project', draft.project);
      const auth: Record<string, string> = { method: draft.authMethod };
      if (draft.authMethod === 'universal' && draft.clientId.trim()) auth.clientId = draft.clientId.trim();
      config.auth = auth;
    }
    if (type === 'command') {
      const args = splitCommand(draft.command);
      if (args.length) config.command = args;
    }
    if (type === '1password') set('account', draft.account);
    if (type === 'aws-secrets-manager' || type === 'aws-ssm') {
      set('region', draft.region);
      set('profile', draft.profile);
      set('endpoint', draft.endpoint);
      set('roleArn', draft.roleArn);
      if (draft.roleArn.trim()) set('externalId', draft.externalId);
      set('mfaSerial', draft.mfaSerial);
    }
    const cacheTtl = draft.cacheTtl.trim();
    if (cacheTtl && cacheTtl !== '5m') config.cacheTtl = cacheTtl;
    set('timeout', draft.timeout);
    return config;
  }

  async function save() {
    if (invalid) {
      submitted = true;
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.secret-provider-form [aria-invalid="true"]')?.focus());
      return;
    }
    saving = true;
    error = await saveSecretProviderConfig(configFromDraft());
    saving = false;
  }

  async function connect() {
    if (!provider) return;
    connecting = true;
    connectError = await connectProvider(provider.id);
    connecting = false;
  }

  async function remove() {
    if (!provider) return;
    deleting = true;
    error = await removeSecretProvider(provider.id);
    deleting = false;
    confirmDelete = false;
  }

  function runMenuAction(action: () => unknown) {
    moreMenuOpen = false;
    void action();
  }

  function closeMoreMenuOnFocusOut(event: FocusEvent) {
    const current = event.currentTarget;
    const next = event.relatedTarget;
    if (!(current instanceof HTMLElement) || next === null) return;
    if (next instanceof Node && current.contains(next)) return;
    moreMenuOpen = false;
  }

  async function saveCredential(name: string) {
    if (!provider || credentialProblem(name)) return;
    error = await saveProviderCredential(provider.id, name, credentialDraft[name] ?? '');
    if (!error) credentialDraft = { ...credentialDraft, [name]: '' };
  }

  function inputValue(event: Event) {
    return event.currentTarget instanceof HTMLInputElement ? event.currentTarget.value : '';
  }

  function connectedDetail(result: { detail?: string; expiresInSeconds?: number; policies?: string[]; durationMs: number }) {
    return [
      result.detail,
      result.expiresInSeconds ? `valid for ${durationLabel(result.expiresInSeconds)}` : '',
      result.policies?.length ? `policies ${result.policies.join(', ')}` : '',
      `${result.durationMs} ms`,
    ].filter(Boolean).join(' · ');
  }

  function durationLabel(seconds: number) {
    if (seconds <= 0) return '';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours ? `${hours} h ${minutes} min` : `${minutes} min`;
  }
</script>

<div class="secret-provider-form">
  <div class="secret-page-head">
    <div class="secret-page-title">
      <h1><ProviderLogo {type} size="lg" /><span>{isNew ? `New ${info?.name ?? 'provider'}` : provider?.name || provider?.id}</span>{#if provider}<SecretStatusPill state={providerState} />{/if}</h1>
      <p>{info?.name} · {isNew ? 'saved to workspace.yml when you click Save' : 'saved in workspace.yml'}</p>
    </div>
    <div class="overview-actions">
      {#if isNew}
        <button class="btn btn-secondary" type="button" onclick={cancelSecretProviderDraft}>Cancel</button>
      {/if}
      <button class="btn btn-secondary" type="button" onclick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save'}</button>
      {#if provider}
        <button class="btn btn-primary" type="button" onclick={() => checkSecretProvider(provider.id)} disabled={!provider.trusted || status === 'checking' || dirty}>Test connection</button>
        <div class="env-more" onfocusout={closeMoreMenuOnFocusOut}>
          <button class="btn btn-ghost btn-icon env-more-btn" type="button" aria-label="More provider actions" aria-haspopup="menu" aria-expanded={moreMenuOpen} onclick={() => (moreMenuOpen = !moreMenuOpen)}>•••</button>
          {#if moreMenuOpen}
            <div class="menu request-menu env-more-menu" role="menu">
              <button class="menu-item" type="button" role="menuitem" onclick={() => runMenuAction(() => (exportingEnv = true))} disabled={dirty}><MenuIcon name="export" />Export for CI…</button>
              <div class="menu-separator" role="separator"></div>
              <button class="menu-item danger" type="button" role="menuitem" onclick={() => runMenuAction(() => (confirmDelete = true))}><MenuIcon name="trash" />Delete provider</button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  {#if error}
    <div class="secret-banner secret-banner-error" role="alert"><MenuIcon name="warning" /><span>{error}</span></div>
  {/if}
  {#if provider && !provider.valid}
    <div class="secret-banner secret-banner-error" role="alert"><MenuIcon name="warning" /><span>{provider.problem}</span></div>
  {:else if statusResult}
    <div class="secret-banner" class:secret-banner-ok={statusResult.ok} class:secret-banner-error={!statusResult.ok} role="status">
      <MenuIcon name={statusResult.ok ? 'shield' : 'warning'} />
      <span>
        {#if statusResult.ok}
          <strong>Connected.</strong>
          {connectedDetail(statusResult)}
        {:else}
          <strong>{statusResult.kind === 'not_authenticated' ? (type === 'keepassxc' ? 'Not connected.' : 'Sign in required.') : statusResult.kind === 'tool_missing' ? 'CLI not installed.' : 'Not connected.'}</strong> {statusResult.message}
        {/if}
      </span>
      {#if statusResult.kind === 'tool_missing' && SECRET_TOOL_INSTALL_URLS[type]}
        <button class="btn btn-ghost btn-sm" type="button" onclick={() => openExternalURL(SECRET_TOOL_INSTALL_URLS[type])}>How to install</button>
      {/if}
    </div>
  {/if}

  <section class="settings-block">
    <h4 class="settings-group-label">Connection</h4>
    <div class="settings-group">
      <div class="settings-row">
        <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-name">Name</label><span class="settings-row-desc">Shown in Kurlo only.</span></div>
        <div class="settings-row-control"><input id="secret-provider-name" class="field secret-input" placeholder={info?.name} value={draft.name} oninput={(event) => (draft.name = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('name'))} aria-describedby={shown('name') ? 'secret-provider-name-error' : undefined} onblur={() => touch('name')} />{#if shown('name')}<span id="secret-provider-name-error" class="secret-field-error" role="alert">{shown('name')}</span>{/if}</div>
      </div>
      <div class="settings-row">
        <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-id">ID</label><span class="settings-row-desc">{isNew ? 'Environment files refer to the provider by this ID. It cannot be changed later.' : 'Environment files refer to the provider by this ID.'}</span></div>
        <div class="settings-row-control"><input id="secret-provider-id" class="field field-mono secret-input" value={draft.id} readonly={!isNew} oninput={(event) => (draft.id = inputValue(event).toLowerCase())} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('id'))} aria-describedby={shown('id') ? 'secret-provider-id-error' : undefined} onblur={() => touch('id')} />{#if shown('id')}<span id="secret-provider-id-error" class="secret-field-error" role="alert">{shown('id')}</span>{/if}</div>
      </div>
      {#if type === 'vault'}
        <div class="settings-row">
          <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-address">Address</label><span class="settings-row-desc">Vault server URL.</span></div>
          <div class="settings-row-control"><input id="secret-provider-address" class="field field-mono secret-input" placeholder="https://vault.example.com" value={draft.address} oninput={(event) => (draft.address = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('address'))} aria-describedby={shown('address') ? 'secret-provider-address-error' : undefined} onblur={() => touch('address')} />{#if shown('address')}<span id="secret-provider-address-error" class="secret-field-error" role="alert">{shown('address')}</span>{/if}</div>
        </div>
        <div class="settings-row">
          <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-namespace">Namespace</label><span class="settings-row-desc">Vault Enterprise and HCP only.</span></div>
          <div class="settings-row-control"><input id="secret-provider-namespace" class="field field-mono secret-input" value={draft.namespace} oninput={(event) => (draft.namespace = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('namespace'))} aria-describedby={shown('namespace') ? 'secret-provider-namespace-error' : undefined} onblur={() => touch('namespace')} />{#if shown('namespace')}<span id="secret-provider-namespace-error" class="secret-field-error" role="alert">{shown('namespace')}</span>{/if}</div>
        </div>
      {:else if type === '1password'}
        <div class="settings-row">
          <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-account">Account</label><span class="settings-row-desc">Needed only when op is signed in to several accounts.</span></div>
          <div class="settings-row-control"><input id="secret-provider-account" class="field field-mono secret-input" placeholder="my.1password.com" value={draft.account} oninput={(event) => (draft.account = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('account'))} aria-describedby={shown('account') ? 'secret-provider-account-error' : undefined} onblur={() => touch('account')} />{#if shown('account')}<span id="secret-provider-account-error" class="secret-field-error" role="alert">{shown('account')}</span>{/if}</div>
        </div>
      {:else if type === 'gcp-secret-manager'}
        <div class="settings-row">
          <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-project">Project</label><span class="settings-row-desc">Project ID or number. Secret names are looked up in it.</span></div>
          <div class="settings-row-control"><input id="secret-provider-project" class="field field-mono secret-input" placeholder="my-project" value={draft.project} oninput={(event) => (draft.project = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('project'))} aria-describedby={shown('project') ? 'secret-provider-project-error' : undefined} onblur={() => touch('project')} />{#if shown('project')}<span id="secret-provider-project-error" class="secret-field-error" role="alert">{shown('project')}</span>{/if}</div>
        </div>
        <div class="settings-row">
          <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-endpoint">Endpoint</label><span class="settings-row-desc">Only for a regional or Private Service Connect endpoint.</span></div>
          <div class="settings-row-control"><input id="secret-provider-endpoint" class="field field-mono secret-input" placeholder="https://secretmanager.googleapis.com" value={draft.endpoint} oninput={(event) => (draft.endpoint = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('endpoint'))} aria-describedby={shown('endpoint') ? 'secret-provider-endpoint-error' : undefined} onblur={() => touch('endpoint')} />{#if shown('endpoint')}<span id="secret-provider-endpoint-error" class="secret-field-error" role="alert">{shown('endpoint')}</span>{/if}</div>
        </div>
      {:else if type === 'azure-key-vault'}
        <div class="settings-row">
          <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-address">Vault URL</label><span class="settings-row-desc">From the Overview page of the key vault.</span></div>
          <div class="settings-row-control"><input id="secret-provider-address" class="field field-mono secret-input" placeholder="https://my-vault.vault.azure.net" value={draft.address} oninput={(event) => (draft.address = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('address'))} aria-describedby={shown('address') ? 'secret-provider-address-error' : undefined} onblur={() => touch('address')} />{#if shown('address')}<span id="secret-provider-address-error" class="secret-field-error" role="alert">{shown('address')}</span>{/if}</div>
        </div>
      {:else if type === 'bitwarden' || type === 'doppler' || type === 'infisical'}
        <div class="settings-row">
          <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-address">Server</label><span class="settings-row-desc">{type === 'bitwarden' ? 'Only for the EU cloud or a self-hosted server.' : type === 'infisical' ? 'Only for the EU cloud or a self-hosted instance.' : 'Only for a proxy in front of the Doppler API.'}</span></div>
          <div class="settings-row-control"><input id="secret-provider-address" class="field field-mono secret-input" placeholder={type === 'bitwarden' ? 'https://vault.bitwarden.eu' : type === 'infisical' ? 'https://app.infisical.com' : 'https://api.doppler.com'} value={draft.address} oninput={(event) => (draft.address = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('address'))} aria-describedby={shown('address') ? 'secret-provider-address-error' : undefined} onblur={() => touch('address')} />{#if shown('address')}<span id="secret-provider-address-error" class="secret-field-error" role="alert">{shown('address')}</span>{/if}</div>
        </div>
        {#if type === 'infisical'}
          <div class="settings-row">
            <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-project">Project ID</label><span class="settings-row-desc">From the project settings in Infisical.</span></div>
            <div class="settings-row-control"><input id="secret-provider-project" class="field field-mono secret-input" value={draft.project} oninput={(event) => (draft.project = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('project'))} aria-describedby={shown('project') ? 'secret-provider-project-error' : undefined} onblur={() => touch('project')} />{#if shown('project')}<span id="secret-provider-project-error" class="secret-field-error" role="alert">{shown('project')}</span>{/if}</div>
          </div>
        {/if}
      {:else if type === 'command'}
        <div class="settings-row">
          <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-command">Command</label><span class="settings-row-desc">Runs without a shell. {'{path}'} and {'{version}'} are replaced; without {'{path}'} the path goes last. Standard output is the value.</span></div>
          <div class="settings-row-control"><input id="secret-provider-command" class="field field-mono secret-input" placeholder={'pass show {path}'} value={draft.command} oninput={(event) => (draft.command = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('command'))} aria-describedby={shown('command') ? 'secret-provider-command-error' : undefined} onblur={() => touch('command')} />{#if shown('command')}<span id="secret-provider-command-error" class="secret-field-error" role="alert">{shown('command')}</span>{/if}</div>
        </div>
      {:else if type === 'aws-secrets-manager' || type === 'aws-ssm'}
        <div class="settings-row">
          <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-region">Region</label></div>
          <div class="settings-row-control"><input id="secret-provider-region" class="field field-mono secret-input" placeholder="eu-central-1" value={draft.region} oninput={(event) => (draft.region = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('region'))} aria-describedby={shown('region') ? 'secret-provider-region-error' : undefined} onblur={() => touch('region')} />{#if shown('region')}<span id="secret-provider-region-error" class="secret-field-error" role="alert">{shown('region')}</span>{/if}</div>
        </div>
        <div class="settings-row">
          <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-profile">Profile</label><span class="settings-row-desc">From ~/.aws/config. SSO profiles need the AWS CLI.</span></div>
          <div class="settings-row-control"><input id="secret-provider-profile" class="field field-mono secret-input" placeholder="default" value={draft.profile} oninput={(event) => (draft.profile = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('profile'))} aria-describedby={shown('profile') ? 'secret-provider-profile-error' : undefined} onblur={() => touch('profile')} />{#if shown('profile')}<span id="secret-provider-profile-error" class="secret-field-error" role="alert">{shown('profile')}</span>{/if}</div>
        </div>
        <div class="settings-row">
          <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-endpoint">Endpoint</label><span class="settings-row-desc">Only for a VPC endpoint or LocalStack.</span></div>
          <div class="settings-row-control"><input id="secret-provider-endpoint" class="field field-mono secret-input" placeholder="https://localhost:4566" value={draft.endpoint} oninput={(event) => (draft.endpoint = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('endpoint'))} aria-describedby={shown('endpoint') ? 'secret-provider-endpoint-error' : undefined} onblur={() => touch('endpoint')} />{#if shown('endpoint')}<span id="secret-provider-endpoint-error" class="secret-field-error" role="alert">{shown('endpoint')}</span>{/if}</div>
        </div>
        <div class="settings-row">
          <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-role-arn">Role ARN</label><span class="settings-row-desc">Optional. Kurlo assumes this role with your credentials, like AWS_ROLE_ARN.</span></div>
          <div class="settings-row-control"><input id="secret-provider-role-arn" class="field field-mono secret-input" placeholder="arn:aws:iam::123456789012:role/name" value={draft.roleArn} oninput={(event) => (draft.roleArn = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('roleArn'))} aria-describedby={shown('roleArn') ? 'secret-provider-role-arn-error' : undefined} onblur={() => touch('roleArn')} />{#if shown('roleArn')}<span id="secret-provider-role-arn-error" class="secret-field-error" role="alert">{shown('roleArn')}</span>{/if}</div>
        </div>
        {#if draft.roleArn.trim()}
        <div class="settings-row">
          <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-external-id">External ID</label><span class="settings-row-desc">Only if the role trust policy asks for one.</span></div>
          <div class="settings-row-control"><input id="secret-provider-external-id" class="field field-mono secret-input" value={draft.externalId} oninput={(event) => (draft.externalId = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('externalId'))} aria-describedby={shown('externalId') ? 'secret-provider-external-id-error' : undefined} onblur={() => touch('externalId')} />{#if shown('externalId')}<span id="secret-provider-external-id-error" class="secret-field-error" role="alert">{shown('externalId')}</span>{/if}</div>
        </div>
        {/if}
        <div class="settings-row">
          <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-mfa-serial">MFA device</label><span class="settings-row-desc">Optional. ARN or serial of your MFA device. Kurlo asks for a code under On this device.</span></div>
          <div class="settings-row-control"><input id="secret-provider-mfa-serial" class="field field-mono secret-input" placeholder="arn:aws:iam::123456789012:mfa/name" value={draft.mfaSerial} oninput={(event) => (draft.mfaSerial = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('mfaSerial'))} aria-describedby={shown('mfaSerial') ? 'secret-provider-mfa-serial-error' : undefined} onblur={() => touch('mfaSerial')} />{#if shown('mfaSerial')}<span id="secret-provider-mfa-serial-error" class="secret-field-error" role="alert">{shown('mfaSerial')}</span>{/if}</div>
        </div>
      {/if}
    </div>
  </section>

  {#if type === 'vault'}
    <section class="settings-block">
      <h4 class="settings-group-label">Authentication</h4>
      <div class="settings-group">
        {@render authMethodRow()}
        {#if draft.authMethod === 'approle'}
          <div class="settings-row">
            <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-role">Role ID</label><span class="settings-row-desc">Not secret, saved in workspace.yml.</span></div>
            <div class="settings-row-control"><input id="secret-provider-role" class="field field-mono secret-input" value={draft.roleId} oninput={(event) => (draft.roleId = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('roleId'))} aria-describedby={shown('roleId') ? 'secret-provider-role-error' : undefined} onblur={() => touch('roleId')} />{#if shown('roleId')}<span id="secret-provider-role-error" class="secret-field-error" role="alert">{shown('roleId')}</span>{/if}</div>
          </div>
        {:else if draft.authMethod === 'kubernetes' || draft.authMethod === 'oidc'}
          <div class="settings-row">
            <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-role">Role</label><span class="settings-row-desc">{draft.authMethod === 'oidc' ? 'Optional. The default role of the mount is used without it.' : 'Vault role bound to the service account.'}</span></div>
            <div class="settings-row-control"><input id="secret-provider-role" class="field field-mono secret-input" value={draft.role} oninput={(event) => (draft.role = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('role'))} aria-describedby={shown('role') ? 'secret-provider-role-error' : undefined} onblur={() => touch('role')} />{#if shown('role')}<span id="secret-provider-role-error" class="secret-field-error" role="alert">{shown('role')}</span>{/if}</div>
          </div>
        {/if}
        {#if draft.authMethod !== 'token'}
          <div class="settings-row">
            <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-mount">Mount</label></div>
            <div class="settings-row-control"><input id="secret-provider-mount" class="field field-mono secret-input" placeholder={draft.authMethod} value={draft.mount} oninput={(event) => (draft.mount = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('mount'))} aria-describedby={shown('mount') ? 'secret-provider-mount-error' : undefined} onblur={() => touch('mount')} />{#if shown('mount')}<span id="secret-provider-mount-error" class="secret-field-error" role="alert">{shown('mount')}</span>{/if}</div>
          </div>
        {/if}
        {#if draft.authMethod === 'kubernetes'}
          <div class="settings-row">
            <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-token-path">Token file</label></div>
            <div class="settings-row-control"><input id="secret-provider-token-path" class="field field-mono secret-input" placeholder="/var/run/secrets/kubernetes.io/serviceaccount/token" value={draft.tokenPath} oninput={(event) => (draft.tokenPath = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('tokenPath'))} aria-describedby={shown('tokenPath') ? 'secret-provider-token-path-error' : undefined} onblur={() => touch('tokenPath')} />{#if shown('tokenPath')}<span id="secret-provider-token-path-error" class="secret-field-error" role="alert">{shown('tokenPath')}</span>{/if}</div>
          </div>
        {:else if draft.authMethod === 'oidc'}
          <div class="settings-row">
            <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-redirect">Redirect URI</label><span class="settings-row-desc">Must be in allowed_redirect_uris of the role.</span></div>
            <div class="settings-row-control"><input id="secret-provider-redirect" class="field field-mono secret-input" placeholder="http://localhost:8250/oidc/callback" value={draft.redirectUri} oninput={(event) => (draft.redirectUri = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('redirectUri'))} aria-describedby={shown('redirectUri') ? 'secret-provider-redirect-error' : undefined} onblur={() => touch('redirectUri')} />{#if shown('redirectUri')}<span id="secret-provider-redirect-error" class="secret-field-error" role="alert">{shown('redirectUri')}</span>{/if}</div>
          </div>
        {/if}
        {#if draft.authMethod === 'ldap' || draft.authMethod === 'userpass'}
        <div class="settings-row">
          <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-username">User name</label><span class="settings-row-desc">Optional. Leave it empty so each person saves their own under On this device.</span></div>
          <div class="settings-row-control"><input id="secret-provider-username" class="field field-mono secret-input" value={draft.username} oninput={(event) => (draft.username = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('username'))} aria-describedby={shown('username') ? 'secret-provider-username-error' : undefined} onblur={() => touch('username')} />{#if shown('username')}<span id="secret-provider-username-error" class="secret-field-error" role="alert">{shown('username')}</span>{/if}</div>
        </div>
        {/if}
      </div>
    </section>
    <section class="settings-block">
      <h4 class="settings-group-label">TLS</h4>
      <div class="settings-group">
        <div class="settings-row">
          <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-ca">CA certificate</label><span class="settings-row-desc">PEM file for a private certificate authority.</span></div>
          <div class="settings-row-control"><input id="secret-provider-ca" class="field field-mono secret-input" placeholder="/path/to/ca.pem" value={draft.caCert} oninput={(event) => (draft.caCert = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('caCert'))} aria-describedby={shown('caCert') ? 'secret-provider-ca-error' : undefined} onblur={() => touch('caCert')} />{#if shown('caCert')}<span id="secret-provider-ca-error" class="secret-field-error" role="alert">{shown('caCert')}</span>{/if}</div>
        </div>
        <div class="settings-row">
          <div class="settings-row-text"><span class="settings-row-title">Verify TLS certificate</span></div>
          <div class="settings-row-control">
            <label class="switch-control" aria-label="Verify TLS certificate">
              <input type="checkbox" checked={draft.verifyTls} onchange={(event) => (draft.verifyTls = (event.currentTarget as HTMLInputElement).checked)} />
              <span class="switch-track"></span>
              <span class="switch-state">{draft.verifyTls ? 'ON' : 'OFF'}</span>
            </label>
          </div>
        </div>
      </div>
    </section>
  {:else if type === 'azure-key-vault' || type === 'infisical'}
    <section class="settings-block">
      <h4 class="settings-group-label">Authentication</h4>
      <div class="settings-group">
        {@render authMethodRow()}
        {#if type === 'azure-key-vault'}
          <div class="settings-row">
            <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-tenant">Tenant ID</label><span class="settings-row-desc">{draft.authMethod === 'cli' ? 'Optional. Picks a tenant when az is signed in to several.' : 'Directory (tenant) ID of the app registration.'}</span></div>
            <div class="settings-row-control"><input id="secret-provider-tenant" class="field field-mono secret-input" value={draft.tenantId} oninput={(event) => (draft.tenantId = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('tenantId'))} aria-describedby={shown('tenantId') ? 'secret-provider-tenant-error' : undefined} onblur={() => touch('tenantId')} />{#if shown('tenantId')}<span id="secret-provider-tenant-error" class="secret-field-error" role="alert">{shown('tenantId')}</span>{/if}</div>
          </div>
        {/if}
        {#if (type === 'azure-key-vault' && draft.authMethod === 'client-secret') || (type === 'infisical' && draft.authMethod === 'universal')}
          <div class="settings-row">
            <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-client">Client ID</label><span class="settings-row-desc">Not secret, saved in workspace.yml.</span></div>
            <div class="settings-row-control"><input id="secret-provider-client" class="field field-mono secret-input" value={draft.clientId} oninput={(event) => (draft.clientId = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('clientId'))} aria-describedby={shown('clientId') ? 'secret-provider-client-error' : undefined} onblur={() => touch('clientId')} />{#if shown('clientId')}<span id="secret-provider-client-error" class="secret-field-error" role="alert">{shown('clientId')}</span>{/if}</div>
          </div>
        {/if}
      </div>
    </section>
  {/if}

  {#snippet authMethodRow()}
    {@const methods = AUTH_METHODS[type] ?? []}
    <div class="settings-row">
      <div class="settings-row-text"><span class="settings-row-title">Method</span><span class="settings-row-desc">{methods.find(method => method.value === draft.authMethod)?.desc ?? ''}</span></div>
      <div class="settings-row-control">
        <div class="segmented" role="radiogroup" aria-label="Auth method">
          {#each methods as method (method.value)}
            <button class="segmented-item" type="button" role="radio" aria-checked={draft.authMethod === method.value} class:active={draft.authMethod === method.value} onclick={() => (draft.authMethod = method.value)}>{method.label}</button>
          {/each}
        </div>
      </div>
    </div>
  {/snippet}

  <section class="settings-block">
    <h4 class="settings-group-label">Cache</h4>
    <div class="settings-group">
      <div class="settings-row">
        <div class="settings-row-text"><span class="settings-row-title">Keep values in memory for</span><span class="settings-row-desc">Nothing is written to disk. Dynamic secrets expire earlier when their lease ends.</span></div>
        <div class="settings-row-control">
          <div class="segmented" role="radiogroup" aria-label="Cache time">
            {#each CACHE_OPTIONS as option (option.value)}
              {@const active = option.value === 'custom' ? customCache : draft.cacheTtl === option.value}
              <button class="segmented-item" type="button" role="radio" aria-checked={active} class:active={active} onclick={() => (draft.cacheTtl = option.value === 'custom' ? (customCache ? draft.cacheTtl : '30m') : option.value)}>{option.label}</button>
            {/each}
          </div>
        </div>
      </div>
      {#if customCache}
      <div class="settings-row">
        <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-cache-ttl">Custom time</label><span class="settings-row-desc">Any duration up to 24h, like 30m or 2h. Use Session to keep values until Kurlo quits.</span></div>
        <div class="settings-row-control"><input id="secret-provider-cache-ttl" class="field field-mono secret-input secret-input-sm" placeholder="30m" value={draft.cacheTtl} oninput={(event) => (draft.cacheTtl = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('cacheTtl'))} aria-describedby={shown('cacheTtl') ? 'secret-provider-cache-ttl-error' : undefined} onblur={() => touch('cacheTtl')} />{#if shown('cacheTtl')}<span id="secret-provider-cache-ttl-error" class="secret-field-error" role="alert">{shown('cacheTtl')}</span>{/if}</div>
      </div>
      {/if}
      <div class="settings-row">
        <div class="settings-row-text"><label class="settings-row-title" for="secret-provider-timeout">Timeout</label></div>
        <div class="settings-row-control"><input id="secret-provider-timeout" class="field field-mono secret-input secret-input-sm" placeholder="10s" value={draft.timeout} oninput={(event) => (draft.timeout = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" aria-invalid={Boolean(shown('timeout'))} aria-describedby={shown('timeout') ? 'secret-provider-timeout-error' : undefined} onblur={() => touch('timeout')} />{#if shown('timeout')}<span id="secret-provider-timeout-error" class="secret-field-error" role="alert">{shown('timeout')}</span>{/if}</div>
      </div>
    </div>
  </section>

  {#if provider}
    <section class="settings-block">
      <h4 class="settings-group-label">On this device</h4>
      <div class="settings-group">
        <div class="settings-row">
          <div class="settings-row-text">
            <span class="settings-row-title">{provider.trusted ? 'Trusted on this device' : 'Not trusted on this device'}</span>
            <span class="settings-row-desc">{provider.trusted ? 'Changing the address, project, command, profile, role, account or auth method asks again.' : 'Until you trust it, Kurlo sends no credentials to it and linked variables stay unresolved.'}</span>
          </div>
          <div class="settings-row-control">
            {#if provider.trusted}
              <button class="btn btn-secondary btn-sm secret-danger" type="button" onclick={() => revokeProviderTrust(provider.id)}>Revoke trust</button>
            {:else}
              <button class="btn btn-primary btn-sm" type="button" onclick={() => (secretProviders.trustPromptId = provider.id)} disabled={!provider.valid}>Review and trust</button>
            {/if}
          </div>
        </div>
        {#each credentialFields as field (field.name)}
          <div class="settings-row">
            <div class="settings-row-text">
              <label class="settings-row-title" for={`secret-credential-${field.name}`}>{field.label}</label>
              <span class="settings-row-desc">{provider.savedCredentials.includes(field.name) ? 'Saved on this device, encrypted.' : field.hint}</span>
            </div>
            <div class="settings-row-control">
              <input id={`secret-credential-${field.name}`} class="field field-mono secret-input" type={field.name === 'username' ? 'text' : 'password'} aria-invalid={Boolean(credentialProblem(field.name))} aria-describedby={credentialProblem(field.name) ? `secret-credential-${field.name}-error` : undefined} placeholder={provider.savedCredentials.includes(field.name) ? '••••••••' : 'Paste value'} value={credentialDraft[field.name] ?? ''} oninput={(event) => (credentialDraft = { ...credentialDraft, [field.name]: inputValue(event) })} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" />
              <button class="btn btn-secondary btn-sm" type="button" onclick={() => saveCredential(field.name)} disabled={!(credentialDraft[field.name] ?? '').trim() || Boolean(credentialProblem(field.name))}>Save</button>
              {#if credentialProblem(field.name)}<span id={`secret-credential-${field.name}-error`} class="secret-field-error" role="alert">{credentialProblem(field.name)}</span>{/if}
            </div>
          </div>
        {/each}
        {#if type === 'keepassxc'}
          {@const connected = provider.savedCredentials.includes('associationId') && provider.savedCredentials.includes('associationKey')}
          <div class="settings-row">
            <div class="settings-row-text">
              <span class="settings-row-title">KeePassXC connection</span>
              <span class="settings-row-desc">{connecting ? 'Name the connection in KeePassXC and click Save and allow access.' : connected ? 'Connected on this device. Connect again after you open another database.' : 'Open KeePassXC, unlock the database and turn on Browser Integration. KeePassXC asks you to name the connection.'}</span>
            </div>
            <div class="settings-row-control">
              <button class="btn btn-sm" class:btn-primary={!connected} class:btn-secondary={connected} type="button" onclick={() => void connect()} disabled={connecting || !provider.trusted || !provider.valid}>{connecting ? 'Waiting for KeePassXC…' : connected ? 'Connect again' : 'Connect to KeePassXC'}</button>
              {#if connectError}<span class="secret-field-error" role="alert">{connectError}</span>{/if}
            </div>
          </div>
        {/if}
        {#if provider.savedCredentials.length}
          <div class="settings-row">
            <div class="settings-row-text"><span class="settings-row-title">Saved credentials</span><span class="settings-row-desc">{provider.savedCredentials.join(', ')}</span></div>
            <div class="settings-row-control"><button class="btn btn-secondary btn-sm" type="button" onclick={() => forgetProviderCredentials(provider.id)}>Forget credentials</button></div>
          </div>
        {/if}
      </div>
    </section>

    <section class="settings-block">
      <h4 class="settings-group-label">Used by {provider.usedBy.length} {provider.usedBy.length === 1 ? 'variable' : 'variables'}</h4>
      {#if provider.usedBy.length}
        <div class="settings-group">
          {#each provider.usedBy as usage (`${usage.environmentId}:${usage.key}`)}
            <button class="settings-row secret-usage-row" type="button" onclick={() => onOpenEnvironment(usage.environmentId)}>
              <span class="secret-usage-key">{usage.key}</span>
              <span class="secret-usage-env">{usage.environmentName}</span>
              <span class="secret-usage-path">{usage.path}{usage.field ? `#${usage.field}` : ''}</span>
            </button>
          {/each}
        </div>
      {:else}
        <p class="settings-group-note">Link a variable in an environment: open its row menu and choose Link to secret manager.</p>
      {/if}
    </section>
  {/if}
</div>

{#if exportingEnv && provider}
  <SecretProviderEnvExportModal workspaceId={secretProviders.workspaceId} {provider} onDismiss={() => (exportingEnv = false)} />
{/if}

{#if confirmDelete && provider}
  <SecretProviderDeleteModal {provider} busy={deleting} onDelete={remove} onDismiss={() => (confirmDelete = false)} />
{/if}
