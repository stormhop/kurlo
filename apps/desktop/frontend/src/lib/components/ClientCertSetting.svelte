<script lang="ts">
  import { vm } from '../stores/app.svelte';
  import SecretInput from './SecretInput.svelte';

  let { description = 'Present a certificate for servers that require mutual TLS. Set it on a collection to reuse it across requests.' }: { description?: string } = $props();
</script>

<div class="postman-setting client-cert-setting">
  <span class="setting-copy">
    <strong>Client certificate (mTLS)</strong>
    <span>{description}</span>
    {#if vm.collectionSettingDefaultNote('clientCertPath')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('clientCertPath')}>{vm.collectionSettingDefaultNote('clientCertPath')}</em>{/if}
  </span>
  <div class="client-cert-fields">
    <div class="client-cert-row">
      <span class="client-cert-label">Certificate (PEM/PFX/P12)</span>
      {#if vm.clientCertPath}
        <span class="client-cert-path">{vm.clientCertPath}</span>
        <button class="btn btn-secondary" type="button" onclick={() => vm.clearClientCertField('clientCertPath')}>Clear</button>
      {:else}
        <button class="btn btn-secondary" type="button" onclick={() => vm.pickClientCertFile('clientCertPath')}>Choose file…</button>
      {/if}
    </div>
    <div class="client-cert-row">
      <span class="client-cert-label">Private key (optional)</span>
      {#if vm.clientKeyPath}
        <span class="client-cert-path">{vm.clientKeyPath}</span>
        <button class="btn btn-secondary" type="button" onclick={() => vm.clearClientCertField('clientKeyPath')}>Clear</button>
      {:else}
        <button class="btn btn-secondary" type="button" onclick={() => vm.pickClientCertFile('clientKeyPath')} disabled={!vm.clientCertPath}>Choose file…</button>
      {/if}
    </div>
    <div class="client-cert-row">
      <span class="client-cert-label">Passphrase</span>
      <SecretInput
        className="field field-input client-cert-pass"
        placeholder="Leave blank if the key is unencrypted"
        bind:value={vm.clientKeyPassword}
        suggestions={vm.variableSuggestions}
        oninput={() => vm.markRequestSettingOverride('clientKeyPassword')}
        disabled={!vm.clientCertPath}
      />
    </div>
    <p class="client-cert-hint">PFX/P12 includes the private key; leave the key file blank. For PEM, the key defaults to the certificate file. Use <code>&#123;&#123;variable&#125;&#125;</code> in any field to keep the passphrase in workspace secrets.</p>
  </div>
</div>
