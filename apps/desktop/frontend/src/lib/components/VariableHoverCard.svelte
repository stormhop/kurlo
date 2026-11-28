<script lang="ts">
  import type { VariableSuggestion } from '../variables';
  import { dynamicVariableDescription, variableDisplayValue, variableSourceLabel } from '../variables';
  import { isDynamicVariableName, resolveDynamicVariable } from '../dynamicVariables';
  import { variableEditor } from '../variableEditor';
  import { tick } from 'svelte';

  let {
    variableKey,
    suggestion = undefined,
    ondirty = undefined,
  }: {
    variableKey: string;
    suggestion?: VariableSuggestion;
    ondirty?: (dirty: boolean) => void;
  } = $props();

  const NEW_VARIABLE_KEY = /^[^\s{}]+$/u;
  const editableValue = (candidate: VariableSuggestion | undefined) => (candidate?.source && !candidate.source.readonly && !candidate.linked ? candidate.value : '');

  let draft = $state('');
  let saved = $state<'' | 'Saved' | 'Removed' | 'Not saved'>('');
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  let shownKey = '';

  $effect.pre(() => {
    if (variableKey === shownKey) return;
    shownKey = variableKey;
    saved = '';
    draft = editableValue(suggestion);
  });

  const isDynamic = $derived(!suggestion && isDynamicVariableName(variableKey));
  const editor = variableEditor();
  const editable = $derived(Boolean(editor && suggestion?.source && !suggestion.source.readonly && !suggestion.linked));
  const addTarget = $derived(editor && !suggestion && !isDynamic && NEW_VARIABLE_KEY.test(variableKey) ? editor.addTarget() : null);
  const isDirty = $derived(editable ? draft !== (suggestion?.value ?? '') : draft !== '');
  const removes = $derived(editable && draft === '');

  $effect(() => { ondirty?.(isDirty); });
  $effect(() => () => clearTimeout(savedTimer));

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!editor) return;
    let outcome: 'Saved' | 'Removed';
    let done: boolean | void;
    if (editable && suggestion?.source && removes) {
      done = await editor.remove(variableKey, suggestion.source);
      outcome = 'Removed';
    } else if (!isDirty) {
      return;
    } else if (editable && suggestion?.source) {
      done = await editor.save(variableKey, draft, suggestion.source);
      outcome = 'Saved';
    } else if (addTarget) {
      done = await editor.save(variableKey, draft, addTarget);
      outcome = 'Saved';
    } else {
      return;
    }
    await tick();
    clearTimeout(savedTimer);
    if (done === false) {
      saved = 'Not saved';
      return;
    }
    saved = outcome;
    savedTimer = setTimeout(() => (saved = ''), 1600);
    draft = editableValue(suggestion);
  }
</script>

<div class="var-popover-head">
  <code class="var-popover-key">{`{{${variableKey}}}`}</code>
  <span class="var-popover-source" class:missing={!suggestion && !isDynamic}>
    {#if suggestion?.source}{variableSourceLabel(suggestion.source)}{:else if suggestion}{suggestion.description || 'Defined'}{:else if isDynamic}Dynamic{:else}Not defined{/if}
  </span>
</div>
{#if isDynamic}
  <p class="var-popover-note">{dynamicVariableDescription(variableKey)}</p>
  <p class="var-popover-note">A new value is generated on every send, for example <code>{resolveDynamicVariable(variableKey)}</code>.</p>
{:else if suggestion && editable}
  <form class="var-popover-form" onsubmit={submit}>
    <input
      class="field field-input field-mono"
      type={suggestion.secret ? 'password' : 'text'}
      bind:value={draft}
      aria-label={`Value of ${variableKey}`}
      spellcheck="false"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="none"
    />
    {#if removes}
      <button class="btn btn-danger btn-sm" type="submit">Remove</button>
    {:else}
      <button class="btn btn-primary btn-sm" type="submit" disabled={!isDirty}>Save</button>
    {/if}
  </form>
  {#if saved}<p class="var-popover-note var-popover-saved" class:var-popover-failed={saved === 'Not saved'} role="status">{saved === 'Not saved' ? 'Not saved: the change could not be written.' : saved}</p>{/if}
  {#if removes}
    <p class="var-popover-note">Removes <code>{variableKey}</code> from {suggestion.source ? variableSourceLabel(suggestion.source) : 'this scope'}.</p>
  {/if}
{:else if suggestion}
  <p class="var-popover-value">{variableDisplayValue(suggestion) || 'Empty'}</p>
  {#if suggestion.linked || suggestion.source?.readonly}
    <p class="var-popover-note">Read from a secret provider. Change it in Environments.</p>
  {/if}
{:else}
  <p class="var-popover-note">No environment, collection, global or request variable has this name.</p>
  {#if saved === 'Removed'}<p class="var-popover-note var-popover-saved" role="status">Removed</p>{/if}
  {#if saved === 'Not saved'}<p class="var-popover-note var-popover-saved var-popover-failed" role="status">Not saved: the change could not be written.</p>{/if}
  {#if addTarget}
    <form class="var-popover-form" onsubmit={submit}>
      <input
        class="field field-input field-mono"
        type="text"
        bind:value={draft}
        placeholder="Value"
        aria-label={`Value of ${variableKey}`}
        spellcheck="false"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="none"
      />
      <button class="btn btn-primary btn-sm" type="submit" disabled={!isDirty}>Add to {addTarget.name}</button>
    </form>
  {/if}
{/if}
