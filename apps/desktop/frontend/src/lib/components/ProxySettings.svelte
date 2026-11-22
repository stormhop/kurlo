<script lang="ts">
  import Disclosure from './Disclosure.svelte';
  import type { ProxyCertificateInfo, ProxyConfig, ProxyPlatformSupport } from '../wire';

  let {
    config = $bindable(),
    recording,
    rules,
    support,
    certificate,
    busy,
    pacURL,
    qr,
    onSystemProxy,
    onAddHosts,
    onRemoveHost,
    onTrust,
    onUntrust,
    onExport,
    onChooseFile,
    onCopyPAC,
    onClearRules,
  }: {
    config: ProxyConfig;
    recording: boolean;
    rules: number;
    support: ProxyPlatformSupport;
    certificate: ProxyCertificateInfo | null;
    busy: boolean;
    pacURL: string;
    qr: string;
    onSystemProxy: (value: boolean) => void;
    onAddHosts: (hosts: string[]) => void;
    onRemoveHost: (host: string) => void;
    onTrust: () => void;
    onUntrust: () => void;
    onExport: () => void;
    onChooseFile: (kind: 'certificate' | 'key') => void;
    onCopyPAC: () => void;
    onClearRules: () => void;
  } = $props();

  let newHost = $state('');
  const lan = $derived(Boolean(config.listenIP) && config.listenIP !== '127.0.0.1');
  const wildcard = $derived((config.sslHosts ?? []).some(item => item.startsWith('*')));

  function addHosts(event: SubmitEvent) {
    event.preventDefault();
    const hosts = newHost.split(/[\s,]+/).map(item => item.trim().toLowerCase()).filter(Boolean);
    if (!hosts.length) return;
    newHost = '';
    onAddHosts(hosts);
  }
</script>

<div class="capture-settings" role="region" aria-label="Capture settings">
  <section class="capture-card" aria-label="Routing">
    <div class="capture-card-head">
      <strong>Routing</strong>
      <span>How browsers and apps reach Kurlo.</span>
    </div>
    <label class="capture-option" class:disabled={!support.systemProxy}>
      {#if recording && support.systemProxy}<span class="capture-option-state" class:on={config.systemProxy}>{config.systemProxy ? 'On' : 'Off'}</span>{:else}<input class="check" type="checkbox" checked={support.systemProxy && config.systemProxy} disabled={!support.systemProxy} onchange={event => onSystemProxy(event.currentTarget.checked)}>{/if}
      <span>
        <span class="capture-option-title">Use as system proxy while recording</span>
        <span class="capture-option-note">
          {#if support.systemProxy}
            Every browser that follows the system settings is recorded. Your previous settings come back when you stop.
          {:else}
            Not available on this system. Kurlo can change the proxy on macOS, Windows and Linux with GNOME. Use the automatic proxy URL below instead.
          {/if}
        </span>
      </span>
    </label>
    <div class="capture-pac">
      <span class="capture-option-note">{support.systemProxy && config.systemProxy ? 'To route only one browser or another device, use this automatic proxy URL:' : 'Paste this automatic proxy URL into your browser or network settings:'}</span>
      <div class="capture-pac-row">
        <code>{pacURL}</code>
        <button class="btn btn-secondary btn-sm" type="button" onclick={onCopyPAC}>Copy PAC URL</button>
      </div>
      {#if qr}<img class="capture-qr" src={qr} width="88" height="88" alt="Proxy address QR code">{/if}
    </div>
  </section>

  <section class="capture-card capture-decrypt" aria-label="HTTPS decryption">
    <div class="capture-card-head">
      <strong>HTTPS decryption</strong>
      <span>Kurlo decrypts only the hosts listed here. Other HTTPS traffic stays an encrypted tunnel.</span>
      {#if certificate?.exists}<span class="capture-trust" class:ok={certificate.trusted}>{certificate.trusted ? 'Certificate trusted' : 'Certificate not trusted'}</span>{/if}
    </div>
    <div class="capture-hosts" role="list" aria-label="Decrypted hosts">
      {#each config.sslHosts ?? [] as item (item)}
        <span class="capture-host" role="listitem"><code>{item}</code><button class="btn-link" type="button" aria-label={'Stop decrypting ' + item} disabled={busy} onclick={() => onRemoveHost(item)}>×</button></span>
      {/each}
      <form class="capture-host-form" onsubmit={addHosts}>
        <input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-md" aria-label="Host to decrypt" placeholder="api.example.com, *.example.dev" bind:value={newHost}>
        <button class="btn btn-secondary btn-sm" type="submit" disabled={busy || !newHost.trim()}>Add host</button>
      </form>
    </div>
    <div class="capture-cert-actions">
      {#if support.trustCertificate}
        {#if certificate?.trusted}
          <button class="btn btn-secondary btn-sm" type="button" disabled={busy} onclick={onUntrust}>Remove trust…</button>
        {:else}
          <button class="btn btn-primary btn-sm" type="button" disabled={busy} onclick={onTrust}>Trust Kurlo certificate…</button>
        {/if}
      {:else}
        <button class="btn btn-secondary btn-sm" type="button" disabled>Trust Kurlo certificate…</button>
      {/if}
      <button class="btn btn-secondary btn-sm" type="button" disabled={busy} onclick={onExport}>Export certificate…</button>
      {#if certificate?.exists}<span class="capture-option-note">{certificate.subject} · SHA-256 {certificate.fingerprint.slice(0, 23)}…</span>{/if}
    </div>
    {#if !support.trustCertificate}<p class="capture-option-note">Kurlo cannot add certificates to the trust store on this system. Export the certificate and add it to your system and browser trust stores.</p>{/if}
    {#if wildcard}<p class="capture-option-note capture-warn">A wildcard decrypts every matching site you open while recording.</p>{/if}
  </section>

  <section class="capture-card" aria-label="Connection">
    <div class="capture-card-head">
      <strong>Connection</strong>
      <span>{recording ? 'Stop recording to change these settings.' : 'Where Kurlo listens and what it keeps.'}</span>
    </div>
    <div class="capture-fields">
      <label class="mock-field">Port <input class="field field-mono field-md capture-port" type="number" min="1" max="65535" bind:value={config.port} disabled={recording}></label>
      <label class="mock-field">Only record host <input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-md" placeholder="All hosts" bind:value={config.include} disabled={recording}></label>
      <label class="mock-field">Listen address <input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-mono field-md capture-ip" bind:value={config.listenIP} disabled={recording}></label>
      {#if lan}<label class="mock-field">Allowed device <input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-mono field-md capture-ip" placeholder="192.168.1.20" bind:value={config.clientIP} disabled={recording}></label>{/if}
    </div>
    {#if lan}<p class="capture-option-note">Another device on your network can use the proxy. Allow it through your firewall.</p>{/if}
    <label class="capture-option" class:disabled={!support.identifyProcess}>
      {#if recording && support.identifyProcess}<span class="capture-option-state" class:on={config.identifyProcess}>{config.identifyProcess ? 'On' : 'Off'}</span>{:else}<input class="check" type="checkbox" checked={support.identifyProcess && config.identifyProcess} disabled={!support.identifyProcess} onchange={event => (config.identifyProcess = event.currentTarget.checked)}>{/if}
      <span>
        <span class="capture-option-title">Show which app sent each request</span>
        <span class="capture-option-note">{support.identifyProcess ? 'Looks up the local process for every connection.' : 'Available on macOS.'}</span>
      </span>
    </label>
    {#if rules}<button class="btn btn-secondary btn-sm capture-clear-rules" type="button" disabled={busy} onclick={onClearRules}>Clear local responses ({rules})</button>{/if}
  </section>

  <section class="capture-card capture-card-wide" aria-label="Development service">
    <Disclosure title="Inspect a service with its own certificate" summary={config.service || 'Off'} storageKey="kurlo.proxy.serviceOpen" forceOpen={Boolean(config.service)}>
      <p class="capture-option-note">Decrypt one HTTPS development service with its PEM certificate and key instead of the Kurlo certificate.</p>
      <div class="capture-fields">
        <label class="mock-field">Service <input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-mono field-md" placeholder="dev.example.test:443" bind:value={config.service} disabled={recording}></label>
        <button class="btn btn-secondary btn-sm" type="button" disabled={recording || !config.service} aria-label={config.certificate ? 'Service certificate: ' + config.certificate : 'Choose certificate'} onclick={() => onChooseFile('certificate')}>{config.certificate.split(/[\\/]/).pop() || 'Choose certificate…'}</button>
        <button class="btn btn-secondary btn-sm" type="button" disabled={recording || !config.service} aria-label={config.key ? 'Service private key: ' + config.key : 'Choose key'} onclick={() => onChooseFile('key')}>{config.key.split(/[\\/]/).pop() || 'Choose key…'}</button>
      </div>
    </Disclosure>
  </section>
</div>
