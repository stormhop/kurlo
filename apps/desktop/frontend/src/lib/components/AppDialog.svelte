<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import { trapFocus } from '../a11y';
  import type { AppDialogState } from '../types/dialog';

  let {
    dialog,
    inputValue = $bindable(''),
    selectOpen = $bindable(false),
    onCancel,
    onDismiss,
    onAlt,
    onSubmit,
    onInputKeydown,
    onSelectKeydown,
    selectLabel,
    onChooseOption,
  }: {
    dialog: AppDialogState;
    inputValue: string;
    selectOpen: boolean;
    onCancel: () => void;
    onDismiss: () => void;
    onAlt: () => void;
    onSubmit: () => void;
    onInputKeydown: (event: KeyboardEvent) => void;
    onSelectKeydown: (event: KeyboardEvent) => void;
    selectLabel: () => string;
    onChooseOption: (value: string) => void;
  } = $props();

  let richSelect = $derived(dialog.mode === 'select' && Boolean(dialog.options?.some(option => option.icon || option.description)));

  const KIND_LABELS: Record<string, string> = {
    http: 'HTTP',
    graphql: 'GQL',
    ws: 'WS',
    sio: 'SIO',
    grpc: 'gRPC',
    mcp: 'MCP',
  };
</script>

<div class="dialog-backdrop" role="presentation" onmousedown={(event) => event.target === event.currentTarget && onDismiss()}>
  <div class="modal app-dialog" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title" tabindex="-1" use:trapFocus>
    <div class="modal-head dialog-head">
      <h2 class="modal-title" id="app-dialog-title">{dialog.title}</h2>
      <button type="button" class="btn btn-ghost btn-icon dialog-close" onclick={onDismiss} aria-label="Close dialog"><AddCloseIcon /></button>
    </div>
    {#if dialog.message}
      <p>{dialog.message}</p>
    {/if}
    {#if dialog.mode === 'prompt'}
      <input
        bind:value={inputValue}
        onkeydown={onInputKeydown}
        placeholder={dialog.placeholder || 'Name'}
        maxlength={dialog.maxLength}
        spellcheck="false"
        data-autofocus
      />
    {/if}
    {#if dialog.mode === 'select' && dialog.options}
      {#if richSelect}
        <div class="dialog-choice-grid" role="radiogroup" aria-label={dialog.title}>
          {#each dialog.options as opt, eachIndex (eachIndex)}
            <button
              class="dialog-choice-card"
              class:active={inputValue === opt.value}
              class:disabled={opt.disabled}
              type="button"
              role="radio"
              aria-checked={inputValue === opt.value}
              aria-disabled={opt.disabled}
              disabled={opt.disabled}
              onclick={() => onChooseOption(opt.value)}
            >
              {#if opt.icon && KIND_LABELS[opt.icon]}
                <span class="dialog-choice-kind" class:protocol={opt.icon !== 'http'} aria-hidden="true">{KIND_LABELS[opt.icon]}</span>
              {:else}
              <span
                class="dialog-choice-icon"
                class:http={opt.icon === 'http' || opt.icon === 'postman'}
                class:gql={opt.icon === 'graphql' || opt.icon === 'openapi'}
                class:httpfile={opt.icon === 'httpfile'}
                class:ws={opt.icon === 'ws' || opt.icon === 'har'}
                class:sio={opt.icon === 'sio' || opt.icon === 'insomnia'}
                class:grpc={opt.icon === 'grpc'}
                class:mcp={opt.icon === 'mcp'}
                class:bruno={opt.icon === 'bruno'}
                aria-hidden="true"
              >
                {#if opt.icon === 'bruno'}
                  <svg width="1.375rem" height="1.375rem" viewBox="0 0 18 18" fill="none">
                    <path d="M4.2 3.5h6.6l3 3v8H4.2v-11z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>
                    <path d="M10.8 3.6v3h3M6.6 9h4.8M6.6 11.4h4.8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {:else if opt.icon === 'postman'}
                  <svg width="1.375rem" height="1.375rem" viewBox="0 0 18 18" fill="none">
                    <circle cx="9" cy="9" r="6.4" stroke="currentColor" stroke-width="1.35"/>
                    <path d="M5.2 9.4l7.4-4-2.4 7.8-1.4-3.1-3.6-.7z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
                  </svg>
                {:else if opt.icon === 'insomnia'}
                  <svg width="1.375rem" height="1.375rem" viewBox="0 0 18 18" fill="none">
                    <path d="M12.8 12.7A5.6 5.6 0 016 5.1a5.7 5.7 0 106.8 7.6z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>
                    <path d="M7.3 8.9h4.5M9.5 6.7v4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
                  </svg>
                {:else if opt.icon === 'openapi'}
                  <svg width="1.375rem" height="1.375rem" viewBox="0 0 18 18" fill="none">
                    <circle cx="5" cy="5" r="2" stroke="currentColor" stroke-width="1.35"/>
                    <circle cx="13" cy="5" r="2" stroke="currentColor" stroke-width="1.35"/>
                    <circle cx="9" cy="13" r="2" stroke="currentColor" stroke-width="1.35"/>
                    <path d="M6.7 6.4l1.6 4M11.3 6.4l-1.6 4M7 5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
                  </svg>
                {:else if opt.icon === 'har'}
                  <svg width="1.375rem" height="1.375rem" viewBox="0 0 18 18" fill="none">
                    <path d="M3.2 4.2h11.6v9.6H3.2V4.2z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>
                    <path d="M3.4 6.8h11.2M5.4 10h5.8M5.4 12h3.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
                  </svg>
                {:else if opt.icon === 'httpfile'}
                  <svg width="1.375rem" height="1.375rem" viewBox="0 0 18 18" fill="none">
                    <path d="M4.4 2.7h5.4l3.8 3.8v8.8H4.4V2.7z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>
                    <path d="M9.6 2.8v3.8h3.8" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
                    <path d="M6.4 9.4h2.1M6.4 11.6h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
                    <path d="M10.2 8.6l1.5 1.4-1.5 1.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {:else if opt.icon === 'ws'}
                  <svg width="1.375rem" height="1.375rem" viewBox="0 0 18 18" fill="none">
                    <path d="M6 3.4v3M12 3.4v3M4.6 6.4h8.8v2.1a4.4 4.4 0 01-8.8 0V6.4zM9 12.9v1.7M6.5 14.6h5" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {:else if opt.icon === 'graphql'}
                  <svg width="1.375rem" height="1.375rem" viewBox="0 0 18 18" fill="none">
                    <path d="M9 2.7l5.2 3v6L9 14.8l-5.2-3.1v-6L9 2.7z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
                    <circle cx="9" cy="2.7" r="1.25" fill="currentColor"/>
                    <circle cx="14.2" cy="5.7" r="1.25" fill="currentColor"/>
                    <circle cx="14.2" cy="11.7" r="1.25" fill="currentColor"/>
                    <circle cx="9" cy="14.8" r="1.25" fill="currentColor"/>
                    <circle cx="3.8" cy="11.7" r="1.25" fill="currentColor"/>
                    <circle cx="3.8" cy="5.7" r="1.25" fill="currentColor"/>
                  </svg>
                {:else if opt.icon === 'sio'}
                  <svg width="1.375rem" height="1.375rem" viewBox="0 0 18 18" fill="none">
                    <circle cx="9" cy="9" r="6.5" stroke="currentColor" stroke-width="1.4"/>
                    <path d="M9 4.5C6.5 7 7 11 9.5 13.5M9 13.5C11.5 11 11 7 8.5 4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                  </svg>
                {:else if opt.icon === 'grpc'}
                  <svg width="1.375rem" height="1.375rem" viewBox="0 0 18 18" fill="none">
                    <path d="M3.2 9h4.1M10.7 9h4.1M7.3 5.2l3.4 7.6M10.7 5.2l-3.4 7.6" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>
                    <circle cx="3.2" cy="9" r="1.4" stroke="currentColor" stroke-width="1.25"/>
                    <circle cx="14.8" cy="9" r="1.4" stroke="currentColor" stroke-width="1.25"/>
                    <circle cx="7.3" cy="5.2" r="1.35" fill="currentColor"/>
                    <circle cx="10.7" cy="12.8" r="1.35" fill="currentColor"/>
                  </svg>
                {:else if opt.icon === 'mcp'}
                  <svg width="1.375rem" height="1.375rem" viewBox="0 0 18 18" fill="none">
                    <path d="M2.8 12.4l5-5a1.9 1.9 0 012.7 0 1.9 1.9 0 010 2.7l-3.1 3.1" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M7.5 7.4a1.9 1.9 0 012.7 0l2.3 2.3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M10.2 4.7a1.9 1.9 0 012.7 0l2.3 2.3a1.9 1.9 0 010 2.7l-3.6 3.6" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {:else}
                  <svg width="1.375rem" height="1.375rem" viewBox="0 0 18 18" fill="none">
                    <path d="M3.2 5.8h9.6M10.4 3.5l2.4 2.3-2.4 2.3M14.8 12.2H5.2M7.6 9.9l-2.4 2.3 2.4 2.3" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {/if}
              </span>
              {/if}
              <span class="dialog-choice-copy">
                <strong>{opt.label}</strong>
                {#if opt.description}<small>{opt.description}</small>{/if}
              </span>
              <span class="dialog-choice-check">{inputValue === opt.value ? '✓' : ''}</span>
            </button>
          {/each}
        </div>
      {:else}
        <div class="dialog-select" class:open={selectOpen}>
          <button
            class="field select-trigger dialog-select-trigger"
            type="button"
            aria-haspopup="listbox"
            aria-expanded={selectOpen}
            onclick={() => (selectOpen = !selectOpen)}
            onkeydown={onSelectKeydown}
          >
            <span>{selectLabel()}</span>
            <svg width="0.625rem" height="0.4375rem" viewBox="0 0 10 7" fill="none" aria-hidden="true">
              <path d="M1.5 2L5 5.5L8.5 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
          {#if selectOpen}
            <div class="menu dialog-select-menu" role="listbox">
              {#each dialog.options as opt, eachIndex (eachIndex)}
                <button class="menu-item"
                  class:active={inputValue === opt.value}
                  class:disabled={opt.disabled}
                  role="option"
                  aria-selected={inputValue === opt.value}
                  aria-disabled={opt.disabled}
                  disabled={opt.disabled}
                  type="button"
                  onclick={() => onChooseOption(opt.value)}
                >
                  <span class="dialog-select-check">{inputValue === opt.value ? '✓' : ''}</span>
                  <span>{opt.label}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/if}
    <div class="modal-foot dialog-actions">
      {#if dialog.mode === 'unsaved'}
        <button class="btn btn-secondary btn-lg" type="button" onclick={onCancel}>{dialog.cancelLabel}</button>
        <button class="btn btn-secondary btn-lg" type="button" onclick={onAlt}>{dialog.altLabel}</button>
        <button class="btn btn-primary btn-lg" type="button" onclick={onSubmit}>{dialog.confirmLabel}</button>
      {:else}
        {#if dialog.mode !== 'alert'}
          <button class="btn btn-secondary btn-lg" type="button" onclick={onCancel}>{dialog.cancelLabel}</button>
        {/if}
        <button class="btn btn-primary btn-lg" class:btn-danger={dialog.danger} type="button" onclick={dialog.mode === 'alert' ? onDismiss : onSubmit}>{dialog.confirmLabel}</button>
      {/if}
    </div>
  </div>
</div>
