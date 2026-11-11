<script lang="ts">
  import { NAME_MAX_LENGTH } from '../constants';
  import { tick } from 'svelte';
  import { savedMessageSummary } from '../savedMessages';
  import { vm } from '../stores/app.svelte';

  let { connected = false }: { connected?: boolean } = $props();

  let open = $state(false);
  let name = $state('');
  let wrap = $state<HTMLDivElement>();
  let trigger = $state<HTMLButtonElement>();
  let nameInput = $state<HTMLInputElement>();
  let justSaved = $state('');

  const messages = $derived(vm.savedMessages);

  async function toggle() {
    if (open) {
      open = false;
      return;
    }
    name = vm.suggestedSavedMessageName();
    justSaved = '';
    open = true;
    await tick();
    nameInput?.focus({ preventScroll: true });
    nameInput?.select();
  }

  function close(focusTrigger = false) {
    open = false;
    if (focusTrigger) trigger?.focus({ preventScroll: true });
  }

  function save(event?: SubmitEvent) {
    event?.preventDefault();
    const saved = vm.saveCurrentMessage(name);
    if (!saved) return;
    justSaved = saved.id;
    name = vm.suggestedSavedMessageName();
  }

  function load(id: string) {
    vm.loadSavedMessage(id);
    close(true);
  }

  function send(id: string) {
    void vm.sendSavedMessage(id);
  }

  function remove(id: string) {
    vm.deleteSavedMessage(id);
    if (justSaved === id) justSaved = '';
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }

  function closeOnFocusOut(event: FocusEvent) {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || wrap?.contains(next)) return;
    open = false;
  }

  function closeOnPointerOutside(event: PointerEvent) {
    if (event.target instanceof Node && wrap?.contains(event.target)) return;
    open = false;
  }

  $effect(() => {
    if (!open) return;
    document.addEventListener('pointerdown', closeOnPointerOutside, true);
    return () => document.removeEventListener('pointerdown', closeOnPointerOutside, true);
  });
</script>

<div class="saved-messages" bind:this={wrap} onfocusout={closeOnFocusOut}>
  <button
    bind:this={trigger}
    class="btn btn-secondary btn-sm toolbar-btn saved-messages-trigger"
    type="button"
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label={messages.length ? `Saved messages, ${messages.length}` : 'Saved messages'}
    onclick={toggle}
  >
    <svg width="0.75rem" height="0.75rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <path d="M3.5 1.5h6a1 1 0 011 1v9l-4-2.2-4 2.2v-9a1 1 0 011-1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    </svg>
    Saved
    {#if messages.length}<span class="badge">{messages.length}</span>{/if}
  </button>

  {#if open}
    <div class="saved-messages-menu" role="dialog" aria-label="Saved messages" tabindex="-1" onkeydown={onKeydown}>
      <form class="saved-messages-form" onsubmit={save}>
        <input
          bind:this={nameInput}
          bind:value={name}
          class="field field-sm saved-messages-name"
          maxlength={NAME_MAX_LENGTH}
          aria-label="Saved message name"
          placeholder="Message name"
          autocomplete="off"
          spellcheck="false"
        />
        <button class="btn btn-primary btn-sm" type="submit" disabled={!name.trim()}>Save current</button>
      </form>

      {#if messages.length}
        <ul class="saved-messages-list" aria-label="Saved messages list">
          {#each messages as message (message.id)}
            <li class="saved-messages-item" class:just-saved={justSaved === message.id}>
              <button class="saved-messages-load" type="button" aria-label={`Load ${message.name}`} onclick={() => load(message.id)}>
                <span class="saved-messages-item-name">{message.name}</span>
                <span class="saved-messages-item-hint">{savedMessageSummary(message, vm.requestType)}</span>
              </button>
              <button class="btn btn-ghost btn-icon btn-xs" type="button" aria-label={`Send ${message.name}`} disabled={!connected} onclick={() => send(message.id)}>
                <svg width="0.75rem" height="0.75rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                  <path d="M1.5 6.5l10-4.5-3.5 10-2-4-4.5-1.5z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
                </svg>
              </button>
              <button class="btn btn-ghost btn-icon btn-xs" type="button" aria-label={`Delete ${message.name}`} onclick={() => remove(message.id)}>
                <svg width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="saved-messages-empty">Save the message in the editor to send it again later. Saved messages are kept with the request.</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .saved-messages {
    position: relative;
    flex-shrink: 0;
  }
  .saved-messages-trigger {
    gap: var(--space-1);
  }
  .saved-messages-menu {
    box-sizing: border-box;
    position: absolute;
    z-index: 30;
    top: calc(100% + var(--space-1));
    right: 0;
    width: min(22rem, calc(100vw - 2rem));
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
    padding: var(--space-1-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    box-shadow: var(--shadow-popover);
  }
  .saved-messages-form {
    display: flex;
    gap: var(--space-1-5);
  }
  .saved-messages-name {
    flex: 1 1 auto;
    min-width: 0;
  }
  .saved-messages-list {
    display: flex;
    flex-direction: column;
    max-height: 17.5rem;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }
  .saved-messages-item {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: var(--space-0-5);
    border-radius: var(--radius-sm);
  }
  .saved-messages-item:hover,
  .saved-messages-item:focus-within {
    background: var(--hover);
  }
  .saved-messages-item.just-saved .saved-messages-item-name {
    color: var(--accent-text);
  }
  .saved-messages-load {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: var(--space-0-5);
    min-width: 0;
    padding: var(--space-1-5) var(--space-2);
    border: 0;
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }
  .saved-messages-item-name,
  .saved-messages-item-hint {
    min-width: 0;
    overflow: clip;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .saved-messages-item-name {
    font-size: var(--text-label);
  }
  .saved-messages-item-hint {
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
  }
  .saved-messages-empty {
    margin: 0;
    padding: var(--space-1-5) var(--space-2);
    color: var(--text-2);
    font-size: var(--text-label);
  }
</style>
