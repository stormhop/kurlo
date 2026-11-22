<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import MenuIcon from './MenuIcon.svelte';
  import { trapFocus } from '../a11y';
  import { portal } from '../portal';
  import { commandList, joinCommand, secretProviderTypeInfo } from '../secretProviderTypes';
  import type { SecretProviderView } from '../wire';

  let {
    provider,
    busy = false,
    error = '',
    onTrust,
    onDismiss,
  }: {
    provider: SecretProviderView;
    busy?: boolean;
    error?: string;
    onTrust: () => void;
    onDismiss: () => void;
  } = $props();

  const config = $derived(provider.config as Record<string, unknown>);
  const rows = $derived.by(() => {
    const out: { key: string; value: string }[] = [];
    const add = (key: string, value: unknown) => {
      if (typeof value === 'string' && value) out.push({ key, value });
      else if (typeof value === 'boolean' && value) out.push({ key, value: 'true' });
    };
    add('type', provider.type);
    for (const key of ['address', 'namespace', 'caCert', 'skipTlsVerify', 'account', 'region', 'profile', 'endpoint', 'roleArn', 'externalId', 'mfaSerial', 'project']) add(key, config[key]);
    if (config.command !== undefined) add('command', joinCommand(commandList(config.command)));
    const auth = config.auth as Record<string, unknown> | undefined;
    if (auth) for (const key of ['method', 'roleId', 'role', 'mount', 'tokenPath', 'redirectUri', 'tenantId', 'clientId', 'username']) add(`auth.${key}`, auth[key]);
    return out;
  });
  const destination = $derived.by(() => {
    switch (provider.type) {
      case 'vault': return { what: 'your Vault token', where: String(config.address ?? '') };
      case '1password': return { what: 'requests through the op CLI', where: String(config.account || 'your default 1Password account') };
      case 'aws-secrets-manager':
      case 'aws-ssm': return { what: 'your AWS credentials', where: String(config.endpoint || `AWS in ${config.region ?? ''}`) };
      case 'gcp-secret-manager': return { what: 'your Google Cloud credentials', where: String(config.endpoint || `Secret Manager in project ${config.project ?? ''}`) };
      case 'azure-key-vault': return { what: 'your Azure credentials', where: String(config.address ?? '') };
      case 'bitwarden': return { what: 'your Bitwarden access token through the bws CLI', where: String(config.address || 'bitwarden.com') };
      case 'doppler': return { what: 'your Doppler token', where: String(config.address || 'api.doppler.com') };
      case 'infisical': return { what: 'your Infisical credentials', where: String(config.address || 'app.infisical.com') };
      case 'command': return { what: 'this computer to run', where: joinCommand(commandList(config.command)) };
      case 'env': return { what: 'environment variables of this computer', where: 'requests in this workspace' };
      default: return { what: 'credentials', where: provider.id };
    }
  });

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onDismiss();
    }
  }
</script>

<div class="dialog-backdrop" role="presentation" use:portal onmousedown={(event) => event.target === event.currentTarget && onDismiss()} onkeydown={onKeydown}>
  <div class="modal secret-trust-modal" role="dialog" aria-modal="true" aria-labelledby="secret-trust-title" aria-describedby="secret-trust-intro" tabindex="-1" use:trapFocus>
    <div class="modal-head dialog-head">
      <h2 class="modal-title" id="secret-trust-title">Trust “{provider.name || provider.id}” on this device?</h2>
      <button type="button" class="btn btn-ghost btn-icon dialog-close" onclick={onDismiss} aria-label="Close dialog"><AddCloseIcon /></button>
    </div>
    <div class="secret-trust-body">
      <p id="secret-trust-intro">
        {provider.trustChanged
          ? 'The provider settings changed since you trusted it, for example after a git pull.'
          : 'This provider comes from workspace.yml, so anyone who can change the repository chose these settings.'}
        Until you trust it, Kurlo sends no credentials and {provider.usedBy.length} linked {provider.usedBy.length === 1 ? 'variable stays' : 'variables stay'} unresolved.
      </p>
      <div class="secret-trust-config">
        <div class="secret-trust-config-head">workspace.yml · {secretProviderTypeInfo(provider.type)?.name ?? provider.type} · id {provider.id}</div>
        {#each rows as row (row.key)}
          <div class="secret-trust-config-row"><span>{row.key}</span><span>{row.value}</span></div>
        {/each}
      </div>
      <div class="secret-banner secret-banner-warn">
        <MenuIcon name="warning" />
        <span>If you trust it, Kurlo will use {destination.what} for <strong>{destination.where}</strong>. Trust it only if you expected these settings.</span>
      </div>
      {#if error}<div class="secret-banner secret-banner-error" role="alert"><MenuIcon name="warning" /><span>{error}</span></div>{/if}
    </div>
    <div class="modal-foot dialog-actions">
      <button class="btn btn-secondary btn-lg" type="button" onclick={onDismiss} disabled={busy}>Don't trust</button>
      <button class="btn btn-primary btn-lg" type="button" onclick={onTrust} disabled={busy} data-autofocus="">{busy ? 'Trusting…' : 'Trust on this device'}</button>
    </div>
  </div>
</div>
