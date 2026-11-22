<script lang="ts">
  import VariableInput from './VariableInput.svelte';
  import { isVariableReferenceOnly, isWorkspaceSecretReference, type VariableSuggestion } from '../variables';

  let {
    value = $bindable(), id, className, placeholder = '', suggestions = [],
    visible = false, multiline = false, disabled = false, oninput,
  }: {
    value?: string;
    id?: string;
    className: string;
    placeholder?: string;
    suggestions?: VariableSuggestion[];
    visible?: boolean;
    multiline?: boolean;
    disabled?: boolean;
    oninput?: () => void;
  } = $props();

  let missing = $derived(isWorkspaceSecretReference(value));
  let hint = $derived(missing ? 'Secret unavailable on this device' : placeholder);
  let displayValue = $derived(missing ? '' : value ?? '');
  let field: HTMLDivElement;

  function edit(next: string) {
    if (next || !missing) value = next;
  }

  function clear() {
    value = '';
    oninput?.();
    field.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')?.focus();
  }
</script>

<div class="secret-input" class:missing bind:this={field}>
  {#if multiline}
    <textarea {id} class={className} bind:value={() => displayValue, edit} placeholder={hint} {disabled} spellcheck="false" {oninput}></textarea>
  {:else}
    <VariableInput {id} {className} bind:value={() => displayValue, edit} placeholder={hint} {suggestions}
      type={visible || isVariableReferenceOnly(displayValue) ? 'text' : 'password'} {disabled} {oninput} />
  {/if}
  {#if missing}
    <button type="button" class="btn btn-secondary btn-xs" {disabled} onclick={clear} aria-label="Clear missing secret reference">Clear</button>
  {/if}
</div>

<style>
  .secret-input {
    display: contents;
  }

  .secret-input.missing {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    flex: 1;
  }

  .missing > :global(.variable-input-wrap),
  .missing > textarea {
    flex: 1;
    min-width: 0;
  }
</style>
