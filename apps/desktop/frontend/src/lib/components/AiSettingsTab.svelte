<script lang="ts">
  import { vm } from '../stores/app.svelte';
  import Select from './Select.svelte';
  import { aiSettingsError } from '../stores/features/ai';

  const THINKING_OPTIONS = [
    { value: '', label: 'Model default' },
    { value: 'summarized', label: 'Show summarized' },
  ];

  const settingsError = $derived(aiSettingsError({
    aiTemperature: vm.aiTemperature,
    aiTopP: vm.aiTopP,
    aiMaxTokens: vm.aiMaxTokens,
    aiMaxSteps: vm.aiMaxSteps,
    aiIdleTimeoutSec: vm.aiIdleTimeoutSec,
  }));
</script>

<div class="settings-section">
  <div class="settings-header">
    <div>
      <span class="settings-title">Model</span>
      <span class="settings-subtitle">Leave a field empty to use the provider's default.</span>
    </div>
  </div>

  <div class="settings-list">
    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Temperature</strong>
        <span>How random the answer is, from 0 to 2. Lower is more predictable, which helps tests.</span>
      </span>
      <input class="field setting-number" inputmode="decimal" placeholder="default" bind:value={vm.aiTemperature} />
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Max tokens</strong>
        <span>The longest answer the model may write. {vm.aiProvider === 'anthropic' ? 'Anthropic requires a limit; Kurlo sends 8192 when this is empty.' : 'Reasoning models count their thinking against it too.'}</span>
      </span>
      <input class="field setting-number" inputmode="numeric" placeholder={vm.aiProvider === 'anthropic' ? '8192' : 'default'} bind:value={vm.aiMaxTokens} />
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Top P</strong>
        <span>Sample only from the most likely words, from 0 to 1. Change this or temperature, not both.</span>
      </span>
      <input class="field setting-number" inputmode="decimal" placeholder="default" bind:value={vm.aiTopP} />
    </label>

    {#if vm.aiProvider === 'anthropic'}
      <div class="postman-setting">
        <span class="setting-copy">
          <strong>Thinking</strong>
          <span>Show a summary of the model's thinking above the answer. Thinking that is not shown is still billed.</span>
        </span>
        <Select value={vm.aiThinking} options={THINKING_OPTIONS} className="setting-select" ariaLabel="Thinking" onChange={value => (vm.aiThinking = value)} />
      </div>
    {/if}

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Stream the answer</strong>
        <span>Show the answer as it is written and measure the time to the first token. Turn it off for servers that cannot stream.</span>
      </span>
      <span class="switch-control">
        <input type="checkbox" bind:checked={vm.aiStream} />
        <span class="switch-track"></span>
        <span class="switch-state">{vm.aiStream ? 'ON' : 'OFF'}</span>
      </span>
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Stop after silence</strong>
        <span>Give up when the provider sends nothing for this long. A long answer that keeps streaming is never cut off.</span>
      </span>
      <span class="setting-inline-number">
        <input class="field setting-number" inputmode="numeric" placeholder="300" bind:value={vm.aiIdleTimeoutSec} />
        <span>s</span>
      </span>
    </label>
  </div>

  {#if settingsError}
    <p class="ai-settings-error" role="alert">{settingsError}</p>
  {/if}

  <div class="settings-header ai-settings-network">
    <div>
      <span class="settings-title">Network</span>
      <span class="settings-subtitle">For a local model with a self-signed certificate, or a company proxy in front of the provider.</span>
    </div>
  </div>

  <div class="settings-list">
    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Verify SSL certificates</strong>
        <span>Turn off only for a server you trust, such as a gateway on your own machine.</span>
      </span>
      <span class="switch-control">
        <input type="checkbox" checked={vm.enableSSLVerification} onchange={vm.toggleSSLVerification} />
        <span class="switch-track"></span>
        <span class="switch-state">{vm.enableSSLVerification ? 'ON' : 'OFF'}</span>
      </span>
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>HTTP proxy</strong>
        <span>Leave empty to use the system proxy.</span>
      </span>
      <input class="field field-mono kv-input setting-proxy" type="text" placeholder="http://localhost:8080" bind:value={vm.proxyUrl} spellcheck="false" autocomplete="off" oninput={() => vm.markRequestSettingOverride('proxyUrl')} />
    </label>
  </div>
</div>

<style>
  .ai-settings-error {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-label);
  }
  .ai-settings-network {
    margin-top: var(--space-6);
  }
</style>
