<script lang="ts">
  import { tick } from 'svelte';
  import Select from './Select.svelte';
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
  const presetOptions = AI_PRESETS.map(entry => ({ value: entry.id, label: entry.label }));

  async function toggle() {
    open = !open;
    if (open) {
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

  function choose(model: string) {
    vm.aiModel = model;
    open = false;
    triggerEl?.focus();
  }

  function onModelKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      open = false;
      triggerEl?.focus();
    } else if (event.key === 'Escape') {
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
    <div class="grpc-method-menu ai-model-menu" role="dialog" aria-label="Provider and model">
      <span class="field-label">Provider</span>
      <Select
        value={preset.id}
        options={presetOptions}
        ariaLabel="Provider"
        onChange={(value) => vm.selectAiPreset(value as AiPresetId)}
      />
      <label class="field-label" for="ai-model-input">Model</label>
      <input
        id="ai-model-input"
        class="field field-mono"
        bind:this={modelInput}
        bind:value={vm.aiModel}
        placeholder={preset.provider === 'anthropic' ? 'e.g. claude-sonnet-5-5' : 'Model ID'}
        autocomplete="off"
        spellcheck="false"
        onkeydown={onModelKeydown}
      />
      <button class="btn btn-secondary grpc-method-refresh" type="button" disabled={vm.aiModelsLoading} onclick={() => vm.loadAiModels()}>
        {#if vm.aiModelsLoading}<span class="spinner spinner-inline"></span>{/if}
        <span>{models.length ? 'Refresh models' : 'Load models'}</span>
      </button>
      {#if vm.aiModelsError}
        <p class="ai-model-error" role="alert">{vm.aiModelsError}</p>
      {/if}
      {#if visibleModels.length}
        <div class="grpc-method-options" role="listbox" aria-label="Models">
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
        <div class="grpc-method-empty">No matching models. The ID you typed is used as is.</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .ai-model-provider {
    color: var(--text-3);
    font-size: var(--text-label);
    white-space: nowrap;
  }
  .ai-model-wrap :global(.grpc-method-label) {
    flex: 1 1 auto;
    justify-self: stretch;
    text-align: left;
  }
  .ai-model-provider {
    margin-right: var(--space-2);
  }
  .ai-model-empty {
    color: var(--text-3);
  }
  .ai-model-menu {
    display: grid;
    gap: var(--space-1-5);
    min-width: min(25rem, 82vw);
  }
  .ai-model-menu :global(.field-label) {
    margin-top: var(--space-1);
  }
  .ai-model-error {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-label);
    line-height: var(--leading-normal);
  }
</style>
