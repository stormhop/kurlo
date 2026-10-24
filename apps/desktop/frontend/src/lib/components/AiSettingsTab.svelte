<script lang="ts">
  import { vm } from '../stores/app.svelte';
  import Select from './Select.svelte';
  import { aiSettingErrors } from '../stores/features/ai';

  const THINKING_OPTIONS = [
    { value: '', label: 'Model default' },
    { value: 'summarized', label: 'Show summarized' },
  ];

  const errors = $derived(aiSettingErrors({
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

  <div class="settings-list ai-settings-list">
    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Temperature</strong>
        <span>How random the answer is, from 0 to 2. Lower is more predictable, which helps tests.</span>
      </span>
      <span class="ai-setting-control">
        <input id="ai-temperature" class="field ai-number" class:ai-invalid={errors.aiTemperature} inputmode="decimal" placeholder="default" aria-invalid={Boolean(errors.aiTemperature)} aria-describedby={errors.aiTemperature ? 'ai-temperature-error' : undefined} bind:value={vm.aiTemperature} />
        {#if errors.aiTemperature}<span id="ai-temperature-error" class="ai-field-error" role="alert">{errors.aiTemperature}</span>{/if}
      </span>
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Max tokens</strong>
        <span>The longest answer the model may write. {vm.aiProvider === 'anthropic' ? 'Anthropic requires a limit; Kurlo sends 8192 when this is empty.' : 'Reasoning models count their thinking against it too.'}</span>
      </span>
      <span class="ai-setting-control">
        <input id="ai-max-tokens" class="field ai-number" class:ai-invalid={errors.aiMaxTokens} inputmode="numeric" placeholder={vm.aiProvider === 'anthropic' ? '8192' : 'default'} aria-invalid={Boolean(errors.aiMaxTokens)} aria-describedby={errors.aiMaxTokens ? 'ai-max-tokens-error' : undefined} bind:value={vm.aiMaxTokens} />
        {#if errors.aiMaxTokens}<span id="ai-max-tokens-error" class="ai-field-error" role="alert">{errors.aiMaxTokens}</span>{/if}
      </span>
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Top P</strong>
        <span>Sample only from the most likely words, from 0 to 1. Change this or temperature, not both.</span>
      </span>
      <span class="ai-setting-control">
        <input id="ai-top-p" class="field ai-number" class:ai-invalid={errors.aiTopP} inputmode="decimal" placeholder="default" aria-invalid={Boolean(errors.aiTopP)} aria-describedby={errors.aiTopP ? 'ai-top-p-error' : undefined} bind:value={vm.aiTopP} />
        {#if errors.aiTopP}<span id="ai-top-p-error" class="ai-field-error" role="alert">{errors.aiTopP}</span>{/if}
      </span>
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
      <span class="ai-setting-control">
        <span class="ai-number-unit">
          <input id="ai-idle-timeout" class="field ai-number" class:ai-invalid={errors.aiIdleTimeoutSec} inputmode="numeric" placeholder="300" aria-invalid={Boolean(errors.aiIdleTimeoutSec)} aria-describedby={errors.aiIdleTimeoutSec ? 'ai-idle-timeout-error' : undefined} bind:value={vm.aiIdleTimeoutSec} />
          <span>s</span>
        </span>
        {#if errors.aiIdleTimeoutSec}<span id="ai-idle-timeout-error" class="ai-field-error" role="alert">{errors.aiIdleTimeoutSec}</span>{/if}
      </span>
    </label>
  </div>

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
  .ai-settings-list :global(.postman-setting) {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .ai-setting-control {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-1);
    justify-self: end;
  }
  .ai-number {
    width: 8rem;
    font-family: var(--font-mono);
  }
  .ai-number-unit {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-3);
    font-size: var(--text-label);
  }
  .ai-invalid,
  .ai-invalid:focus {
    border-color: var(--danger);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--danger) 35%, transparent);
  }
  .ai-field-error {
    max-width: 14rem;
    color: var(--danger);
    font-size: var(--text-caption);
    line-height: var(--leading-normal);
    text-align: right;
  }
  .ai-settings-network {
    margin-top: var(--space-6);
  }
  @container (max-width: 30rem) {
    .ai-settings-list :global(.postman-setting) {
      grid-template-columns: minmax(0, 1fr);
    }
    .ai-setting-control {
      align-items: flex-start;
      justify-self: start;
    }
    .ai-field-error {
      text-align: left;
    }
  }
</style>
