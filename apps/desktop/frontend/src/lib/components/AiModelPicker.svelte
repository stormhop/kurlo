<script module lang="ts">
  const autoLoaded = new Set<string>();
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import { vm } from '../stores/app.svelte';
  import { AI_PRESETS, type AiPresetId } from '../stores/features/ai';

  let open = $state(false);
  let modelInput = $state<HTMLInputElement>();
  let triggerEl = $state<HTMLButtonElement>();

  const preset = $derived(vm.aiCurrentPreset());
  const models = $derived(vm.aiModelOptions());
  const filter = $derived(vm.aiModel.trim().toLowerCase());
  const visibleModels = $derived(
    filter && !models.includes(vm.aiModel.trim()) ? models.filter(model => model.toLowerCase().includes(filter)) : models,
  );

  function autoLoadModels() {
    const key = `${vm.aiProvider}|${vm.url.trim()}`;
    if (!vm.url.trim() || vm.aiModelOptions().length || vm.aiModelsLoading || autoLoaded.has(key)) return;
    autoLoaded.add(key);
    void vm.loadAiModels();
  }

  async function toggle() {
    open = !open;
    if (open) {
      vm.aiModelsError = '';
      autoLoadModels();
      await tick();
      modelInput?.focus();
    }
  }

  function closeOnFocusOut(event: FocusEvent) {
    const current = event.currentTarget;
    const next = event.relatedTarget;
    if (!(current instanceof HTMLElement)) return;
    if (!(next instanceof Node) || !current.contains(next)) open = false;
  }

  async function choosePreset(id: AiPresetId) {
    vm.selectAiPreset(id);
    vm.aiModelsError = '';
    autoLoadModels();
    await tick();
    modelInput?.focus();
  }

  function choose(model: string) {
    vm.aiModel = model;
    open = false;
    triggerEl?.focus();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' || (event.key === 'Enter' && event.target === modelInput)) {
      event.preventDefault();
      open = false;
      triggerEl?.focus();
    }
  }
</script>

<div class="grpc-method-wrap ai-model-wrap" onfocusout={closeOnFocusOut}>
  <button
    class="field field-xl select-trigger grpc-method-trigger"
    class:open
    type="button"
    bind:this={triggerEl}
    aria-label="Provider and model"
    aria-haspopup="dialog"
    aria-expanded={open}
    onclick={toggle}
  >
    <span class="ai-model-provider">{preset.label}</span>
    <span class="grpc-method-label" class:ai-model-empty={!vm.aiModel.trim()} title={vm.aiModel}>{vm.aiModel.trim() || 'Choose a model'}</span>
    <svg width="0.625rem" height="0.375rem" viewBox="0 0 10 6" fill="none" aria-hidden="true">
      <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  </button>

  {#if open}
    <div class="grpc-method-menu ai-model-menu" role="dialog" aria-label="Provider and model" tabindex="-1" onkeydown={onKeydown}>
      <span class="field-label">Provider</span>
      <div class="ai-provider-grid" role="radiogroup" aria-label="Provider">
        {#each AI_PRESETS as entry (entry.id)}
          <button
            class="btn btn-secondary btn-sm ai-provider-option"
            class:active={preset.id === entry.id}
            role="radio"
            aria-checked={preset.id === entry.id}
            type="button"
            onclick={() => choosePreset(entry.id)}
          >{entry.label}</button>
        {/each}
      </div>

      <label class="field-label" for="ai-model-input">Model</label>
      <input
        id="ai-model-input"
        class="field field-mono"
        bind:this={modelInput}
        bind:value={vm.aiModel}
        placeholder={`e.g. ${preset.modelExample}`}
        autocomplete="off"
        spellcheck="false"
      />
      <p class="ai-model-hint">The model's name at {preset.id === 'custom' ? 'your server' : preset.label}. Pick one from the list or type it.</p>

      {#if vm.aiModelsLoading}
        <div class="grpc-method-empty"><span class="spinner spinner-inline"></span> Loading the provider's models…</div>
      {:else if vm.aiModelsError}
        <p class="ai-model-error" role="alert">{vm.aiModelsError}</p>
        <button class="btn btn-ghost btn-sm ai-model-retry" type="button" onclick={() => vm.loadAiModels()}>Try again</button>
      {:else if visibleModels.length}
        <div class="grpc-method-options ai-model-options" role="listbox" aria-label="Models">
          {#each visibleModels as model (model)}
            <button
              class="grpc-method-option"
              class:active={vm.aiModel === model}
              role="option"
              aria-selected={vm.aiModel === model}
              type="button"
              onclick={() => choose(model)}
            >
              <span class="method-check">{vm.aiModel === model ? '✓' : ''}</span>
              <span class="grpc-option-main"><strong>{model}</strong></span>
            </button>
          {/each}
        </div>
      {:else if models.length}
        <div class="grpc-method-empty">No model in the list matches. The name you typed is sent as is.</div>
      {:else}
        <button class="btn btn-ghost btn-sm ai-model-retry" type="button" onclick={() => vm.loadAiModels()}>Load the provider's models</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .ai-model-wrap :global(.grpc-method-label) {
    flex: 1 1 auto;
    justify-self: stretch;
    text-align: left;
  }
  .ai-model-provider {
    margin-right: var(--space-2);
    color: var(--text-3);
    font-size: var(--text-label);
    white-space: nowrap;
  }
  .ai-model-empty {
    color: var(--text-3);
  }
  .ai-model-menu {
    display: grid;
    gap: var(--space-1-5);
    min-width: min(26rem, 82vw);
  }
  .ai-model-menu :global(.field-label) {
    margin-top: var(--space-1);
  }
  .ai-provider-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr));
    gap: var(--space-1-5);
  }
  .ai-provider-option {
    justify-content: flex-start;
  }
  .ai-provider-option.active {
    border-color: var(--accent);
    background: var(--accent-dim);
    color: var(--text);
  }
  .ai-model-hint {
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-caption);
  }
  .ai-model-options {
    max-height: 14rem;
    overflow: auto;
  }
  .ai-model-options :global(.grpc-method-option) {
    min-height: var(--control-lg);
  }
  .ai-model-error {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-label);
    line-height: var(--leading-normal);
  }
  .ai-model-retry {
    justify-self: start;
  }
</style>
